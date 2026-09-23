import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { callTool, registerCleanPi, tempProject } from "./_clean-navigation-helper.mjs";

test("missing prepared relationship data uses bundled pi-nav and ignores obsolete Tilth configuration", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-status-copy-clean-");
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ tilth: { enabled: false } }));
  const text = await callTool(pi, cwd, "trace", { target: "missingSymbol", relation: "callers", scope: cwd, limit: 3 });
  assert.match(text, /# Callers of "missingSymbol".*no call sites found/);
  // Honest native absence: what was scanned, and what that cannot rule out.
  assert.match(text, /No occurrence of "missingSymbol" was found in scanned files/);
  assert.match(text, /Skipped, unreadable or out-of-scope sources are not ruled out/);
  assert.doesNotMatch(text, /does not appear anywhere in scope/);
  assert.doesNotMatch(text, /ENOENT|stack trace|undefined|grep\(|find\(/i);
});

test("missing docs data uses backend-opaque status text", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-status-copy-docs-");
  const text = await callTool(pi, cwd, "docs_search", { query: "missing", scope: cwd });
  assert.match(text, /UNAVAILABLE: Docs search is not enabled/);
  assert.doesNotMatch(text, /grep|find|fallback result/i);
});

test("docs config with an obsolete query command fails closed because query-time must not install", async () => {
  const pi = registerCleanPi();
  const cwd = await tempProject("pi-status-copy-docs-command-");
  await mkdir(join(cwd, ".pi", "navigation", "qmd"), { recursive: true });
  await writeFile(join(cwd, ".pi-navigation.json"), JSON.stringify({ docs: { enabled: true, backend: "qmd", repo: "local/docs", queryCommand: "uvx --with provider obsolete-docs-command", queryTransport: "stdio", root: ".", indexPath: ".pi/navigation/qmd/index.sqlite" } }));

  const text = await callTool(pi, cwd, "docs_search", { query: "guide", scope: cwd });

  assert.match(text, /UNAVAILABLE:/);
  assert.match(text, /obsolete docs query command\/transport|query-time/i);
});
