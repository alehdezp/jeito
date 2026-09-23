#!/usr/bin/env node

import { getLlama } from "node-llama-cpp";

let llama;
try {
  llama = await getLlama({ build: "never", gpu: "auto", skipDownload: true, progressLogs: false });
  console.log(JSON.stringify({ ok: true, gpu: llama.gpu, downloads: false, nativeBuild: false }));
} catch (error) {
  console.error(`[jeito-codeweave-pi:qmd-runtime] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await llama?.dispose();
}
