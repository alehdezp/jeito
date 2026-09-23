import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Verifies the SQLite runtime path that QMD depends on actually works — not
// just that config/metadata is valid. Catches packaging gaps where
// better-sqlite3's native binary is missing (e.g. --ignore-scripts skips it).
test("qmd sqlite runtime opens a database and loads sqlite-vec", async () => {
  const { openDatabase, loadSqliteVec } = await import("../native/qmd/runtime/db.js");
  const db = openDatabase(":memory:");
  assert.ok(db, "database should open");
  loadSqliteVec(db);
  db.close();
});

test("QMD read-only local inference resolves cached GGUF models without downloads", async () => {
  const cache = await mkdtemp(join(tmpdir(), "qmd-model-cache-"));
  const model = "hf:example/local-model.gguf";
  const cached = join(cache, "hf_example_local-model.gguf");
  await mkdir(cache, { recursive: true });
  await writeFile(cached, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(64)]));
  const { LlamaCpp } = await import("../native/qmd/runtime/llm.js");
  const llm = new LlamaCpp({ modelCacheDir: cache, allowModelDownloads: false });
  assert.equal(await llm.resolveModel(model), cached);
  await assert.rejects(() => llm.resolveModel("hf:example/missing.gguf"), /not cached for read-only inference/);
  await llm.dispose();
});
