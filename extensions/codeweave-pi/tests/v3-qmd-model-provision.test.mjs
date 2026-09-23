import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { provisionQmdModels, REQUIRED_QMD_MODELS } from "../scripts/qmd-model-provision.mjs";
import { pullModels, setNodeLlamaCppModuleForTest } from "../native/qmd/runtime/llm.js";

function fakeLlmFactory(loads) {
  return config => ({
    async embed() { loads.push(["embedding", config]); return { embedding: [1, 0, 0], model: "fake-embed" }; },
    async rerank(_query, documents) { loads.push(["reranker", config]); return { model: "fake-reranker", results: documents.map((document, index) => ({ file: document.file, index, score: 1 - index * 0.5 })) }; },
    async dispose() {},
  });
}

test("QMD model provisioning installs only embedding and reranker GGUF files and verifies cached loads", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "codeweave-pi-qmd-models-"));
  const pulls = [];
  const loads = [];
  const pull = async ([uri], options) => {
    pulls.push(uri);
    const file = path.join(options.cacheDir, `download-${uri.split("/").pop()}`);
    await writeFile(file, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(64)]));
    return [{ model: uri, path: file, sizeBytes: 68, refreshed: false }];
  };

  const installed = await provisionQmdModels({ cacheDir, pull, createLlm: fakeLlmFactory(loads) });
  assert.deepEqual(pulls, REQUIRED_QMD_MODELS.map(model => model.uri));
  assert.deepEqual(installed.models.map(model => model.role), ["embedding", "reranker"]);
  assert.equal(installed.models.some(model => /query-expansion/i.test(model.uri)), false);
  assert.deepEqual(loads.map(([role]) => role), ["embedding", "reranker"]);
  assert.ok(loads.every(([, config]) => config.modelCacheDir === cacheDir && config.allowModelDownloads === false));
  assert.ok(loads.every(([, config]) => config.embedModel === REQUIRED_QMD_MODELS[0].uri && config.rerankModel === REQUIRED_QMD_MODELS[1].uri));
  assert.deepEqual(installed.verification, { embeddingDimensions: 3, rerankedDocuments: 2 });

  pulls.length = 0;
  const verified = await provisionQmdModels({ cacheDir, verifyOnly: true, pull, createLlm: fakeLlmFactory([]) });
  assert.equal(pulls.length, 0);
  assert.equal(verified.models.every(model => existsSync(model.path)), true);
});

test("QMD verify-only provisioning fails when either required model is absent", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "codeweave-pi-qmd-models-missing-"));
  await assert.rejects(
    provisionQmdModels({ cacheDir, verifyOnly: true, createLlm: fakeLlmFactory([]) }),
    /embedding model is not installed/,
  );
});

test("QMD downloader suppresses CLI progress outside terminals while preserving the target cache", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "codeweave-pi-qmd-download-options-"));
  let received;
  setNodeLlamaCppModuleForTest({
    async resolveModelFile(_model, options) {
      received = options;
      const file = path.join(options.directory, "test.gguf");
      await writeFile(file, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(64)]));
      return file;
    },
  });
  try {
    const result = await pullModels(["test.gguf"], { cacheDir });
    assert.equal(result.length, 1);
    assert.deepEqual(received, { directory: cacheDir, cli: false });
  } finally {
    setNodeLlamaCppModuleForTest(null);
  }
});
