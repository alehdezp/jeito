// Ported-at: 7bdc30a65cf7 from pi-web-access@0.13.0 github-extract.ts + github-api.ts —
// see docs/upstreams/pi-web-access.md. Clones the repo (or uses the `gh` API) and renders
// structure/README/file content. Divergences: activityMonitor removed; the gh install hint is
// surfaced in content instead of console.error; clone config is read from web.yaml `github:`,
// not web-search.json.
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, realpathSync, rmSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { extname, join, resolve as resolvePath, sep as pathSep } from "node:path";
import { parse } from "yaml";
import { getAgentDir } from "../config.ts";
import { ProviderError } from "../failures.ts";
import type { FetchedContent } from "../types.ts";

const MAX_INLINE_FILE_CHARS = 100_000;
const MAX_TREE_ENTRIES = 200;



const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg", ".tiff", ".tif",
  ".pdf", ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar", ".mp3", ".mp4", ".mov", ".avi",
  ".mkv", ".wav", ".flac", ".ogg", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".exe",
  ".dll", ".so", ".dylib", ".bin", ".dat", ".db", ".sqlite", ".class", ".jar", ".pyc",
]);

const NOISE_DIRS = new Set([
  "node_modules", "vendor", ".next", "dist", "build", "__pycache__",
  ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
  "target", ".gradle", ".idea", ".vscode",
]);

const NON_CODE_SEGMENTS = new Set([
  "issues", "pull", "pulls", "discussions", "releases", "wiki",
  "actions", "settings", "security", "projects", "graphs",
  "compare", "commits", "tags", "branches", "stargazers",
  "watchers", "network", "forks", "milestone", "labels",
  "packages", "codespaces", "contribute", "community",
  "sponsors", "invitations", "notifications", "insights",
]);

export interface GitHubUrlInfo {
  owner: string;
  repo: string;
  ref?: string;
  refIsFullSha: boolean;
  path?: string;
  type: "root" | "blob" | "tree";
}

interface CachedClone {
  localPath: string;
  clonePromise: Promise<string | null>;
}

interface GitHubCloneConfig {
  enabled: boolean;
  maxRepoSizeMB: number;
  cloneTimeoutSeconds: number;
  clonePath: string;
}

const cloneCache = new Map<string, CachedClone>();

function normalizeEnabled(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeClonePath(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}
export function loadGitHubConfig(): GitHubCloneConfig {
  const defaults: GitHubCloneConfig = {
    enabled: true,
    maxRepoSizeMB: 350,
    cloneTimeoutSeconds: 30,
    clonePath: join(homedir(), ".pi", "github-repos"),
  };
  let text: string;
  try {
    text = readFileSync(join(getAgentDir(), "web.yaml"), "utf-8");
  } catch {
    return defaults;
  }
  let parsed: { github?: { enabled?: unknown; maxRepoSizeMB?: unknown; cloneTimeoutSeconds?: unknown; clonePath?: unknown } } | null;
  try {
    parsed = parse(text) as { github?: { enabled?: unknown; maxRepoSizeMB?: unknown; cloneTimeoutSeconds?: unknown; clonePath?: unknown } } | null;
  } catch {
    return defaults;
  }
  const gh = parsed?.github ?? {};
  return {
    enabled: normalizeEnabled(gh.enabled, defaults.enabled),
    maxRepoSizeMB: normalizePositiveNumber(gh.maxRepoSizeMB, defaults.maxRepoSizeMB),
    cloneTimeoutSeconds: normalizePositiveNumber(gh.cloneTimeoutSeconds, defaults.cloneTimeoutSeconds),
    clonePath: normalizeClonePath(gh.clonePath, defaults.clonePath),
  };
}

function cacheKey(owner: string, repo: string, ref?: string): string {
  return ref ? `${owner}/${repo}@${ref}` : `${owner}/${repo}`;
}

function cloneDir(config: GitHubCloneConfig, owner: string, repo: string, ref?: string): string {
  const dirName = ref ? `${repo}@${ref}` : repo;
  return join(config.clonePath, owner, dirName);
}

function execClone(args: string[], localPath: string, timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(args[0], args.slice(1), { timeout: timeoutMs }, (err) => {
      if (err) {
        try {
          rmSync(localPath, { recursive: true, force: true });
        } catch {
          // ignore cleanup failure; the clone dir is transient
        }
        resolve(null);
        return;
      }
      resolve(localPath);
    });
    if (signal) {
      const onAbort = () => child.kill();
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("exit", () => signal.removeEventListener("abort", onAbort));
    }
  });
}

let ghAvailable: boolean | null = null;

async function checkGhAvailable(): Promise<boolean> {
  if (ghAvailable !== null) return ghAvailable;
  return new Promise((resolve) => {
    execFile("gh", ["--version"], { timeout: 5000 }, (err) => {
      ghAvailable = !err;
      resolve(ghAvailable ?? false);
    });
  });
}

function ghJson(args: string[], timeoutMs: number, maxBuffer = 2 * 1024 * 1024): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("gh", args, { timeout: timeoutMs, maxBuffer }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

async function checkRepoSize(owner: string, repo: string): Promise<number | null> {
  if (!(await checkGhAvailable())) return null;
  const stdout = await ghJson(["api", `repos/${owner}/${repo}`, "--jq", ".size"], 10_000);
  if (stdout === null) return null;
  const kb = parseInt(stdout.trim(), 10);
  return Number.isNaN(kb) ? null : kb;
}

async function getDefaultBranch(owner: string, repo: string): Promise<string | null> {
  if (!(await checkGhAvailable())) return null;
  const stdout = await ghJson(["api", `repos/${owner}/${repo}`, "--jq", ".default_branch"], 10_000);
  if (stdout === null) return null;
  const branch = stdout.trim();
  return branch || null;
}

async function fetchTreeViaApi(owner: string, repo: string, ref: string): Promise<string | null> {
  if (!(await checkGhAvailable())) return null;
  const stdout = await ghJson(["api", `repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, "--jq", ".tree[].path"], 15_000, 5 * 1024 * 1024);
  if (stdout === null) return null;
  const paths = stdout.trim().split("\n").filter(Boolean);
  if (!paths.length) return null;
  const truncated = paths.length > MAX_TREE_ENTRIES;
  const display = paths.slice(0, MAX_TREE_ENTRIES).join("\n");
  return truncated ? `${display}\n... (${paths.length} total entries)` : display;
}

async function fetchReadmeViaApi(owner: string, repo: string, ref: string): Promise<string | null> {
  if (!(await checkGhAvailable())) return null;
  const stdout = await ghJson(["api", `repos/${owner}/${repo}/readme?ref=${ref}`, "--jq", ".content"], 10_000);
  if (stdout === null) return null;
  try {
    const decoded = Buffer.from(stdout.trim(), "base64").toString("utf-8");
    return decoded;
  } catch {
    return null;
  }
}

async function fetchFileViaApi(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
  if (!(await checkGhAvailable())) return null;
  const stdout = await ghJson(["api", `repos/${owner}/${repo}/contents/${path}?ref=${ref}`, "--jq", ".content"], 10_000);
  if (stdout === null) return null;
  try {
    return Buffer.from(stdout.trim(), "base64").toString("utf-8");
  } catch {
    return null;
  }
}

async function fetchViaApi(url: string, owner: string, repo: string, info: GitHubUrlInfo, sizeNote?: string): Promise<FetchedContent | null> {
  const ref = info.ref || (await getDefaultBranch(owner, repo));
  if (!ref) return null;

  const lines: string[] = [];
  if (sizeNote) lines.push(sizeNote, "");

  if (info.type === "blob" && info.path) {
    const content = await fetchFileViaApi(owner, repo, info.path, ref);
    if (!content) return null;
    lines.push(`## ${info.path}`);
    if (content.length > MAX_INLINE_FILE_CHARS) {
      lines.push(content.slice(0, MAX_INLINE_FILE_CHARS), "\n[File truncated at 100K chars]");
    } else {
      lines.push(content);
    }
    return { url, title: `${owner}/${repo} - ${info.path}`, content: lines.join("\n") };
  }

  const [tree, readme] = await Promise.all([fetchTreeViaApi(owner, repo, ref), fetchReadmeViaApi(owner, repo, ref)]);
  if (!tree && !readme) return null;
  if (tree) lines.push("## Structure", tree, "");
  if (readme) lines.push("## README.md", readme, "");
  lines.push("This is an API-only view. Clone the repo or use `read`/`bash` for deeper exploration.");
  const title = info.path ? `${owner}/${repo} - ${info.path}` : `${owner}/${repo}`;
  return { url, title, content: lines.join("\n") };
}

function isBinaryFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(512);
    const bytesRead = readSync(fd, buf, 0, 512, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
  return false;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function resolveWithinRepo(rootPath: string, relativePath: string): string | null {
  const normalizedRoot = resolvePath(rootPath);
  const candidate = resolvePath(normalizedRoot, relativePath);
  if (candidate !== normalizedRoot) {
    const rootPrefix = normalizedRoot.endsWith(pathSep) ? normalizedRoot : normalizedRoot + pathSep;
    if (!candidate.startsWith(rootPrefix)) return null;
  }
  if (!existsSync(candidate)) return candidate;
  try {
    const realRoot = realpathSync(normalizedRoot);
    const realCandidate = realpathSync(candidate);
    if (realCandidate === realRoot) return candidate;
    const realRootPrefix = realRoot.endsWith(pathSep) ? realRoot : realRoot + pathSep;
    return realCandidate.startsWith(realRootPrefix) ? candidate : null;
  } catch {
    return null;
  }
}

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function buildTree(rootPath: string): string {
  const entries: string[] = [];
  function walk(dir: string, relPath: string): void {
    if (entries.length >= MAX_TREE_ENTRIES) return;
    let items: string[];
    try {
      items = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const item of items) {
      if (entries.length >= MAX_TREE_ENTRIES) return;
      if (item === ".git") continue;
      const rel = relPath ? `${relPath}/${item}` : item;
      const safePath = resolveWithinRepo(rootPath, rel);
      if (!safePath) {
        entries.push(`${rel}  [outside repo skipped]`);
        continue;
      }
      let stat;
      try {
        stat = statSync(safePath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (NOISE_DIRS.has(item)) {
          entries.push(`${rel}/  [skipped]`);
          continue;
        }
        entries.push(`${rel}/`);
        walk(safePath, rel);
      } else {
        entries.push(rel);
      }
    }
  }
  walk(rootPath, "");
  if (entries.length >= MAX_TREE_ENTRIES) entries.push(`... (truncated at ${MAX_TREE_ENTRIES} entries)`);
  return entries.join("\n");
}

function buildDirListing(rootPath: string, subPath: string): string {
  const targetPath = resolveWithinRepo(rootPath, subPath);
  if (!targetPath) return "(path escapes repository root)";
  const lines: string[] = [];
  let items: string[];
  try {
    items = readdirSync(targetPath).sort();
  } catch {
    return "(directory not readable)";
  }
  for (const item of items) {
    if (item === ".git") continue;
    const rel = subPath ? `${subPath}/${item}` : item;
    const safePath = resolveWithinRepo(rootPath, rel);
    if (!safePath) {
      lines.push(`  ${item}  (outside repo)`);
      continue;
    }
    try {
      const stat = statSync(safePath);
      lines.push(stat.isDirectory() ? `  ${item}/` : `  ${item}  (${formatFileSize(stat.size)})`);
    } catch {
      lines.push(`  ${item}  (unreadable)`);
    }
  }
  return lines.join("\n");
}

function readReadme(localPath: string): string | null {
  const candidates = ["README.md", "readme.md", "README", "README.txt", "README.rst"];
  for (const name of candidates) {
    const readmePath = join(localPath, name);
    if (existsSync(readmePath)) {
      try {
        const content = readFileSync(readmePath, "utf-8");
        return content;
      } catch {
        continue;
      }
    }
  }
  return null;
}

const EXPLORE_HINT = "Use `read` and `bash` tools at the path above to explore further.";

function generateContent(localPath: string, info: GitHubUrlInfo): string {
  const lines: string[] = [`Repository cloned to: ${localPath}`, ""];

  if (info.type === "root") {
    lines.push("## Structure", buildTree(localPath), "");
    const readme = readReadme(localPath);
    if (readme) lines.push("## README.md", readme, "");
    lines.push(EXPLORE_HINT);
    return lines.join("\n");
  }

  if (info.type === "tree") {
    const dirPath = info.path || "";
    const fullDirPath = resolveWithinRepo(localPath, dirPath);
    if (!fullDirPath || !existsSync(fullDirPath)) {
      lines.push(`Path \`${dirPath}\` not found in clone. Showing repository root instead.`, "", "## Structure", buildTree(localPath));
    } else {
      lines.push(`## ${dirPath || "/"}`, buildDirListing(localPath, dirPath));
    }
    lines.push("", EXPLORE_HINT);
    return lines.join("\n");
  }

  const filePath = info.path || "";
  const fullFilePath = resolveWithinRepo(localPath, filePath);
  if (!fullFilePath || !existsSync(fullFilePath)) {
    lines.push(`Path \`${filePath}\` not found in clone. Showing repository root instead.`, "", "## Structure", buildTree(localPath), "", EXPLORE_HINT);
    return lines.join("\n");
  }

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(fullFilePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lines.push(`Could not inspect \`${filePath}\`: ${message}`, "", EXPLORE_HINT);
    return lines.join("\n");
  }

  if (stat.isDirectory()) {
    lines.push(`## ${filePath || "/"}`, buildDirListing(localPath, filePath), "", EXPLORE_HINT);
    return lines.join("\n");
  }

  if (isBinaryFile(fullFilePath)) {
    const ext = extname(filePath).replace(".", "");
    lines.push(`## ${filePath}`, `Binary file (${ext}, ${formatFileSize(stat.size)}). Use \`read\` or \`bash\` tools at the path above to inspect.`);
    return lines.join("\n");
  }

  const content = readTextFile(fullFilePath);
  if (content === null) {
    lines.push(`Could not read \`${filePath}\` as UTF-8 text.`, "", EXPLORE_HINT);
    return lines.join("\n");
  }
  lines.push(`## ${filePath}`);
  if (content.length > MAX_INLINE_FILE_CHARS) {
    lines.push(content.slice(0, MAX_INLINE_FILE_CHARS), "", `[File truncated at 100K chars. Full file: ${fullFilePath}]`);
  } else {
    lines.push(content);
  }
  lines.push("", EXPLORE_HINT);
  return lines.join("\n");
}

async function cloneRepo(owner: string, repo: string, ref: string | undefined, config: GitHubCloneConfig, signal?: AbortSignal): Promise<string | null> {
  const localPath = cloneDir(config, owner, repo, ref);
  try {
    rmSync(localPath, { recursive: true, force: true });
  } catch {
    // ignore stale clone cleanup failure
  }
  const timeoutMs = config.cloneTimeoutSeconds * 1000;
  if (await checkGhAvailable()) {
    const args = ["gh", "repo", "clone", `${owner}/${repo}`, localPath, "--", "--depth", "1", "--single-branch"];
    if (ref) args.push("--branch", ref);
    return execClone(args, localPath, timeoutMs, signal);
  }
  const gitUrl = `https://github.com/${owner}/${repo}.git`;
  const args = ["git", "clone", "--depth", "1", "--single-branch"];
  if (ref) args.push("--branch", ref);
  args.push(gitUrl, localPath);
  return execClone(args, localPath, timeoutMs, signal);
}

async function awaitCachedClone(cached: CachedClone, url: string, owner: string, repo: string, info: GitHubUrlInfo, signal?: AbortSignal): Promise<FetchedContent | null> {
  if (signal?.aborted) throw new ProviderError("aborted", "GitHub fetch aborted");
  const result = await cached.clonePromise;
  if (signal?.aborted) throw new ProviderError("aborted", "GitHub fetch aborted");
  if (result) {
    const title = info.path ? `${owner}/${repo} - ${info.path}` : `${owner}/${repo}`;
    return { url, title, content: generateContent(result, info) };
  }
  return fetchViaApi(url, owner, repo, info);
}

export function parseGitHubUrl(url: string): GitHubUrlInfo | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;
  const segments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  if (segments.length < 2) return null;
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/, "");
  if (NON_CODE_SEGMENTS.has(segments[2]?.toLowerCase())) return null;
  if (segments.length === 2) return { owner, repo, refIsFullSha: false, type: "root" };
  const action = segments[2];
  if (action !== "blob" && action !== "tree") return null;
  if (segments.length < 4) return null;
  const ref = segments[3];
  const refIsFullSha = /^[0-9a-f]{40}$/.test(ref);
  const pathParts = segments.slice(4);
  const path = pathParts.length > 0 ? pathParts.join("/") : "";
  return { owner, repo, ref, refIsFullSha, path, type: action as "blob" | "tree" };
}

export interface GitHubFetchOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export async function extractGitHub(url: string, options: GitHubFetchOptions): Promise<FetchedContent | null> {
  const info = parseGitHubUrl(url);
  if (!info) return null;
  if (options.signal?.aborted) throw new ProviderError("aborted", "GitHub fetch aborted");

  const config = loadGitHubConfig();
  if (!config.enabled) return null;

  const { owner, repo } = info;
  const key = cacheKey(owner, repo, info.ref);
  const cached = cloneCache.get(key);
  if (cached) return awaitCachedClone(cached, url, owner, repo, info, options.signal);

  if (info.refIsFullSha) {
    // A full-SHA URL cannot be shallow-cloned by branch, so use the API view.
    return fetchViaApi(url, owner, repo, info, "Note: Commit SHA URLs use the GitHub API instead of cloning.");
  }

  const sizeKB = await checkRepoSize(owner, repo);
  if (options.signal?.aborted) throw new ProviderError("aborted", "GitHub fetch aborted");
  if (sizeKB !== null) {
    const sizeMB = sizeKB / 1024;
    if (sizeMB > config.maxRepoSizeMB) {
      const sizeNote =
        `Note: Repository is ${Math.round(sizeMB)}MB (threshold: ${config.maxRepoSizeMB}MB). ` +
        "Large repositories use the bounded GitHub API view instead of a full clone; " +
        "the API path returns structure, README, and individual files without cloning.";
      return fetchViaApi(url, owner, repo, info, sizeNote);
    }
  }

  if (options.signal?.aborted) throw new ProviderError("aborted", "GitHub fetch aborted");

  // Re-check after the awaited size check: another concurrent caller may have started the clone.
  const cachedAfterSizeCheck = cloneCache.get(key);
  if (cachedAfterSizeCheck) return awaitCachedClone(cachedAfterSizeCheck, url, owner, repo, info, options.signal);

  const clonePromise = cloneRepo(owner, repo, info.ref, config, options.signal);
  const localPath = cloneDir(config, owner, repo, info.ref);
  cloneCache.set(key, { localPath, clonePromise });

  const result = await clonePromise;
  if (options.signal?.aborted) {
    if (!result) cloneCache.delete(key);
    throw new ProviderError("aborted", "GitHub fetch aborted");
  }

  if (!result) {
    cloneCache.delete(key);
    const apiFallback = await fetchViaApi(url, owner, repo, info);
    if (apiFallback) return apiFallback;
    const hint = (await checkGhAvailable()) ? "" : " Install the `gh` CLI for private repos and better fallback access.";
    throw new ProviderError("network", `GitHub clone and API fallback failed for ${owner}/${repo}.${hint}`);
  }

  const title = info.path ? `${owner}/${repo} - ${info.path}` : `${owner}/${repo}`;
  return { url, title, content: generateContent(result, info) };
}

export function clearCloneCache(): void {
  for (const entry of cloneCache.values()) {
    try {
      rmSync(entry.localPath, { recursive: true, force: true });
    } catch {
      // best-effort cleanup of cached clones
    }
  }
  cloneCache.clear();
}