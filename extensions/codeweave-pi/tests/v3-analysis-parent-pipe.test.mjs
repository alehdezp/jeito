import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const pipeUrl = new URL("../src/core/analysis-parent-pipe.mjs", import.meta.url).href;

test("analysis pipe permits normal exit but stops blocked analysis on disconnect, worker failure or invalid requests", {
  timeout: 15_000,
  skip: !["darwin", "linux"].includes(process.platform),
}, async () => {
  for (const mode of ["normal", "disconnect", "worker-failure", "invalid", "oversized", "additional"]) {
    const bootstrap = `await import(${JSON.stringify(pipeUrl)});
      const { parentPort } = await import('node:worker_threads');
      parentPort.once('message', () => setTimeout(() => { throw new Error('injected worker failure'); }, 50));`;
    const workerUrl = mode === "worker-failure"
      ? `data:text/javascript,${encodeURIComponent(bootstrap)}` : pipeUrl;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", `
      import { Worker } from 'node:worker_threads';
      import { writeSync } from 'node:fs';
      const worker = new Worker(new URL(${JSON.stringify(workerUrl)}), { execArgv: [] });
      worker.on('error', error => { writeSync(2, String(error)); process.exit(2); });
      worker.once('message', request => {
        if (request.token !== 'probe') process.exit(3);
        writeSync(1, 'ready');
        if (${mode === "worker-failure"}) worker.postMessage('inject');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
        process.exit(0);
      });
    `], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    child.stdout.on("data", chunk => { stdout += chunk; if (stdout.includes("ready")) resolveReady(); });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdin.on("error", () => {}); // Rejected requests may close the pipe during the write.
    const deadline = setTimeout(() => child.kill("SIGKILL"), 3000);
    try {
      child.stdin.write(mode === "invalid" ? "SHOULD_NOT_ECHO\n" : mode === "oversized"
        ? Buffer.alloc(8 * 1024 * 1024 + 1, 120) : JSON.stringify({token:"probe", ...(mode === "normal" ? {padding:"x".repeat(1024 * 1024)} : {})}) + "\n");
      if (!["invalid", "oversized"].includes(mode)) {
        await Promise.race([ready, closed.then(exit => { throw new Error(`Exited before request delivery: ${JSON.stringify(exit)} ${stderr}`); })]);
        if (mode === "disconnect" || mode === "additional") {
          await delay(50);
          if (mode === "disconnect") child.stdin.end();
          else child.stdin.write("second request\n");
        }
      }
      const exit = await closed;
      assert.deepEqual(exit, mode === "normal" ? { code: 0, signal: null } : { code: null, signal: "SIGKILL" }, mode);
      if (mode !== "normal") assert.match(stderr, /Analysis parent pipe:/, "the pipe worker, not the test deadline, must terminate analysis");
      assert(!stderr.includes("SHOULD_NOT_ECHO"));
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  }
});
