// ADR-002.005: webclaw local-binary spawn layer (reviewed floor 0.6.16) — process boundary, llm-format
// parse, vertical shape registry, cache-extract keying, and the LLM lane key read.
// The npm @webclaw/sdk is cloud-only and never used. No --llm-api-key flag exists in
// 0.6.16: the OpenAI-compatible lane takes the key via OPENAI_API_KEY env.
// URL-bearing spawns require a binary inside the reviewed range
// WEBCLAW_MIN_VERSION <= v < WEBCLAW_MAX_VERSION_EXCLUSIVE (ADR-002.005 revision
// 2026-09-22): the floor keeps the SSRF review bound, the ceiling keeps fail-closed
// at the 0.x breaking boundary, and patch drift inside 0.6.x no longer blocks fetch.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getAgentDir } from "./config.ts";
import { parseGitHubUrl } from "./fetch-handlers/github.ts";
import { parseYouTubeUrl } from "./fetch-handlers/youtube.ts";
import { assertAllowedDestination, type DestinationPolicy } from "./destination-policy.ts";
import { ProviderError } from "./failures.ts";

const exec = promisify(execFile);

export const WEBCLAW_LLM_BASE_URL = "https://api.deepseek.com/v1";
export const WEBCLAW_LLM_MODEL = "deepseek-chat";
export const WEBCLAW_LLM_TIMEOUT_MS = 30_000; // llm_answer lane (owner 2026-08-08): 30s, was 120s
export const WEBCLAW_MIN_VERSION = "0.6.16";
export const WEBCLAW_MAX_VERSION_EXCLUSIVE = "0.7.0";

export function parseWebclawVersion(raw: string): string | undefined {
  return /\b(\d+\.\d+\.\d+)\b/.exec(raw)?.[1];
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((part) => Number.parseInt(part, 10));
  const pb = b.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < 3; index += 1) {
    const diff = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function webclawVersionSupported(version: string): boolean {
  return compareVersions(version, WEBCLAW_MIN_VERSION) >= 0 && compareVersions(version, WEBCLAW_MAX_VERSION_EXCLUSIVE) < 0;
}

export interface SpawnResult { ok: boolean; ms: number; stdout: string; stderr: string; code?: number | string }
export interface SpawnOptions { env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal; destination?: { url: string; policy: DestinationPolicy } }
export type SpawnWebclaw = (args: string[], opts?: SpawnOptions) => Promise<SpawnResult>;

async function defaultSpawnWebclaw(args: string[], opts: SpawnOptions = {}): Promise<SpawnResult> {
  const t0 = Date.now();
  try {
    const result = await exec("webclaw", args, { maxBuffer: 256 * 1024 * 1024, timeout: opts.timeoutMs ?? 90_000, env: { ...process.env, ...opts.env }, signal: opts.signal });
    return { ok: true, ms: Date.now() - t0, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  } catch (error: any) {
    return { ok: false, ms: Date.now() - t0, stdout: error.stdout ?? "", stderr: String(error.stderr ?? error.message ?? error).slice(0, 600), code: error.code };
  }
}

type WebclawVersionReader = () => Promise<string>;
const defaultVersionReader: WebclawVersionReader = async () => {
  try {
    const result = await exec("webclaw", ["--version"], { maxBuffer: 64 * 1024, timeout: 5_000 });
    return `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`.trim();
  } catch (error: any) {
    throw new ProviderError(
      "policy",
      `Cannot run \`webclaw --version\`: ${String(error?.message ?? error).slice(0, 200)}`,
      undefined,
      "webclaw is missing or not runnable on PATH. Install it (macOS: `brew install 0xmassi/webclaw/webclaw`; Linux/Windows: https://github.com/0xMassi/webclaw#install), confirm with `webclaw --version`, then retry this same call.",
    );
  }
};
let versionReader = defaultVersionReader;
let versionCheck: Promise<void> | undefined;

async function ensureWebclawSecurityVersion(): Promise<void> {
  versionCheck ??= versionReader()
    .then((raw) => {
      const actual = parseWebclawVersion(raw);
      if (!actual) {
        throw new ProviderError(
          "policy",
          `Cannot determine the webclaw version (expected ${WEBCLAW_MIN_VERSION} <= v < ${WEBCLAW_MAX_VERSION_EXCLUSIVE}); webclaw --version reported: ${raw.slice(0, 120) || "no output"}`,
          undefined,
          "Run `webclaw --version`; if the binary is missing or broken, install webclaw (macOS: `brew install 0xmassi/webclaw/webclaw`; other platforms: https://github.com/0xMassi/webclaw#install), then retry this same call.",
        );
      }
      if (!webclawVersionSupported(actual)) {
        throw new ProviderError(
          "policy",
          `webclaw ${actual} is outside the supported range ${WEBCLAW_MIN_VERSION} <= v < ${WEBCLAW_MAX_VERSION_EXCLUSIVE} required for redirect and DNS-rebinding protection; run \`webclaw --version\` and align the binary`,
          undefined,
          `Environment problem, not this call: put webclaw inside ${WEBCLAW_MIN_VERSION}–0.6.x (macOS: \`brew upgrade 0xmassi/webclaw/webclaw\`; pinned releases: https://github.com/0xMassi/webclaw/releases), then retry the same call unchanged. /web-doctor reports the installed version's status.`,
        );
      }
    })
    .catch((error: unknown) => {
      // A failed check must not poison the session: once the binary is aligned the
      // next call re-reads the version instead of replaying a memoized rejection.
      versionCheck = undefined;
      throw error;
    });
  return versionCheck;
}

/** Test-only version seam; production reads the binary on PATH once per process. */
export function __setWebclawVersionForTest(reader: WebclawVersionReader | undefined): void {
  versionReader = reader ?? defaultVersionReader;
  versionCheck = undefined;
}

let spawnImpl: SpawnWebclaw = defaultSpawnWebclaw;
/** Test-only hook: swap the process boundary for a fake spawn. */
export function __setWebclawSpawnForTest(spawn: SpawnWebclaw | undefined): void { spawnImpl = spawn ?? defaultSpawnWebclaw; }

export async function runWebclaw(args: string[], opts?: SpawnOptions): Promise<SpawnResult> {
  if (opts?.destination) {
    await assertAllowedDestination(opts.destination.url, opts.destination.policy);
    await ensureWebclawSecurityVersion();
  }
  return spawnImpl(args, opts);
}

export interface LlmHeader { url?: string; title?: string; description?: string; author?: string; language?: string; wordCount?: number }

/** Parse the leading "> KEY: value" block of `-f llm` output. Body-level "> " lines (tweet
 *  metadata) stay in the body — the leading block terminates at the first non-"> " line. */
export function parseLlmOutput(out: string): { header: LlmHeader; body: string } {
  const lines = out.split("\n");
  const raw: Record<string, string> = {};
  let i = 0;
  while (i < lines.length && lines[i].startsWith("> ")) {
    const match = lines[i]!.slice(2).match(/^([^:]+):\s?(.*)$/);
    if (match) raw[match[1]!.trim().toLowerCase()] = match[2]!.trim();
    i++;
  }
  const body = lines.slice(i).join("\n").replace(/^\n+/, "");
  return { header: { url: raw["url"], title: raw["title"], description: raw["description"], author: raw["author"], language: raw["language"], wordCount: raw["word count"] !== undefined ? Number(raw["word count"]) : undefined }, body };
}

/** Crawl stdout = concatenated `-f llm` pages separated by "---". Split only on a separator
 *  followed by a "> URL:" line — an in-content "---" hr never collides. */
export function splitCrawlPages(stdout: string): string[] {
  return stdout.split(/\n?---\n(?=> URL: )/).map((page) => page.trim()).filter(Boolean);
}

export interface BodyMetrics { chars: number; tokens: number; headings: number; links: number; fences: number; tables: number; textChars: number }

/** Deterministic llm-body metrics. textChars strips code fences, links, and markdown
 *  syntax; tokens = ceil(textChars / 4), matching fetch-cache's TOKEN_CHARS. */
export function bodyMetrics(body: string): BodyMetrics {
  const fences = (body.match(/```/g) ?? []).length;
  const tables = (body.match(/^\s*\|/gm) ?? []).length;
  const headings = (body.match(/^#{1,4}\s/gm) ?? []).length;
  const links = (body.match(/\[[^\]]*\]\([^)]*\)/g) ?? []).length;
  const text = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/[#|`>*-]/g, " ")
    .replace(/\s+/g, " ");
  return { chars: body.length, tokens: Math.round(text.length / 4), headings, links, fences, tables, textChars: text.length };
}

/** The 8 proven vertical shapes (13-vertical experiment, exp-verticals.ts). github_* and
 *  youtube_video are excluded: the native handlers own those shapes. Bot-walled verticals
 *  (trustpilot/amazon/instagram/linkedin/ebay/etsy) get no dispatch — they escalate. */
export interface VerticalShape { name: string; match(url: URL): boolean }
const RESERVED_HF = new Set(["datasets", "papers", "docs", "api", "models", "spaces", "collections", "blog", "enterprise", "login", "signup", "tasks", "settings"]);
export const VERTICAL_SHAPES: VerticalShape[] = [
  { name: "npm", match: (u) => u.hostname === "www.npmjs.com" && /^\/package\//.test(u.pathname) },
  { name: "pypi", match: (u) => u.hostname === "pypi.org" && /^\/project\//.test(u.pathname) },
  { name: "crates_io", match: (u) => u.hostname === "crates.io" && /^\/crates\//.test(u.pathname) },
  { name: "docker_hub", match: (u) => u.hostname === "hub.docker.com" && /^\/_\//.test(u.pathname) },
  { name: "arxiv", match: (u) => u.hostname === "arxiv.org" && /^\/abs\//.test(u.pathname) },
  { name: "huggingface_dataset", match: (u) => u.hostname === "huggingface.co" && /^\/datasets\//.test(u.pathname) },
  { name: "huggingface_model", match: (u) => u.hostname === "huggingface.co" && (() => { const segs = u.pathname.split("/").filter(Boolean); return segs.length >= 2 && !RESERVED_HF.has(segs[0]!); })() },
  { name: "stackoverflow", match: (u) => u.hostname === "stackoverflow.com" && /^\/questions\//.test(u.pathname) },
  { name: "hackernews", match: (u) => u.hostname === "news.ycombinator.com" && /^\/item/.test(u.pathname) },
];

export function verticalForUrl(raw: string): string | undefined {
  try { const url = new URL(raw); return VERTICAL_SHAPES.find((shape) => shape.match(url))?.name; } catch { return undefined; }
}

/** Deterministic cache-extract key per URL (ADR-002.005 single-format lock + native download
 *  class). The webclaw adapter's dispatch is deterministic for a URL, so this key is stable. */
export function extractForUrl(raw: string): string {
  if (verticalForUrl(raw)) return "vertical";
  try { const url = new URL(raw); if (url.pathname.toLowerCase().endsWith(".pdf")) return "native"; } catch { /* falls through */ }
  if (parseGitHubUrl(raw) || parseYouTubeUrl(raw)) return "native";
  return "llm";
}

/** The LLM lane key: auth.json -> deepseek.key, read in-process, never printed. The
 *  opencode-go account has zero credits (verified 2026-08-06), deepseek direct works.
 *  auth.json is host-owned at ~/.pi/agent/auth.json; getAgentDir() alone is not enough
 *  because XDG_CONFIG_HOME moves it to ~/.config/pi (no auth file there). */
function authJsonPath(): string {
  const candidates = [join(getAgentDir(), "auth.json"), join(homedir(), ".pi", "agent", "auth.json"), join(homedir(), ".pi", "auth.json")];
  return candidates.find((path) => existsSync(path)) ?? candidates[0]!;
}
export function readDeepseekKey(): string | undefined {
  if (llmKeyOverride !== undefined) return llmKeyOverride;
  try {
    const auth = JSON.parse(readFileSync(authJsonPath(), "utf8"));
    return typeof auth?.deepseek?.key === "string" && auth.deepseek.key ? auth.deepseek.key : undefined;
  } catch { return undefined; }
}
let llmKeyOverride: string | undefined;
/** Test-only hook: pin the LLM lane key without touching auth.json. */
export function __setLlmKeyForTest(key: string | undefined): void { llmKeyOverride = key; }
