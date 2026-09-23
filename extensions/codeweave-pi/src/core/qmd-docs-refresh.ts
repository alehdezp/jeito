import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

import { envWithNavigationProviders, loadNavigationAutomationConfig } from "./navigation-automation-config.ts";
import { withLaneTransaction } from "./navigation-lane-transaction.ts";
import { syncQmdDocs } from "./qmd-docs-search.ts";
import { detectProjectRoot } from "./project-root.ts";

const running = new Set<Promise<void>>();
const pending = new Map<string, { base: PreparedRefresh; paths: Set<string>; full: boolean }>();

export interface QmdDocsRefreshInput {
  cwd: string;
  paths?: string[];
  trigger?: "edit" | "write";
  env?: Record<string, string | undefined>;
  zeroEntropyFetch?: typeof fetch;
  providerFetch?: typeof fetch;
}

export interface QmdDocsRefreshResult {
  scheduled: number;
  skipped: number;
  reason?: string;
}

export function scheduleQmdDocsRefresh(input: QmdDocsRefreshInput): QmdDocsRefreshResult {
  const prepared = prepare(input);
  if (!prepared.ok) return { scheduled: 0, skipped: input.paths?.length ?? 0, reason: prepared.reason };
  const existing = pending.get(prepared.root);
  if (existing) {
    if (prepared.paths.length === 0) existing.full = true;
    else for (const path of prepared.paths) existing.paths.add(path);
    return { scheduled: prepared.paths.length || 1, skipped: 0 };
  }
  const entry = { base: prepared, paths: new Set(prepared.paths), full: prepared.paths.length === 0 };
  pending.set(prepared.root, entry);
  const task = Promise.resolve().then(() => drain(prepared.root)).catch(error => {
    pending.delete(prepared.root);
    recordHealth(prepared.root, false, String(error?.message ?? error), prepared.trigger);
  });
  running.add(task);
  void task.finally(() => running.delete(task));
  return { scheduled: prepared.paths.length || 1, skipped: 0 };
}

async function drain(root: string): Promise<void> {
  for (;;) {
    const entry = pending.get(root);
    if (!entry) return;
    const paths = entry.full ? [] : [...entry.paths];
    entry.full = false;
    entry.paths.clear();
    await refresh({ ...entry.base, paths });
    if (!entry.full && entry.paths.size === 0) {
      pending.delete(root);
      return;
    }
  }
}

export async function shutdownQmdDocsRefreshes(): Promise<void> {
  // Let a just-completed public mutation enqueue its refresh before taking the
  // snapshot, then drain tasks added while earlier work was settling.
  for (;;) {
    await new Promise<void>(resolve => setImmediate(resolve));
    const tasks = [...running];
    if (tasks.length === 0) return;
    await Promise.allSettled(tasks);
  }
}

interface PreparedRefresh {
  ok: true;
  root: string;
  docsRoot: string;
  indexPath: string;
  repo: string;
  paths: string[];
  trigger: string;
  desiredStateHash: string;
  apiKey?: string;
  semanticProvider?: "local" | "zeroentropy" | "voyage" | "openrouter";
  embeddingModel?: string;
  providerFetch?: typeof fetch;
}

function prepare(input: QmdDocsRefreshInput): PreparedRefresh | { ok: false; reason: string } {
  const root = canonical(detectProjectRoot(input.cwd || process.cwd()).root);
  const env = { ...process.env, ...input.env };
  const state = readJson(join(root, ".pi", "navigation", "state.json"));
  const config = readJson(join(root, ".pi-navigation.json"));
  if (config?.docs?.enabled !== true) return { ok: false, reason: "docs lane not enabled" };
  if (String(config.docs.backend ?? "").toLowerCase() !== "qmd" || config.docs.queryCommand || config.docs.queryTransport || config.docs.indexCommand) {
    return { ok: false, reason: "docs lane awaits QMD lifecycle migration" };
  }
  const repo = String(config.docs.repo ?? "").replace(/^local\//, "");
  const configuredIndex = String(config.docs.indexPath ?? ".pi/navigation/qmd");
  if (!repo) return { ok: false, reason: "docs lane missing repo" };
  const docsRoot = canonical(resolve(root, String(config.docs.root ?? ".")));
  if (!inside(root, docsRoot)) return { ok: false, reason: "configured docs root escapes the project" };
  const indexPath = isAbsolute(configuredIndex) ? configuredIndex : resolve(root, configuredIndex);
  const requested = [...new Set(input.paths ?? [])]
    .map(value => selectorPath(root, value))
    .filter((value): value is string => Boolean(value && inside(docsRoot, value) && extname(value).toLowerCase() === ".md"));
  if (input.paths && !requested.length) return { ok: false, reason: "no indexable docs changed" };
  const paths = requested.map(file => relative(docsRoot, file).replace(/\\/g, "/"));
  const automation = loadNavigationAutomationConfig({ env });
  const providerEnv = envWithNavigationProviders(automation, env);
  const semanticStatus = String(state?.indexes?.docs?.qmd?.semantic?.status ?? "unavailable");
  const semanticProvider = semanticStatus === "ready" || semanticStatus === "degraded"
    ? String(state?.indexes?.docs?.qmd?.semantic_provider ?? config.docs.embeddingProvider ?? "")
    : "";
  return {
    ok: true,
    root,
    docsRoot,
    indexPath,
    repo,
    paths,
    trigger: input.trigger ?? "edit",
    desiredStateHash: String(state?.indexes?.docs?.desiredStateHash ?? "qmd-sections-v3"),
    semanticProvider: ["local", "zeroentropy", "voyage", "openrouter"].includes(semanticProvider) ? semanticProvider as "local" | "zeroentropy" | "voyage" | "openrouter" : undefined,
    apiKey: semanticProvider === "zeroentropy" ? providerEnv.ZEROENTROPY_API_KEY : semanticProvider === "voyage" ? providerEnv.VOYAGE_API_KEY : semanticProvider === "openrouter" ? providerEnv.OPENROUTER_API_KEY : undefined,
    embeddingModel: semanticProvider === "voyage" ? providerEnv.VOYAGE_EMBEDDING_MODEL : undefined,
    providerFetch: input.providerFetch ?? input.zeroEntropyFetch,
  };
}

async function refresh(input: PreparedRefresh): Promise<void> {
  await withLaneTransaction({
    root: input.root,
    lane: "docs",
    desiredStateHash: input.desiredStateHash,
    extensionVersion: "0.9.0",
    backendVersion: "qmd-sections-v3",
    operation: input.paths.length ? "qmd_exact_paths" : "qmd_reconcile",
    timeoutMs: 120_000,
    staleMs: 60_000,
  }, async () => {
    const qmd = await syncQmdDocs({
      root: input.docsRoot,
      projectRoot: input.root,
      indexPath: input.indexPath,
      repo: `local/${input.repo}`,
      apiKey: input.apiKey,
      semanticProvider: input.semanticProvider,
      embeddingModel: input.embeddingModel,
      fetchImpl: input.providerFetch,
      paths: input.paths.length ? input.paths : undefined,
    });
    recordHealth(input.root, qmd.status === "ready" || qmd.status === "lexical_ready", qmd.status === "degraded" ? String(qmd.reason ?? "QMD degraded") : undefined, input.trigger, qmd);
  });
}

function recordHealth(root: string, ok: boolean, error: string | undefined, trigger: string, qmd?: Record<string, unknown>): void {
  const file = join(root, ".pi", "navigation", "state.json");
  const state = readJson(file) ?? {};
  state.indexes ??= {};
  state.indexes.docs ??= {};
  state.indexes.docs.refreshStatus = ok ? "ready" : "error";
  state.indexes.docs.lastIncrementalAt = new Date().toISOString();
  state.indexes.docs.lastIncrementalTrigger = trigger;
  if (ok) delete state.indexes.docs.lastIncrementalError;
  else state.indexes.docs.lastIncrementalError = error;
  if (qmd) {
    state.indexes.docs.qmd = qmd;
    if (typeof qmd.generation === "string") state.indexes.docs.generationId = qmd.generation;
  }
  try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`); } catch {}
}

function selectorPath(root: string, value: string): string | undefined {
  const raw = String(value ?? "").trim().replace(/:\d+(?:[-+]\d+)?(?:,.*)?$/, "");
  return raw ? resolve(root, raw) : undefined;
}
function readJson(file: string): any { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; } }
function canonical(value: string): string { try { return realpathSync(resolve(value)); } catch { return resolve(value); } }
function inside(root: string, value: string): boolean { const rel = relative(root, value); return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel)); }
