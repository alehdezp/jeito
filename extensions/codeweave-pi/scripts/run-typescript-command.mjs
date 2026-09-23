import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const tsxPath = require.resolve("tsx");
const loaderUrl = pathToFileURL(tsxPath).href;

const [target, ...rest] = process.argv.slice(2);
if (!target) {
  console.error("usage: run-typescript-command.mjs <script> [args...]");
  process.exit(1);
}

const nodeOptions = process.env.NODE_OPTIONS ?? "";
const importFlag = `--import=${loaderUrl}`;
const env = { ...process.env };
if (!nodeOptions.includes(importFlag)) {
  env.NODE_OPTIONS = nodeOptions ? `${nodeOptions} ${importFlag}` : importFlag;
}

const child = spawn(process.execPath, [target, ...rest], {
  cwd: process.cwd(),
  stdio: "inherit",
  env,
});

child.on("close", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

child.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});