// ADR-002.003 + ADR-002.005: pi-nav smart-read source views for web smart views.
// Single source of truth: Rust outline::generate via NAPI (extensions/codeweave-pi).
// Falls back to null so web stays available when codeweave-pi is not installed.
// codeweave-pi provider seam: createPiNavSmartSummaryProvider calls pi_nav_read with
// { path, mode:"auto", budget }; this file mirrors that call for the web view.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type Addon = {
  getBuildInfo?: () => unknown;
  PiNavSession: new (root: string) => {
    call: (operation: string, args: unknown, timeoutMs?: number, signal?: AbortSignal) => Promise<{ text: string; structured: unknown }>;
  };
};

let cachedAddon: Addon | null | undefined;
let cachedAddonPath: string | null | undefined;

function websiftExtensionRoot(): string {
  try {
    return resolve(dirname(fileURLToPath(import.meta.url)), "..");
  } catch {
    return process.cwd();
  }
}

function candidateAddonPaths(): string[] {
  const websiftRoot = websiftExtensionRoot();
  const codeweavePiRootCandidates = [
    resolve(websiftRoot, "../codeweave-pi"),
    resolve(websiftRoot, "../../codeweave-pi"),
    resolve(process.cwd(), "extensions/codeweave-pi"),
    resolve(process.cwd(), "extensions/websift/../codeweave-pi"),
  ];
  const darwin = "pi_nav.darwin-arm64.node";
  const linux = "pi_nav.linux-arm64.node";
  const candidates: string[] = [];
  for (const root of codeweavePiRootCandidates) {
    candidates.push(join(root, `native/pi-nav/native/${darwin}`));
    candidates.push(join(root, `native/pi-nav/native/${linux}`));
    // artifacts.json indirection as last resort
    const art = join(root, "native/pi-nav/artifacts.json");
    if (existsSync(art)) {
      try {
        const parsed = JSON.parse(readFileSync(art, "utf8")) as { targets?: Record<string, { cli?: { path?: string }; addon?: { path?: string } }> };
        for (const t of Object.values(parsed.targets ?? {})) {
          if (t.addon?.path) candidates.push(join(root, t.addon.path));
        }
      } catch { /* ignore */ }
    }
  }
  // direct Node search fallback (e.g. monorepo node_modules layout)
  candidates.push(resolve(process.cwd(), "extensions/codeweave-pi/native/pi-nav/native/pi_nav.darwin-arm64.node"));
  candidates.push(resolve(process.cwd(), "extensions/codeweave-pi/native/pi-nav/native/pi_nav.linux-arm64.node"));
  return [...new Set(candidates)];
}

function loadAddon(): Addon | null {
  if (cachedAddon !== undefined) return cachedAddon;
  for (const p of candidateAddonPaths()) {
    if (!existsSync(p)) continue;
    try {
      const addon = require(p) as Addon;
      if (addon && typeof addon.PiNavSession === "function") {
        cachedAddon = addon;
        cachedAddonPath = p;
        return addon;
      }
    } catch { /* try next */ }
  }
  cachedAddon = null;
  cachedAddonPath = null;
  return null;
}

export function piNavAddonPath(): string | null {
  loadAddon();
  return cachedAddonPath ?? null;
}

export function __resetPiNavOutlineCacheForTest(): void {
  cachedAddon = undefined;
  cachedAddonPath = undefined;
}

/** Rust markdown outline via pi-nav NAPI. Returns null on any failure so callers can fall back to JS. */
/** ADR-002.005 source-view contract: web metadata + pi-nav smart read over the cache file; JS fallback when the lane is absent. */
export async function nativeMarkdownOutline(body: string, timeoutMs = 3000): Promise<string | null> {
  const addon = loadAddon();
  if (!addon) return null;
  // Empty body produces empty outline; avoid temp I/O
  if (!body.trim()) return "";
  const dir = mkdtempSync(join(tmpdir(), "pi-web-outline-"));
  const file = join(dir, "page.md");
  try {
    writeFileSync(file, body, "utf8");
    const session = new addon.PiNavSession(dir);
    const result = await session.call("pi_nav_read", { path: file }, timeoutMs, undefined);
    const text = typeof result.text === "string" ? result.text : "";
    // pi_nav_read renders: "# /tmp/... (lines, ~tokens) [outline]\n[1-6882] # Title\n..."
    // Strip the first header line and any trailing empty metadata
    const lines = text.split("\n");
    // Find first line that looks like an outline entry "[n-m] #"
    let start = lines.findIndex((l) => /^\s*\[\d+-\d+\]/.test(l));
    if (start === -1) {
      // No outline entries — could be [full] (small file) or empty
      // For web smart view we want outline only when file is large; small files are returned full elsewhere.
      // Return empty so caller can decide fallback
      return "";
    }
    const outline = lines.slice(start).join("\n").trimEnd();
    return outline || "";
  } catch {
    return null;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
