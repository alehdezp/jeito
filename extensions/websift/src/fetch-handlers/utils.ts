// Ported-at: 7bdc30a65cf7 from pi-web-access@0.13.0 utils.ts — see docs/upstreams/pi-web-access.md.
// Exec/timeout helpers shared by the subprocess-backed handlers (yt-dlp, git, gh).
// The config-path helpers are intentionally omitted: this project configures via web.yaml, not web-search.json.

export function formatSeconds(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function readExecError(err: unknown): { code?: string; stderr: string; message: string } {
  if (!err || typeof err !== "object") return { stderr: "", message: String(err) };
  const code = (err as { code?: string }).code;
  const message = (err as { message?: string }).message ?? "";
  const stderrRaw = (err as { stderr?: Buffer | string }).stderr;
  const stderr = Buffer.isBuffer(stderrRaw) ? stderrRaw.toString("utf-8") : typeof stderrRaw === "string" ? stderrRaw : "";
  return { code, stderr, message };
}

export function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if ((err as { killed?: boolean }).killed) return true;
  const name = (err as { name?: string }).name;
  const code = (err as { code?: string }).code;
  const message = (err as { message?: string }).message ?? "";
  return name === "AbortError" || code === "ETIMEDOUT" || message.toLowerCase().includes("timed out");
}