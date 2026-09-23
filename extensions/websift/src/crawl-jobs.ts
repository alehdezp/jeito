// ADR-002.005 + schema v2: crawl runs as a session-local async job — parallel
// (webclaw --concurrency 5) until every page in the bounded scope is downloaded. The
// agent soft-waits (web_fetch urls:"crawl:N" wait:N — polls default to 30s) or lets the
// completion surface on the next web_fetch call (inbox contract: results are never lost
// and never silent). The listing shows title + description + url + cache path; when the
// job carries query_terms, polling ranks each page (top 2) and orders matched pages by
// relevance. URL grammar (tolerance doctrine): https://x/ and https://x/test crawl the
// site or the /test subtree; * is one path segment, ** is recursive (depth capped);
// brackets are optional around a single include glob; -[excl] adds exclusions.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { redactUrl, writeCache, writeCrawlManifest } from "./fetch-cache.ts";
import { parseLlmOutput, runWebclaw, splitCrawlPages, type SpawnWebclaw, type SpawnOptions } from "./webclaw-spawn.ts";
import { rankSnippets, snippetBlockText } from "./section-rank.ts";
import { assertAllowedDestination, type DestinationPolicy } from "./destination-policy.ts";

export const CRAWL_JOB_TIMEOUT_MS = 120_000;
export const CRAWL_RANK_TOP_N = 2; // per crawled page (schema v2 hierarchy: single 5 / multi 3 / crawl 2)
export const MAX_RECURSIVE_DEPTH = 25;

export interface LlmAnswerJob {
  id: string;
  url: string;
  objective?: string;
  queryTerms?: string;
  summaryPath: string;
  signal: AbortSignal;
  status: "running" | "completed" | "failed";
  startedAt: number;
  finishedAt?: number;
  error?: string;
}
export interface LlmAnswerJobManager {
  start(request: { url: string; objective?: string; queryTerms?: string; summaryPath: string }): LlmAnswerJob;
  findRunning(summaryPath: string): LlmAnswerJob | undefined;
  complete(job: LlmAnswerJob): void;
  fail(job: LlmAnswerJob, error: string): void;
  get(id: string): LlmAnswerJob | undefined;
  wait(job: LlmAnswerJob, seconds: number): Promise<void>;
  drainCompletions(): LlmAnswerJob[];
  stopAll(): void;
}
export function createLlmAnswerJobManager(pi: ExtensionAPI): LlmAnswerJobManager {
  const jobs = new Map<string, LlmAnswerJob>();
  const running = new Map<string, LlmAnswerJob>();
  const controllers = new Map<string, AbortController>();
  const unreported = new Set<string>();
  let counter = 0;
  function start(request: { url: string; objective?: string; queryTerms?: string; summaryPath: string }): LlmAnswerJob {
    const existing = running.get(request.summaryPath);
    if (existing) return existing;
    const controller = new AbortController();
    const job: LlmAnswerJob = { id: `llm-answer-${++counter}`, url: request.url, objective: request.objective, queryTerms: request.queryTerms, summaryPath: request.summaryPath, signal: controller.signal, status: "running", startedAt: Date.now() };
    jobs.set(job.id, job);
    running.set(job.summaryPath, job);
    controllers.set(job.id, controller);
    return job;
  }
  function finish(job: LlmAnswerJob, status: "completed" | "failed", error?: string): void {
    if (job.status !== "running") return;
    job.status = status;
    job.finishedAt = Date.now();
    if (error) job.error = error;
    if (running.get(job.summaryPath)?.id === job.id) running.delete(job.summaryPath);
    controllers.delete(job.id);
    unreported.add(job.id);
  }
  function get(id: string): LlmAnswerJob | undefined {
    const job = jobs.get(id);
    if (job) unreported.delete(job.id);
    return job;
  }
  function drainCompletions(): LlmAnswerJob[] {
    const done = [...unreported].map((id) => jobs.get(id)).filter((job): job is LlmAnswerJob => Boolean(job));
    unreported.clear();
    return done;
  }
  async function wait(job: LlmAnswerJob, seconds: number): Promise<void> {
    const until = Date.now() + seconds * 1000;
    while (job.status === "running" && Date.now() < until) await delay(200);
  }
  function stopAll(): void {
    for (const job of jobs.values()) if (job.status === "running") {
      controllers.get(job.id)?.abort();
      finish(job, "failed", "cancelled at session shutdown");
    }
  }
  pi.on?.("session_shutdown", stopAll);
  return {
    start,
    findRunning: (summaryPath) => running.get(summaryPath),
    complete: (job) => finish(job, "completed"),
    fail: (job, error) => finish(job, "failed", error),
    get, wait, drainCompletions, stopAll,
  };
}

export interface CrawlRequest {
  seed: string;
  include: string[];
  exclude: string[];
  depth: number;
  maxPages: number;
  root: string;
  terms?: string; // stored query_terms; ranking applies when the job is polled
  destinationPolicy: DestinationPolicy;
}
export interface CrawlPage {
  url: string;
  title: string;
  description?: string;
  estimatedTokens: number;
  path: string;
  body?: string; // raw llm body kept in memory so poll-time ranking needs no disk read
}
export interface CrawlJob {
  id: string;
  seed: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  finishedAt?: number;
  pages?: CrawlPage[];
  manifestPath?: string;
  terms?: string;
  error?: string;
  note?: string;
}
export interface CrawlJobManager {
  start(request: CrawlRequest): CrawlJob;
  get(id: string): CrawlJob | undefined;
  wait(job: CrawlJob, seconds: number): Promise<void>;
  /** Completed jobs not yet reported; the next web_fetch call of any kind surfaces them. */
  drainCompletions(): CrawlJob[];
  stopAll(): void;
}

/** Tolerant map/crawl URL grammar (schema v2). Explicit forms only — a bare root/path
 *  URL is a plain page fetch unless mode:"crawl" turns it into a subtree crawl via crawlScope. */
export interface ParsedCrawlFormat { seed: string; include: string[]; exclude: string[]; depth: number }
function splitList(raw?: string): string[] { return (raw ?? "").split(",").map((part) => part.trim()).filter(Boolean); }
function depthOf(includes: string[]): number {
  let depth = 1;
  for (const include of includes) {
    if (include.includes("**")) { depth = Math.max(depth, MAX_RECURSIVE_DEPTH); continue; }
    let wildcards = 0;
    for (const segment of include.split("/")) if (segment.includes("*")) wildcards += 1;
    depth = Math.max(depth, wildcards);
  }
  return depth;
}

export function parseCrawlFormat(input: string): ParsedCrawlFormat | undefined {
  const trimmed = input.trim();
  const bracket = trimmed.match(/^(https?:\/\/[^+\s]+)\+\[([^\]]*)\](?:-\[([^\]]*)\])?$/);
  if (bracket) {
    const include = splitList(bracket[2]);
    return { seed: bracket[1]!.replace(/\/+$/, ""), include, exclude: splitList(bracket[3]), depth: depthOf(include) };
  }
  // Bare-glob form: scheme+host is the seed, the path from the first "*" is the single
  // include glob (brackets optional), an optional -[excl] appends exclusions. Examples:
  // https://x/*  https://x/*/*  https://x/**  https://x/test/*  https://x/*-[c/*]
  const bare = trimmed.match(/^(https?:\/\/[^/]+)(\/[^*]*\*\*?[^-\[]*)(?:-\[([^\]]*)\])?$/);
  if (bare) {
    const include = [bare[2]!.replace(/\/$/, "")];
    return { seed: bare[1]!, include, exclude: splitList(bare[3]), depth: depthOf(include) };
  }
  return undefined;
}

/** Crawl scope for a bare URL under mode:"crawl": the site root or the given path's
 *  subtree — https://x/ -> /*, https://x/test -> /test/* (schema v2 Q1/Q5). */
export function crawlScope(raw: string): { seed: string; include: string[]; exclude: string[]; depth: number } {
  const explicit = parseCrawlFormat(raw);
  if (explicit) {
    const wildcard = raw.indexOf("*");
    if (wildcard >= 0 && !raw.includes("+[")) {
      const prefix = raw.slice(0, wildcard).replace(/\/+$/, "");
      const prefixUrl = new URL(prefix);
      if (prefixUrl.pathname !== "/") return { ...explicit, seed: prefixUrl.href.replace(/\/+$/, "") };
    }
    return explicit;
  }
  const clean = raw.trim().replace(/\/+$/, "");
  const url = new URL(clean);
  const path = url.pathname === "/" ? "" : url.pathname;
  return { seed: clean, include: path ? [`${path}/*`] : ["/*"], exclude: [], depth: 1 };
}

export function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let index = 0; index < glob.length; index++) {
    if (glob[index] === "*" && glob[index + 1] === "*") { pattern += ".*"; index += 1; }
    else if (glob[index] === "*") pattern += "[^/]*";
    else pattern += glob[index]!.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
}

/** webclaw's --include-paths glob does not match the directory page itself (verified on
 *  sitemaps.org), so `X/*` expands to also include `X/` — the landing page is not skipped. */
export function normalizeIncludePaths(include: string[]): string[] {
  const result: string[] = [];
  for (const raw of include) {
    const glob = raw.startsWith("/") ? raw : `/${raw}`;
    if (!result.includes(glob)) result.push(glob);
    if (glob.endsWith("/*")) {
      const parent = glob.slice(0, -1);
      if (!result.includes(parent)) result.push(parent);
    }
  }
  return result;
}

function crawlPageInScope(rawUrl: string, request: CrawlRequest): URL | undefined {
  let candidate: URL;
  let seed: URL;
  try { candidate = new URL(rawUrl); seed = new URL(request.seed); }
  catch { return undefined; }
  if (candidate.origin !== seed.origin) return undefined;
  candidate.hash = "";
  const normalize = (glob: string) => glob.startsWith("/") ? glob : `/${glob}`;
  const included = normalizeIncludePaths(request.include).map((glob) => globToRegExp(normalize(glob)));
  const excluded = request.exclude.map((glob) => normalize(glob));
  const seedPath = seed.pathname.replace(/\/+$/, "") || "/";
  const path = candidate.pathname;
  const pathWithoutSlash = path.replace(/\/+$/, "") || "/";
  const inside = included.length === 0 || included.some((matcher) => matcher.test(path)) || (seedPath !== "/" && pathWithoutSlash === seedPath);
  if (!inside) return undefined;
  const blocked = excluded.some((glob) => glob.includes("*")
    ? globToRegExp(glob).test(path)
    : pathWithoutSlash === (glob.replace(/\/+$/, "") || "/") || path.startsWith(`${glob.replace(/\/+$/, "")}/`));
  return blocked ? undefined : candidate;
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); }); }

function pageLine(page: CrawlPage): string {
  return `${page.title}${page.description ? ` — ${page.description}` : ""} (${page.url}) -> ${page.path} · ~${page.estimatedTokens} tokens`;
}

export function formatCrawlJob(job: CrawlJob, terms?: string): string {
  const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
  const head = `crawl:${job.id} [${job.status}] ${elapsed}s · seed ${redactUrl(job.seed)}`;
  if (job.status === "running") return `${head}\nPoll: web_fetch({urls:"crawl:${job.id}", wait:15}) — polls soft-wait 30s by default`;
  if (job.status === "failed") return `${head}\n${job.error ?? "Crawl failed"}`;
  if (job.status === "cancelled") return head;
  if (!job.pages?.length) return `${head} · 0 page(s)${job.note ? ` — ${job.note}` : ""}`;
  const query = terms ?? job.terms;
  if (!query) {
    const lines = [`crawl:${job.id} [completed] ${elapsed}s · ${job.pages.length} page(s)${job.note ? ` — ${job.note}` : ""}`, ...job.pages.map(pageLine)];
    if (job.manifestPath) lines.push(`Manifest: ${job.manifestPath}`);
    return lines.join("\n");
  }
  const ranked = job.pages
    .map((page) => ({ page, rank: page.body ? rankSnippets(page.body, query, CRAWL_RANK_TOP_N) : undefined }))
    .filter((entry): entry is { page: CrawlPage; rank: NonNullable<ReturnType<typeof rankSnippets>> } => Boolean(entry.rank));
  const matched = ranked.filter((entry) => !entry.rank.notFound).sort((a, b) => b.rank.topScore - a.rank.topScore);
  const noMatch = ranked.filter((entry) => entry.rank.notFound);
  const lines = [`crawl:${job.id} [completed] ${elapsed}s · ${job.pages.length} page(s) · ${matched.length} matched · ${noMatch.length} no quality match · query "${query}"${job.note ? ` — ${job.note}` : ""}`];
  for (const { page, rank } of matched) {
    lines.push(`## ${pageLine(page)}`);
    for (const snippet of rank.snippets) lines.push(snippetBlockText(snippet, 0));
  }
  for (const { page } of noMatch) lines.push(`- ${pageLine(page)} — no quality match; read or grep the file`);
  if (job.manifestPath) lines.push(`Manifest: ${job.manifestPath}`);
  return lines.join("\n");
}

export function createCrawlJobManager(pi: ExtensionAPI, spawn: SpawnWebclaw = runWebclaw): CrawlJobManager {
  const jobs = new Map<string, CrawlJob>();
  const unreported = new Set<string>();
  const running = new Map<string, CrawlJob>();
  const controllers = new Map<string, AbortController>();
  let counter = 0;
  let stopped = false;

  function start(request: CrawlRequest): CrawlJob {
    const key = JSON.stringify([request.root, request.seed, request.include, request.exclude, request.depth, request.maxPages]);
    const existing = running.get(key);
    if (existing?.status === "running") return existing;
    const job: CrawlJob = { id: String(++counter), seed: request.seed, status: "running", startedAt: Date.now(), terms: request.terms };
    const controller = new AbortController();
    jobs.set(job.id, job);
    running.set(key, job);
    controllers.set(job.id, controller);
    const include = normalizeIncludePaths(request.include);
    const args = [request.seed, "--crawl", "--depth", String(request.depth), "--max-pages", String(request.maxPages), "--sitemap", "--concurrency", "5", "--delay", "100", "-f", "llm"];
    if (include.length) args.push("--include-paths", include.join(","));
    if (request.exclude.length) args.push("--exclude-paths", request.exclude.map((raw) => (raw.startsWith("/") ? raw : `/${raw}`)).join(","));
    const options: SpawnOptions = { timeoutMs: CRAWL_JOB_TIMEOUT_MS, signal: controller.signal, destination: { url: request.seed, policy: request.destinationPolicy } };
    void (async () => {
      try {
        const result = await spawn(args, options);
        if (stopped || job.status !== "running") { job.status = job.status === "running" ? "cancelled" : job.status; job.finishedAt = Date.now(); return; }
        const stderr = String(result.stderr ?? "").slice(0, 400);
        const pages: CrawlPage[] = [];
        const seen = new Set<string>();
        let rejected = 0;
        for (const page of splitCrawlPages(String(result.stdout ?? ""))) {
          const { header, body } = parseLlmOutput(page);
          if (!header.url) { rejected += 1; continue; }
          const candidate = crawlPageInScope(header.url, request);
          if (!candidate) { rejected += 1; continue; }
          const approved = await assertAllowedDestination(candidate.href, request.destinationPolicy);
          const scoped = crawlPageInScope(approved.url.href, request);
          if (stopped || job.status !== "running") return;
          if (!scoped) { rejected += 1; continue; }
          const url = redactUrl(scoped.href);
          if (seen.has(url)) continue;
          seen.add(url);
          if (pages.length >= request.maxPages) { rejected += 1; continue; }
          const entry = writeCache({ canonicalUrl: scoped.href, sourceUrl: scoped.href, provider: "webclaw", fetchMode: "crawl", extract: "llm", title: header.title ?? scoped.href, body, crawlSeed: request.seed, description: header.description, author: header.author, language: header.language, wordCount: header.wordCount }, request.root);
          pages.push({ url, title: entry.meta.title, description: header.description, estimatedTokens: entry.meta.estimatedTokens, path: entry.path, body });
        }
        if (!result.ok && !pages.length) {
          job.status = "failed";
          job.finishedAt = Date.now();
          job.error = stderr || `webclaw crawl exited ${String(result.code)}`;
          unreported.add(job.id);
          return;
        }
        if (stopped || job.status !== "running") return;
        const seedUrl = new URL(request.seed);
        const manifestIdentity = JSON.stringify([request.seed, request.include, request.exclude, request.depth, request.maxPages]);
        job.pages = pages;
        job.manifestPath = writeCrawlManifest(seedUrl.host, manifestIdentity, {
          seed: redactUrl(request.seed), created: new Date().toISOString(),
          entries: pages.map((page) => ({ url: page.url, title: page.title, description: page.description, path: page.path, estimated_tokens: page.estimatedTokens })),
          totals: { pages: pages.length },
        }, request.root);
        const notes = [
          ...(!result.ok ? [`partial: webclaw exited ${String(result.code)}; ${pages.length} page(s) parsed — ${stderr.split("\n")[0] ?? "stderr empty"}`] : []),
          ...(rejected ? [`${rejected} off-scope, malformed, over-cap, or headerless page(s) rejected locally`] : []),
        ];
        if (notes.length) job.note = notes.join("; ");
        job.status = "completed";
        job.finishedAt = Date.now();
        unreported.add(job.id);
      } catch (error) {
        if (job.status === "cancelled") return;
        job.status = "failed";
        job.finishedAt = Date.now();
        job.error = error instanceof Error ? error.message : "Crawl finalization failed";
        unreported.add(job.id);
      } finally {
        if (running.get(key)?.id === job.id) running.delete(key);
        controllers.delete(job.id);
      }
    })();
    return job;
  }

  function get(id: string): CrawlJob | undefined {
    const job = jobs.get(id);
    if (job) unreported.delete(job.id);
    return job;
  }

  function drainCompletions(): CrawlJob[] {
    const done = [...unreported].map((id) => jobs.get(id)).filter((job): job is CrawlJob => Boolean(job));
    unreported.clear();
    return done;
  }

  async function wait(job: CrawlJob, seconds: number): Promise<void> {
    const until = Date.now() + seconds * 1000;
    while (job.status === "running" && Date.now() < until) await delay(200);
  }

  function stopAll(): void {
    stopped = true;
    for (const job of jobs.values()) if (job.status === "running") {
      controllers.get(job.id)?.abort();
      job.status = "cancelled";
      job.finishedAt = Date.now();
    }
    running.clear();
  }

  pi.on?.("session_shutdown", stopAll);
  return { start, get, wait, drainCompletions, stopAll };
}
