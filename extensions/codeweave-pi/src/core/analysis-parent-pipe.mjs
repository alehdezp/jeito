import { writeSync } from "node:fs";
import { Socket } from "node:net";
import { isMainThread, parentPort } from "node:worker_threads";

// Worker-only stdin owner for the short-lived analysis process. A separate
// event loop must notice parent loss even while extraction/SQLite blocks main.
if (isMainThread || !parentPort) throw new Error("Analysis pipe requires a worker thread");

function terminate(reason) {
  try { writeSync(2, `Analysis parent pipe: ${reason}\n`); } catch { /* Best-effort diagnostic only. */ }
  process.kill(process.pid, "SIGKILL");
}

// A worker exception must not wait for an error handler on blocked main.
process.on("uncaughtException", () => terminate("worker failure"));
process.on("unhandledRejection", () => terminate("worker failure"));
parentPort.on("messageerror", () => terminate("message failure"));

// One bounded JSON request, shared with runCapturedAnalysis and the native reader.
const maximumRequestBytes = 8 * 1024 * 1024;
let chunks = [], bytes = 0;
let delivered = false;
const socket = new Socket({ fd: 0, readable: true, writable: false });
socket.on("error", () => terminate("pipe failure"));
socket.on("end", () => terminate("parent disconnected"));
socket.on("close", () => terminate("pipe closed"));
socket.on("data", chunk => {
  if (delivered) return terminate("unexpected additional request");
  bytes += chunk.length;
  if (bytes > maximumRequestBytes) return terminate("request exceeds limit");
  chunks.push(chunk);
  const newline = chunk.indexOf(10);
  if (newline < 0) return;
  if (newline !== chunk.length - 1) return terminate("unexpected additional request");
  let request;
  try { request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes).subarray(0, bytes - 1))); }
  catch { return terminate("invalid JSON request"); }
  delivered = true;
  chunks = []; bytes = 0;
  parentPort.postMessage(request);
});
