import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { scheduleQmdDocsRefresh, shutdownQmdDocsRefreshes } from "../src/core/qmd-docs-refresh.ts";

test("QMD refresh coalesces immediate same-root Markdown paths and drains at shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "qmd-refresh-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "one.md"), "# One\n\nfirst marker\n");
  await writeFile(join(root, "docs", "two.md"), "# Two\n\nsecond marker\n");
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({
    docs: { enabled: true, backend: "qmd", repo: "local/test-docs", root: ".", indexPath: ".pi/navigation/qmd" },
  }));

  const env = { ZEROENTROPY_API_KEY: undefined };
  const first = scheduleQmdDocsRefresh({ cwd: root, paths: ["docs/one.md"], trigger: "edit", env });
  const second = scheduleQmdDocsRefresh({ cwd: root, paths: ["docs/two.md"], trigger: "write", env });
  assert.equal(first.scheduled, 1);
  assert.equal(second.scheduled, 1);
  await shutdownQmdDocsRefreshes();

  const state = JSON.parse(await readFile(join(root, ".pi", "navigation", "state.json"), "utf8"));
  assert.equal(state.indexes.docs.qmd.changed, 2);
  assert.equal(state.indexes.docs.qmd.files, 2);
  assert.equal(state.indexes.docs.generationId, state.indexes.docs.qmd.generation);
});

test("lexical QMD mutation refresh never upgrades itself into provider work", async () => {
  const root = await mkdtemp(join(tmpdir(), "qmd-refresh-lexical-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, ".pi", "navigation"), { recursive: true });
  await writeFile(join(root, "docs", "one.md"), "# One\n\nlexical marker\n");
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({
    docs: { enabled: true, backend: "qmd", repo: "local/test-docs", root: ".", indexPath: ".pi/navigation/qmd" },
  }));
  await writeFile(join(root, ".pi", "navigation", "state.json"), JSON.stringify({
    indexes: { docs: { qmd: { semantic: { status: "unavailable", reason: "provider_not_configured" } } } },
  }));
  let providerCalls = 0;
  const result = scheduleQmdDocsRefresh({
    cwd: root,
    paths: ["docs/one.md"],
    trigger: "edit",
    env: { ZEROENTROPY_API_KEY: "configured" },
    zeroEntropyFetch: async () => { providerCalls += 1; throw new Error("must not be called"); },
  });
  assert.equal(result.scheduled, 1);
  await shutdownQmdDocsRefreshes();
  assert.equal(providerCalls, 0);
  const state = JSON.parse(await readFile(join(root, ".pi", "navigation", "state.json"), "utf8"));
  assert.equal(state.indexes.docs.qmd.status, "lexical_ready");
  assert.equal(state.indexes.docs.qmd.semantic.status, "unavailable");
});

test("docs-subfolder mutation refresh retains the owning project's exclusions", async () => {
  const root = await mkdtemp(join(tmpdir(), "qmd-refresh-owner-policy-"));
  await mkdir(join(root, "docs", "private"), { recursive: true });
  await writeFile(join(root, "docs", "public.md"), "# Public\n\nAdmitted explanation.\n");
  await writeFile(join(root, "docs", "private", "secret.md"), "# Private\n\nExcludedMutationSentinel\n");
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({
    scope: { exclude: ["docs/private"] },
    docs: { enabled: true, backend: "qmd", repo: "local/owner-policy", root: "docs", indexPath: ".pi/navigation/qmd" },
  }));
  const result = scheduleQmdDocsRefresh({ cwd: root, paths: ["docs/public.md", "docs/private/secret.md"], trigger: "edit", env: { ZEROENTROPY_API_KEY: undefined } });
  assert.equal(result.scheduled, 2);
  await shutdownQmdDocsRefreshes();
  const state = JSON.parse(await readFile(join(root, ".pi", "navigation", "state.json"), "utf8"));
  assert.equal(state.indexes.docs.qmd.status, "lexical_ready");
  assert.equal(state.indexes.docs.qmd.files, 1, "explicit paths do not bypass owner-project admission");
});

test("QMD refresh ignores non-Markdown mutation paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "qmd-refresh-skip-"));
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({ docs: { enabled: true, backend: "qmd", repo: "local/test-docs", root: ".", indexPath: ".pi/navigation/qmd" } }));
  const result = scheduleQmdDocsRefresh({ cwd: root, paths: ["notes.txt"], trigger: "write", env: { ZEROENTROPY_API_KEY: undefined } });
  assert.equal(result.scheduled, 0);
  assert.equal(result.skipped, 1);
  assert.match(result.reason, /no indexable docs changed/);
});

test("mutation refresh waits for lifecycle migration instead of writing through obsolete config", async () => {
  const root = await mkdtemp(join(tmpdir(), "qmd-refresh-obsolete-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "guide.md"), "# Guide\n");
  await writeFile(join(root, ".pi-navigation.json"), JSON.stringify({
    docs: { enabled: true, backend: "jDocMunch", repo: "local/legacy", root: ".", indexPath: ".pi/navigation/jdocmunch/native", queryCommand: "/obsolete" },
  }));

  const result = scheduleQmdDocsRefresh({ cwd: root, paths: ["docs/guide.md"], trigger: "edit", env: { ZEROENTROPY_API_KEY: undefined } });
  assert.equal(result.scheduled, 0);
  assert.equal(result.skipped, 1);
  assert.match(result.reason, /awaits QMD lifecycle migration/);
  assert.equal(existsSync(join(root, ".pi", "navigation", "jdocmunch", "native")), false);
  assert.equal(existsSync(join(root, ".pi", "navigation", "qmd")), false);
});
