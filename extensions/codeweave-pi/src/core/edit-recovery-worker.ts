import { parentPort, workerData } from "node:worker_threads";
import { recoverEdit, type RecoveryRequest } from "./edit-recovery.ts";

const input = workerData as Omit<RecoveryRequest, "authorizedLines" | "signal" | "now"> & { authorizedLines: number[] };
const result = recoverEdit({ ...input, authorizedLines: new Set(input.authorizedLines) });
parentPort?.postMessage(result.ok ? { ...result, authorizedAfterLines: [...result.authorizedAfterLines] } : result);
