#!/usr/bin/env node
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_EMBED_MODEL_URI,
  DEFAULT_MODEL_CACHE_DIR,
  DEFAULT_RERANK_MODEL_URI,
  inspectGgufFile,
  LlamaCpp,
  pullModels,
} from "../native/qmd/runtime/llm.js";

export const REQUIRED_QMD_MODELS = [
  { role: "embedding", uri: DEFAULT_EMBED_MODEL_URI },
  { role: "reranker", uri: DEFAULT_RERANK_MODEL_URI },
];

export async function provisionQmdModels(options = {}) {
  const cacheDir = path.resolve(options.cacheDir ?? DEFAULT_MODEL_CACHE_DIR);
  const inspect = options.inspect ?? inspectGgufFile;
  const pull = options.pull ?? pullModels;
  const models = [];

  for (const required of REQUIRED_QMD_MODELS) {
    let cached = cachedModel(required.uri, cacheDir, inspect);
    if (!cached && options.verifyOnly !== true) {
      removeInvalidCandidates(required.uri, cacheDir, inspect);
      await pull([required.uri], { cacheDir });
      cached = cachedModel(required.uri, cacheDir, inspect);
    }
    if (!cached) throw new Error(`${required.role} model is not installed or is not valid GGUF: ${required.uri}`);
    models.push({ role: required.role, uri: required.uri, path: cached.path, sizeBytes: cached.sizeBytes });
  }

  const verification = await verifyModelInference(cacheDir, options.createLlm ?? (config => new LlamaCpp(config)));
  return { status: "installed", cacheDir, models, verification };
}

function cachedModel(uri, cacheDir, inspect) {
  const filename = uri.split("/").pop();
  if (!filename || !existsSync(cacheDir)) return undefined;
  for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.includes(filename)) continue;
    const candidate = path.join(cacheDir, entry.name);
    const result = inspect(candidate);
    if (result.valid) return { path: candidate, sizeBytes: result.sizeBytes ?? 0 };
  }
  return undefined;
}

function removeInvalidCandidates(uri, cacheDir, inspect) {
  const filename = uri.split("/").pop();
  if (!filename || !existsSync(cacheDir)) return;
  for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.includes(filename)) continue;
    const candidate = path.join(cacheDir, entry.name);
    if (!inspect(candidate).valid) unlinkSync(candidate);
  }
}

async function verifyModelInference(cacheDir, createLlm) {
  const priorCi = process.env.CI;
  delete process.env.CI;
  try {
    const embed = createLlm({ modelCacheDir: cacheDir, allowModelDownloads: false, embedModel: DEFAULT_EMBED_MODEL_URI, rerankModel: DEFAULT_RERANK_MODEL_URI });
    let embedding;
    try {
      embedding = await embed.embed("jeito codeweave-pi semantic navigation");
      if (!embedding?.embedding?.length || !embedding.embedding.every(Number.isFinite)) throw new Error("QMD embedding model produced no valid vector");
    } finally {
      await embed.dispose();
    }
    const reranker = createLlm({ modelCacheDir: cacheDir, allowModelDownloads: false, embedModel: DEFAULT_EMBED_MODEL_URI, rerankModel: DEFAULT_RERANK_MODEL_URI });
    let ranked;
    try {
      ranked = await reranker.rerank("semantic navigation", [
        { file: "relevant.md", text: "Semantic navigation retrieves relevant project evidence." },
        { file: "unrelated.md", text: "Bananas grow in tropical climates." },
      ]);
      if (ranked?.results?.length !== 2 || !ranked.results.every(result => Number.isFinite(result.score))) throw new Error("QMD reranker produced no valid scores");
    } finally {
      await reranker.dispose();
    }
    return { embeddingDimensions: embedding.embedding.length, rerankedDocuments: ranked.results.length };
  } finally {
    if (priorCi === undefined) delete process.env.CI;
    else process.env.CI = priorCi;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = new Set(process.argv.slice(2));
    if ([...args].some(arg => !["--json", "--verify-only"].includes(arg))) throw new Error(`Unknown QMD model provisioning argument: ${[...args].join(" ")}`);
    const report = await provisionQmdModels({ verifyOnly: args.has("--verify-only") });
    console.log(JSON.stringify({ ok: true, ...report }));
  } catch (error) {
    console.error(`[jeito-codeweave-pi:qmd-models] ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
