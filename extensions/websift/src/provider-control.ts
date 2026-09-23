// ADR-004.001: user-invoked `/web-setup` is the local provider control center. Opening is
// network-free; explicit actions cover official account links, masked inline or shell persistence,
// bounded name-only shell diagnosis, one-provider liveness, and Tavily/Linkup usage.
//
// Secret values may enter only the local masked TUI. They never reach model context, the guided
// skill, conversation, session entries, logs, notifications, errors, snapshots, or tests. A value
// is written directly to one mode-0600 local target after a fixed redacted preview: either
// providers.<id>.apiKey in web.yaml or one exported assignment in the command-owned shell secret
// file. No secret backup is made. Environment inheritance remains the recommended runtime boundary.
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExecResult, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Input, sliceByColumn, truncateToWidth } from "@earendil-works/pi-tui";
import { parseDocument } from "yaml";
import { linkupGetBalance } from "./adapters/linkup.ts";
import { tavilyGetUsage } from "./adapters/tavily.ts";
import { credentialStatus, getAgentDir, loadConfig, resolveCredential, type CredentialStatus, type WebConfig } from "./config.ts";
import { ProviderError, redactCredential } from "./failures.ts";
import type { AdapterRegistry } from "./registry.ts";
import type { FailureClass, Intent, OpContext, Operation, SearchIntent, TavilyUsageResponse } from "./types.ts";

type FetchLike = typeof fetch;

// --- Provider page catalog -------------------------------------------------
// Official convenience destinations for each provider's own account/key/billing/docs surfaces.
// These are grounded direct routes to official pages — NOT API-health or contract proof: an
// account page answering says nothing about API endpoint health. Where a provider hosts keys
// inside its dashboard/console with no separate published route, that route is reused and the
// label names the surface. SkillsMP exposes no account/billing surface, so none is guessed.
// Native Fetch and Pi Packages are local/no-account providers: they carry no pages, key actions,
// or usage — selecting one only explains that they work out of the box.
export interface ProviderPage { label: string; url: string }
export interface ProviderCatalogEntry { id: string; label: string; pages: ProviderPage[]; local?: boolean }

export const PROVIDER_PAGES: ProviderCatalogEntry[] = [
  { id: "serper", label: "Serper", pages: [
    { label: "Dashboard", url: "https://serper.dev/dashboard" },
    { label: "API keys", url: "https://serper.dev/api-keys" },
    { label: "Billing", url: "https://serper.dev/billing" },
    { label: "Docs", url: "https://serper.dev/" },
  ] },
  { id: "exa", label: "Exa", pages: [
    { label: "Dashboard", url: "https://dashboard.exa.ai/" },
    { label: "API keys", url: "https://dashboard.exa.ai/api-keys" },
    { label: "Billing", url: "https://dashboard.exa.ai/billing" },
    { label: "Docs", url: "https://exa.ai/docs" },
  ] },
  { id: "tavily", label: "Tavily", pages: [
    { label: "Dashboard", url: "https://app.tavily.com/" },
    { label: "API keys", url: "https://app.tavily.com/" },
    { label: "Billing", url: "https://app.tavily.com/billing" },
    { label: "Docs", url: "https://docs.tavily.com/" },
  ] },
  { id: "linkup", label: "Linkup", pages: [
    { label: "Dashboard", url: "https://app.linkup.so" },
    { label: "API keys", url: "https://app.linkup.so" },
    { label: "Billing", url: "https://app.linkup.so/organization/billing" },
    { label: "Docs", url: "https://docs.linkup.so/pages/documentation/platform/authentication" },
  ] },
  { id: "xsearch", label: "xAI / X search", pages: [
    { label: "Console", url: "https://console.x.ai/" },
    { label: "API keys", url: "https://console.x.ai/" },
    { label: "Billing", url: "https://console.x.ai/team/default/billing" },
    { label: "Usage", url: "https://console.x.ai/team/default/usage" },
    { label: "Docs", url: "https://docs.x.ai/" },
  ] },
  { id: "context7", label: "Context7", pages: [
    { label: "Dashboard", url: "https://context7.com/dashboard" },
    { label: "API keys", url: "https://context7.com/dashboard" },
    { label: "Key docs", url: "https://context7.com/docs/howto/api-keys" },
    { label: "API docs", url: "https://context7.com/docs/api-guide" },
  ] },
  { id: "skillsmp", label: "SkillsMP", pages: [
    { label: "Home", url: "https://skillsmp.com/" },
    { label: "Docs", url: "https://skillsmp.com/docs/api" },
  ] },
  { id: "webclaw", label: "Webclaw (local)", local: true, pages: [] },
  { id: "pi-packages", label: "Pi Packages", local: true, pages: [] },
];

// Providers with grounded native usage retrieval.
const USAGE_PROVIDERS = ["tavily", "linkup"] as const;
type UsageProvider = typeof USAGE_PROVIDERS[number];

// --- Status projection (local config only; no network) ---------------------
// Required vs optional comes from registry capabilities (a provider with declared credentials
// needs one; Context7 declares none, so a missing key only means anonymous use). Native and
// Pi Packages resolve to source "none": local, no account or key required.
export function buildStatusLines(registry: AdapterRegistry, config: WebConfig): string[] {
  const lines: string[] = [];
  for (const provider of Object.keys(config.providers).sort()) {
    const status = credentialStatus(provider, config);
    const required = (registry.get(provider)?.capability.credentials.length ?? 0) > 0;
    lines.push(`- ${provider}: ${describeCredential(status, required)}`);
  }
  return lines;
}

function describeCredential(status: CredentialStatus, required: boolean): string {
  if (!status.enabled) return "disabled";
  if (status.source === "inline") return "enabled · inline key present in web.yaml";
  if (status.source === "environment") return `enabled · ${status.envName} present`;
  if (status.source === "none") return "enabled · local, no account or key required";
  return required
    ? `enabled · credential missing (set ${status.envName ?? "a credential"}, or use “Set an API key”)`
    : `enabled · works anonymously (optional ${status.envName ?? "key"} not set)`;
}

// --- Browser open ----------------------------------------------------------
export function resolveOpenCommand(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

async function openUrl(pi: ExtensionAPI, ctx: ExtensionCommandContext, url: string): Promise<void> {
  const { command, args } = resolveOpenCommand(process.platform, url);
  let result: ExecResult;
  try {
    result = await pi.exec(command, args);
  } catch {
    ctx.ui.notify(`Could not open ${url} automatically. Visit it in your browser.`, "warning");
    return;
  }
  // A resolved exec is not proof of success: a nonzero exit code or a killed process means the
  // browser did not open. Report only the public URL (never stdout/stderr) and return to the menu.
  if (result.code !== 0 || result.killed) {
    ctx.ui.notify(`Could not open ${url} automatically. Visit it in your browser.`, "warning");
    return;
  }
  ctx.ui.notify(`Opened ${url}`, "info");
}

// --- Masked secret input (composes pi-tui Input; never renders plaintext) --
// Composes the stock Input for all typing/paste/backspace/keybinding handling and reads only its
// value length; the wrapper render emits one bullet per character plus Pi's zero-width
// CURSOR_MARKER (width-safe via sliceByColumn/truncateToWidth) and never calls Input.render
// (which would expose plaintext). The Input reference is released on dispose.
//
// Pi's Input silently strips CR/LF from pasted text. The approved contract is REJECTION, not
// sanitation, so the wrapper independently tracks bracketed-paste boundaries on the raw chunks
// it receives and records whether a line break was pasted — without ever storing or exposing the
// content. Submission Enter arrives outside a paste and is never counted.
export interface MaskedEntry { value: string; containedLineBreak: boolean }

export function maskedSecretInput(ctx: ExtensionCommandContext, prompt: string): Promise<MaskedEntry | undefined> {
  return ctx.ui.custom<MaskedEntry | undefined>((tui, theme, _kb, done) => {
    let input: Input | null = new Input();
    input.focused = true;
    let settled = false;
    let inPaste = false;
    let containedLineBreak = false;
    const settle = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      done(value === undefined ? undefined : { value, containedLineBreak });
    };
    input.onSubmit = (value) => settle(value);
    input.onEscape = () => settle(undefined);

    return {
      render(width: number): string[] {
        const value = input?.getValue() ?? "";
        const label = theme.fg("muted", `${prompt}  (masked · Enter=save · Esc=cancel)`);
        const masked = sliceByColumn("•".repeat(value.length), 0, Math.max(0, width)) + (input?.focused ? CURSOR_MARKER : "");
        return [truncateToWidth(label, width, ""), masked];
      },
      handleInput(data: string): void {
        // While inside a bracketed paste, inspect this raw chunk's paste segment for CR/LF and
        // discard it immediately — pasted content is never retained outside pi-tui's Input.
        // A submission Enter arrives outside a paste and is never scanned.
        let chunk = data;
        const start = chunk.indexOf("\x1b[200~");
        if (start !== -1) { inPaste = true; chunk = chunk.slice(start + 6); }
        if (inPaste) {
          const end = chunk.indexOf("\x1b[201~");
          const segment = end === -1 ? chunk : chunk.slice(0, end);
          if (/[\r\n]/.test(segment)) containedLineBreak = true;
          if (end !== -1) inPaste = false;
        }
        input?.handleInput(data);
        tui.requestRender();
      },
      invalidate(): void {
        input?.invalidate();
      },
      dispose(): void {
        input = null;
      },
    };
  });
}

// --- Config read/mutation --------------------------------------------------
// Reads web.yaml, returning empty ONLY when the file is absent (ENOENT → fresh config). Any other
// read failure (permissions, directory, I/O) rethrows so callers abort without mutating the
// existing config.
export function readConfigRaw(configPath: string): string {
  try {
    return readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

// Builds the next web.yaml text, preserving comments/formatting via parseDocument and setting
// only providers.<id>.apiKey. Malformed YAML is rejected rather than silently rewritten.
export function buildNextConfigYaml(existingRaw: string, providerId: string, apiKey: string): string {
  const doc = parseDocument(existingRaw);
  if (doc.errors.length > 0) throw new Error("web.yaml is not valid YAML");
  doc.setIn(["providers", providerId, "apiKey"], apiKey);
  return doc.toString();
}

// Removes only providers.<id>.apiKey, preserving everything else (comments included).
export function removeInlineKeyYaml(existingRaw: string, providerId: string): string {
  const doc = parseDocument(existingRaw);
  if (doc.errors.length > 0) throw new Error("web.yaml is not valid YAML");
  doc.deleteIn(["providers", providerId, "apiKey"]);
  return doc.toString();
}

// Minimal filesystem seam so failure/cleanup behavior is testable without touching real state.
export interface AtomicFs {
  lstatSync(path: string): { isFile(): boolean; isSymbolicLink(): boolean };
  mkdirSync(path: string, options: { recursive: boolean; mode: number }): unknown;
  chmodSync(path: string, mode: number): void;
  writeFileSync(path: string, data: string, options: { encoding: "utf8"; mode: number; flag: "wx" }): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
}

const defaultAtomicFs: AtomicFs = {
  lstatSync: (path) => lstatSync(path),
  mkdirSync: (path, options) => mkdirSync(path, options),
  chmodSync: (path, mode) => chmodSync(path, mode),
  writeFileSync: (path, data, options) => writeFileSync(path, data, options),
  renameSync: (oldPath, newPath) => renameSync(oldPath, newPath),
  unlinkSync: (path) => unlinkSync(path),
};

// Distinguishes "nothing reached disk" from "the rename landed but a later step (final chmod)
// failed", so callers never claim "nothing was written" when the target may have changed.
export class AtomicWriteError extends Error {
  readonly renamed: boolean;
  constructor(message: string, renamed: boolean) {
    super(message);
    this.name = "AtomicWriteError";
    this.renamed = renamed;
  }
}

// Maps a write failure to a secret-free user message. A post-rename failure warns that the target
// may have changed and its permissions need inspection; a pre-rename failure is a clean no-write.
export function describeWriteFailure(error: unknown, configPath: string): { text: string; type: "warning" | "error" } {
  if (error instanceof AtomicWriteError && error.renamed) {
    return {
      text: `The update reached ${configPath}, but a later permission step failed. The file may have changed and its permissions need inspection (expected mode 0600).`,
      type: "warning",
    };
  }
  return { text: `Failed to update ${configPath}. Nothing was written.`, type: "error" };
}

// Atomic write at mode 0600. Refuses a target that exists but is not a regular file (symlink,
// directory, …); creates a missing parent at mode 0700; creates a unique same-directory temp
// EXCLUSIVELY (O_EXCL via flag "wx", random name) at 0600, renames it over the target, and
// re-asserts 0600. Pre-rename failures unlink the temp and throw renamed:false; a final-chmod
// failure after the rename throws renamed:true (the target changed). No backup is ever written.
export function writeConfigAtomic(configPath: string, text: string, fsImpl: AtomicFs = defaultAtomicFs): void {
  try {
    const target = fsImpl.lstatSync(configPath);
    if (target.isSymbolicLink() || !target.isFile()) throw new Error("refusing to write web.yaml: target is not a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AtomicWriteError((error as Error).message, false);
  }
  const dir = dirname(configPath);
  let dirExisted = true;
  try { fsImpl.lstatSync(dir); } catch { dirExisted = false; }
  try {
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!dirExisted) fsImpl.chmodSync(dir, 0o700);
  } catch (error) {
    throw new AtomicWriteError((error as Error).message, false);
  }

  const tmp = join(dir, `.${basename(configPath)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  let renamed = false;
  try {
    fsImpl.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fsImpl.chmodSync(tmp, 0o600);
    fsImpl.renameSync(tmp, configPath);
    renamed = true;
    fsImpl.chmodSync(configPath, 0o600);
  } catch (error) {
    if (!renamed) {
      try { fsImpl.unlinkSync(tmp); } catch { /* temp may never have been created; nothing to remove */ }
    }
    throw new AtomicWriteError((error as Error).message, renamed);
  }
}

// --- Native usage retrieval (explicit; Tavily + Linkup only) ---------------
// Truthful formatting: only fields actually returned are shown. Absent usage is never defaulted
// to zero and no fabricated "0/∞" is rendered; a null limit is the documented "unlimited" signal.
function usageRatio(used: number | undefined, limit: number | null | undefined): string | undefined {
  if (used === undefined) return undefined;
  if (limit === null) return `${used}/unlimited`;
  if (limit === undefined) return `${used}`;
  return `${used}/${limit}`;
}

export function formatTavilyUsage(usage: TavilyUsageResponse): string {
  const parts: string[] = [];
  const keyRatio = usageRatio(usage.key?.usage, usage.key?.limit);
  if (keyRatio) parts.push(`key ${keyRatio} credits`);
  if (usage.account) {
    if (usage.account.currentPlan) parts.push(`plan ${usage.account.currentPlan}`);
    const planRatio = usageRatio(usage.account.planUsage, usage.account.planLimit);
    if (planRatio) parts.push(`plan usage ${planRatio}`);
    const paygoRatio = usageRatio(usage.account.paygoUsage, usage.account.paygoLimit);
    if (paygoRatio) parts.push(`pay-as-you-go ${paygoRatio}`);
  }
  return parts.length ? parts.join(" · ") : "no usage fields returned";
}

function noOpContext(credential: string | undefined, config: WebConfig, signal?: AbortSignal): OpContext {
  return { credential, timeoutMs: config.limits.timeoutMs, signal, persist() { /* usage is never persisted */ } };
}

// Runs the selected providers' usage concurrently and independently; one provider being
// unconfigured or failing never suppresses another's line. `only` scopes a provider-specific
// check to a single account call; omitted, it checks both. Errors are reported by failure class
// with the credential redacted; raw transport messages are never echoed. Never automatic/persisted.
export async function gatherUsage(config: WebConfig, signal?: AbortSignal, fetchImpl: FetchLike = fetch, only?: UsageProvider): Promise<string[]> {
  const tasks: Promise<string>[] = [];
  if (!only || only === "tavily") tasks.push(tavilyUsageLine(config, signal, fetchImpl));
  if (!only || only === "linkup") tasks.push(linkupUsageLine(config, signal, fetchImpl));
  return Promise.all(tasks);
}

async function tavilyUsageLine(config: WebConfig, signal: AbortSignal | undefined, fetchImpl: FetchLike): Promise<string> {
  const credential = resolveCredential("tavily", config);
  if (!credential) return "- tavily: no credential configured";
  try {
    return `- tavily: ${formatTavilyUsage(await tavilyGetUsage(credential, noOpContext(credential, config, signal), fetchImpl))}`;
  } catch (error) {
    return `- tavily: usage unavailable (${safeFailure(error, credential)})`;
  }
}

async function linkupUsageLine(config: WebConfig, signal: AbortSignal | undefined, fetchImpl: FetchLike): Promise<string> {
  const credential = resolveCredential("linkup", config);
  if (!credential) return "- linkup: no credential configured";
  try {
    const balance = await linkupGetBalance(noOpContext(credential, config, signal), fetchImpl);
    return `- linkup: ${balance.balance} credits remaining`;
  } catch (error) {
    return `- linkup: usage unavailable (${safeFailure(error, credential)})`;
  }
}

function safeFailure(error: unknown, credential?: string): string {
  if (error instanceof ProviderError) return redactCredential(error, credential).failureClass;
  return "error";
}

// --- Shell environment diagnosis & safe persistence (presence-only) --------
// ADR 2.4/4.1: the user approved bounded local inspection of recognized variable assignments and
// command-owned shell persistence. Shell-file bytes stay inside this command; only variable names
// and source paths may leave it. Never source, evaluate, execute, or import discovered assignments.
// New secret files use mode 0600, new private directories use 0700, and no secret backup is made.
// A pre-existing target that cannot be updated safely stops with an honest partial-state message.
export type ShellId = "fish" | "zsh" | "bash";

export interface ShellDescriptor {
  id: ShellId;
  scanFiles: string[];   // bounded, documented startup/private files scanned for NAMES only
  secretFile: string;    // command-owned dedicated private secret file (mode 0600)
  needsLoader: boolean;  // zsh/bash: add one guarded loader line; fish conf.d auto-loads
  loaderTarget?: string; // rc file the guarded loader line is appended to (zsh/bash)
}

// Infer the supported shell ONLY from $SHELL's basename; a shell is never executed to detect it.
export function detectShell(env: NodeJS.ProcessEnv = process.env): ShellId | undefined {
  const shell = env.SHELL;
  if (!shell) return undefined;
  const name = basename(shell);
  return name === "fish" || name === "zsh" || name === "bash" ? name : undefined;
}

function configRoot(env: NodeJS.ProcessEnv): string {
  return env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
}

// The dedicated secret file lives inside the fish conf.d scan set, so keys the command writes are
// also what presence detection later reports. Zsh/bash scan conventional startup files plus the
// private secret file; their loader line is guarded and idempotent.
export function shellDescriptor(id: ShellId, env: NodeJS.ProcessEnv = process.env): ShellDescriptor {
  const root = configRoot(env);
  const home = env.HOME || homedir();
  if (id === "fish") return {
    id,
    scanFiles: [join(root, "fish", "config.fish"), join(root, "fish", "conf.d", "90-jeito-secrets.fish")],
    secretFile: join(root, "fish", "conf.d", "90-jeito-secrets.fish"),
    needsLoader: false,
  };
  if (id === "zsh") return {
    id,
    scanFiles: [join(home, ".zshrc"), join(home, ".zshenv"), join(home, ".zprofile"), join(root, "jeito", "secrets.zsh")],
    secretFile: join(root, "jeito", "secrets.zsh"),
    needsLoader: true,
    loaderTarget: join(home, ".zshrc"),
  };
  return {
    id,
    scanFiles: [join(home, ".bashrc"), join(home, ".bash_profile"), join(home, ".profile"), join(root, "jeito", "secrets.bash")],
    secretFile: join(root, "jeito", "secrets.bash"),
    needsLoader: true,
    loaderTarget: join(home, ".bashrc"),
  };
}

function isShellEnvName(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

// Recognized provider env variable NAMES (never values) for the current config, e.g. EXA_API_KEY.
function recognizedEnvNames(config: WebConfig): string[] {
  const names = new Set<string>();
  for (const provider of Object.keys(config.providers)) {
    const envName = credentialStatus(provider, config).envName;
    if (isShellEnvName(envName)) names.add(envName);
  }
  return [...names].sort();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// True only when a line exports envName. Fish `set -q NAME` is a query, not an assignment.
function assignsVariable(id: ShellId, envName: string, line: string): boolean {
  const name = escapeRegExp(envName);
  if (id !== "fish") return new RegExp(`^\\s*(?:export\\s+)?${name}=`).test(line);
  const match = line.match(new RegExp(`^\\s*set\\s+((?:-\\S+\\s+)*)${name}(?:\\s|$)`));
  if (!match) return false;
  return match[1].trim().split(/\s+/).some((flag) => flag === "--export" || /^-[^-]*x/.test(flag));
}

export interface EnvPresence { envName: string; file?: string }

// Presence-only scan of the bounded scanFiles: per recognized name, whether it is assigned and in
// which file. Only the name and file path leave this function — never a value. Unreadable files are
// skipped; comment lines are ignored.
export function scanShellEnvPresence(descriptor: ShellDescriptor, envNames: string[]): EnvPresence[] {
  const found = new Map<string, string>();
  for (const file of descriptor.scanFiles) {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      for (const envName of envNames) {
        if (!found.has(envName) && assignsVariable(descriptor.id, envName, line)) found.set(envName, file);
      }
    }
  }
  return envNames.map((envName) => ({ envName, file: found.get(envName) }));
}

// Single-quote a value and replace embedded quotes with the portable close/escape/reopen form.
// CR/LF/NUL are rejected because they cannot be represented as one safe generated assignment.
export function quoteForShell(value: string): string | undefined {
  if (/[\r\n\0]/.test(value)) return undefined;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const SECRET_HEADER = "# jeito websift provider secrets — managed by /web-setup. Mode 0600. Do not commit.";

function buildSecretAssignment(id: ShellId, envName: string, quoted: string): string {
  return id === "fish" ? `set -gx ${envName} ${quoted}` : `export ${envName}=${quoted}`;
}

// Replaces OR appends exactly the assignment for envName, preserving every other line verbatim
// (other assignments and comments). A fresh file gets the managed header. No backup is written.
export function updateSecretFile(existingRaw: string, id: ShellId, envName: string, quoted: string): string {
  const assignment = buildSecretAssignment(id, envName, quoted);
  const body = existingRaw.replace(/\n$/, "");
  const lines = body.length ? body.split("\n") : [];
  let replaced = false;
  const out = lines.map((line) => {
    if (!replaced && assignsVariable(id, envName, line)) { replaced = true; return assignment; }
    return line;
  });
  if (!replaced) {
    if (out.length === 0) out.push(SECRET_HEADER);
    out.push(assignment);
  }
  return out.join("\n") + "\n";
}

export const LOADER_MARKER = "# jeito-secrets-loader (managed by /web-setup)";

// Guarded so an absent secret file never errors the shell; the marker keeps insertion idempotent.
export function buildLoaderLine(secretFile: string): string {
  const quoted = quoteForShell(secretFile);
  if (!quoted) throw new Error("shell secret path contains an unsupported control character");
  return `${LOADER_MARKER}\n[ -f ${quoted} ] && . ${quoted}`;
}

// Idempotent loader insertion: no-op once the marker is present, otherwise appends the guarded line.
export function ensureLoaderLine(rcRaw: string, loaderLine: string): string {
  if (rcRaw.includes(LOADER_MARKER)) return rcRaw;
  const body = rcRaw.replace(/\n$/, "");
  return (body.length ? body + "\n\n" : "") + loaderLine + "\n";
}

// Writes exactly one env assignment into the dedicated private secret file via the shared atomic
// discipline (mode 0600, parent 0700, symlink/non-regular refusal, no backup). Throws on unsafe targets.
function writeEnvSecret(descriptor: ShellDescriptor, envName: string, quoted: string): void {
  const existing = readConfigRaw(descriptor.secretFile); // "" on ENOENT, rethrows other read failures
  writeConfigAtomic(descriptor.secretFile, updateSecretFile(existing, descriptor.id, envName, quoted));
}

// Appends the guarded loader to the conventional rc file. Existing permissions are restored after
// the atomic replacement; an absent rc is created private. Symlink/non-regular targets are refused.
function ensureRcLoader(descriptor: ShellDescriptor): void {
  if (!descriptor.needsLoader || !descriptor.loaderTarget) return;
  const target = descriptor.loaderTarget;
  let originalMode: number | undefined;
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("rc target is not a regular file");
    originalMode = stat.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const raw = readConfigRaw(target);
  const next = ensureLoaderLine(raw, buildLoaderLine(descriptor.secretFile));
  if (next === raw) return;
  writeConfigAtomic(target, next);
  if (originalMode !== undefined) chmodSync(target, originalMode);
}

// --- Explicit one-provider liveness smoke ----------------------------------
// NEVER automatic: the command previews provider + one representative operation + max attempts=1 +
// an egress/cost warning and requires confirmation before dispatch. It calls the selected adapter
// DIRECTLY (no routing, fallback, retry, persistence, content display, or sibling calls) and reports
// only provider + operation + success/failure class + elapsed — never result text/snippets or
// credentials. Tavily/Linkup USAGE is a separate action and never substitutes for liveness.
export interface LivenessProbe { operation: Operation; description: string; intent: Intent }
export interface LivenessResult { provider: string; operation: Operation; ok: boolean; failureClass?: FailureClass; durationMs: number }

function searchProbe(kind: SearchIntent["kind"]): SearchIntent {
  return { operation: "search", query: "jeito liveness probe", kind, depth: "fast", strategy: "single", fallbackOnExplicit: false, count: 1 };
}

// One minimal contract-valid probe per provider: search count=1 (xsearch social; Linkup fast),
// native fetch of one stable URL, Context7 resolve, SkillsMP/Pi Packages lookup limit=1.
export const LIVENESS_PROBES: Record<string, LivenessProbe> = {
  serper: { operation: "search", description: "search (count=1)", intent: searchProbe("general") },
  exa: { operation: "search", description: "search (count=1)", intent: searchProbe("general") },
  tavily: { operation: "search", description: "search (count=1)", intent: searchProbe("general") },
  linkup: { operation: "search", description: "search (count=1, depth=fast)", intent: searchProbe("general") },
  xsearch: { operation: "search", description: "social search (count=1)", intent: searchProbe("social") },
  webclaw: { operation: "fetch", description: "fetch one stable URL", intent: { operation: "fetch", url: "https://example.com/", mode: "page" } },
  context7: { operation: "lookup", description: "resolve one library", intent: { operation: "lookup", source: "context7", query: "react", library: "react", page: 1, limit: 1, context7: { mode: "resolve" } } },
  skillsmp: { operation: "lookup", description: "catalog lookup (limit=1)", intent: { operation: "lookup", source: "skillsmp", query: "test", page: 1, limit: 1 } },
  "pi-packages": { operation: "lookup", description: "package lookup (limit=1)", intent: { operation: "lookup", source: "pi-packages", query: "pi", page: 1, limit: 1 } },
};

// Exactly one direct adapter call (max attempts=1). Credentialed providers with no resolved
// credential are reported missing_credential WITHOUT any network call. Errors map to a failure class
// with the credential redacted; result content is discarded, never returned.
export async function runLivenessProbe(providerId: string, registry: AdapterRegistry, config: WebConfig, signal?: AbortSignal): Promise<LivenessResult> {
  const probe = LIVENESS_PROBES[providerId];
  const adapter = registry.get(providerId);
  if (!probe || !adapter) return { provider: providerId, operation: "search", ok: false, failureClass: "policy", durationMs: 0 };
  if (signal?.aborted) return { provider: providerId, operation: probe.operation, ok: false, failureClass: "aborted", durationMs: 0 };
  const credential = resolveCredential(providerId, config);
  if ((adapter.capability.credentials.length ?? 0) > 0 && !credential) {
    return { provider: providerId, operation: probe.operation, ok: false, failureClass: "missing_credential", durationMs: 0 };
  }
  const ctx: OpContext = { credential, timeoutMs: config.limits.timeoutMs, signal, persist() { /* liveness is never persisted */ } };
  const started = Date.now();
  try {
    const op = adapter[probe.operation] as unknown as ((intent: Intent, ctx: OpContext) => Promise<unknown>) | undefined;
    if (!op) return { provider: providerId, operation: probe.operation, ok: false, failureClass: "policy", durationMs: Date.now() - started };
    await op.call(adapter, probe.intent, ctx);
    return { provider: providerId, operation: probe.operation, ok: true, durationMs: Date.now() - started };
  } catch (error) {
    const failureClass = error instanceof ProviderError ? redactCredential(error, credential).failureClass : "network";
    return { provider: providerId, operation: probe.operation, ok: false, failureClass, durationMs: Date.now() - started };
  }
}

// --- Command registration --------------------------------------------------
export function registerWebSetup(pi: ExtensionAPI, registry: AdapterRegistry): void {
  pi.registerCommand("web-setup", {
    description: "Local provider setup: credential status, provider pages, masked API-key entry/removal (inline or shell config), shell-env diagnosis, explicit one-provider liveness, and Tavily/Linkup usage (no network on open)",
    handler: async (_args, ctx) => {
      const configPath = join(getAgentDir(), "web.yaml");
      for (;;) {
        const config = loadConfig(configPath);
        ctx.ui.notify([
          "jeito websift — provider setup",
          "(status is local config only; not a reachability check)",
          "",
          ...buildStatusLines(registry, config),
          "",
          "Environment variables are the recommended way to provide keys.",
        ].join("\n"), "info");

        const choice = await ctx.ui.select("Provider", [
          ...PROVIDER_PAGES.map((entry) => entry.label),
          "Diagnose shell environment (presence only)",
          "Run a liveness check (one provider)",
          "Check usage (Tavily + Linkup)",
          "Exit",
        ]);
        if (!choice || choice === "Exit") return;
        if (choice === "Diagnose shell environment (presence only)") { await diagnoseShellFlow(ctx, configPath); continue; }
        if (choice === "Run a liveness check (one provider)") { await livenessFlow(ctx, registry, configPath); continue; }
        if (choice === "Check usage (Tavily + Linkup)") { await checkUsageFlow(ctx, configPath); continue; }
        const entry = PROVIDER_PAGES.find((candidate) => candidate.label === choice);
        if (entry) await providerMenu(pi, ctx, entry, configPath);
      }
    },
  });
}

// Per-provider action menu. Every option is applicable-only: page links from the catalog, set or
// replace (when a credential env exists), remove (only when an inline key is present), usage
// (Tavily/Linkup only), and Back to the main menu. Local/no-account providers get a notice only.
async function providerMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext, entry: ProviderCatalogEntry, configPath: string): Promise<void> {
  if (entry.local) {
    ctx.ui.notify(`${entry.label} is local: no account, API key, or usage — it works out of the box.`, "info");
    await ctx.ui.select(entry.label, ["Back"]);
    return;
  }
  const shellId = detectShell();
  const configuredEnvName = shellId ? credentialStatus(entry.id, loadConfig(configPath)).envName : undefined;
  const persistEnvName = isShellEnvName(configuredEnvName) ? configuredEnvName : undefined;
  const persistLabel = shellId && persistEnvName ? `Persist ${persistEnvName} to ${shellId} config (masked)` : undefined;
  for (;;) {
    const config = loadConfig(configPath);
    const status = credentialStatus(entry.id, config);
    const options: string[] = entry.pages.map((page) => `Open “${page.label}”`);
    const setLabel = status.source === "inline" ? "Replace the inline API key (masked)" : "Set an API key (masked)";
    if (status.envName) options.push(setLabel);
    if (shellId && status.envName && persistLabel) options.push(persistLabel);
    if (status.source === "inline") options.push("Remove the inline API key");
    const isUsageProvider = (USAGE_PROVIDERS as readonly string[]).includes(entry.id);
    if (isUsageProvider) options.push("Check usage");
    options.push("Back");

    const action = await ctx.ui.select(entry.label, options);
    if (!action || action === "Back") return;

    const page = entry.pages.find((candidate) => `Open “${candidate.label}”` === action);
    if (page) { await openUrl(pi, ctx, page.url); continue; }
    if (action === setLabel) await setApiKeyFlow(ctx, entry, configPath);
    else if (persistLabel && action === persistLabel) await persistEnvKeyFlow(ctx, entry, configPath);
    else if (action === "Remove the inline API key") await removeApiKeyFlow(ctx, entry, configPath);
    else if (action === "Check usage" && isUsageProvider) await checkUsageFlow(ctx, configPath, entry.id as UsageProvider);
  }
}

async function setApiKeyFlow(ctx: ExtensionCommandContext, entry: ProviderCatalogEntry, configPath: string): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Masked key entry needs the interactive TUI. Use /skill:websift-setup or edit web.yaml by hand.", "warning");
    return;
  }
  const status = credentialStatus(entry.id, loadConfig(configPath));
  const envName = status.envName ?? "the provider environment variable";
  ctx.ui.notify([
    `Recommendation: set ${envName} as an environment variable instead of storing a key here.`,
    `If you continue, the ${entry.label} key is stored in PLAINTEXT at ${configPath} (mode 0600).`,
    "An inline key in web.yaml takes precedence over any environment variable.",
  ].join("\n"), "warning");

  const proceed = status.source === "inline"
    ? await ctx.ui.confirm("Replace the existing inline key?", `${entry.label} already has an inline key in ${configPath}. This replaces it. Continue?`)
    : await ctx.ui.confirm("Enter a masked API key?", `Continue to type or paste the ${entry.label} key in a masked prompt?`);
  if (!proceed) { ctx.ui.notify("Cancelled — nothing written.", "info"); return; }

  const entered = await maskedSecretInput(ctx, `${entry.label} API key`);
  if (entered === undefined) { ctx.ui.notify("Cancelled — nothing written.", "info"); return; }
  if (entered.containedLineBreak) { ctx.ui.notify("Rejected — the pasted key contained a line break. Nothing written.", "warning"); return; }
  const apiKey = entered.value; // preserve the exact accepted value; never trim or mutate it
  if (!apiKey.trim()) { ctx.ui.notify("Rejected — the key was blank. Nothing written.", "warning"); return; }
  if (/[\r\n]/.test(apiKey)) { ctx.ui.notify("Rejected — the key contained a line break. Nothing written.", "warning"); return; }

  let existingRaw: string;
  try {
    existingRaw = readConfigRaw(configPath);
  } catch {
    ctx.ui.notify(`Could not read ${configPath}. Check its permissions, then retry. Nothing was written.`, "error");
    return;
  }
  let next: string;
  try {
    next = buildNextConfigYaml(existingRaw, entry.id, apiKey);
  } catch {
    ctx.ui.notify(`Could not update ${configPath}: web.yaml is not valid YAML. Fix it, then retry. Nothing written.`, "error");
    return;
  }

  const preview = `providers.${entry.id}.apiKey: [redacted]`; // fixed literal; the secret is never serialized
  const confirmed = await ctx.ui.confirm("Store API key in plaintext?", `Writing to ${configPath}:\n  ${preview}\nMode 0600. Continue?`);
  if (!confirmed) { ctx.ui.notify("Cancelled — nothing written.", "info"); return; }

  try {
    writeConfigAtomic(configPath, next);
    ctx.ui.notify(`Wrote the ${entry.label} inline key to ${configPath} (mode 0600). Inline keys reload immediately on change; only environment-variable changes need a Pi restart.`, "info");
  } catch (error) {
    const failure = describeWriteFailure(error, configPath);
    ctx.ui.notify(failure.text, failure.type);
  }
}

async function removeApiKeyFlow(ctx: ExtensionCommandContext, entry: ProviderCatalogEntry, configPath: string): Promise<void> {
  const confirmed = await ctx.ui.confirm("Remove the inline API key?", `This removes providers.${entry.id}.apiKey from ${configPath}. Environment variables still apply. Continue?`);
  if (!confirmed) { ctx.ui.notify("Cancelled — nothing removed.", "info"); return; }

  let existingRaw: string;
  try {
    existingRaw = readConfigRaw(configPath);
  } catch {
    ctx.ui.notify(`Could not read ${configPath}. Check its permissions, then retry. Nothing was changed.`, "error");
    return;
  }
  if (!existingRaw.trim()) { ctx.ui.notify(`No config at ${configPath}; nothing to remove.`, "info"); return; }
  let next: string;
  try {
    next = removeInlineKeyYaml(existingRaw, entry.id);
  } catch {
    ctx.ui.notify(`Could not update ${configPath}: web.yaml is not valid YAML. Fix it, then retry. Nothing changed.`, "error");
    return;
  }

  try {
    writeConfigAtomic(configPath, next);
    ctx.ui.notify(`Removed the ${entry.label} inline key from ${configPath}. Reloads immediately on change.`, "info");
  } catch (error) {
    const failure = describeWriteFailure(error, configPath);
    ctx.ui.notify(failure.text, failure.type);
  }
}

async function checkUsageFlow(ctx: ExtensionCommandContext, configPath: string, only?: UsageProvider): Promise<void> {
  const config = loadConfig(configPath);
  const targets = only ? [only] : [...USAGE_PROVIDERS];
  if (!targets.some((provider) => resolveCredential(provider, config))) {
    ctx.ui.notify(only ? `No ${only} credential configured; nothing to check.` : "No Tavily or Linkup credential configured; nothing to check.", "info");
    return;
  }
  ctx.ui.notify("Checking usage…", "info");
  const lines = await gatherUsage(config, ctx.signal, undefined, only);
  ctx.ui.notify(["jeito websift — native usage (explicit check)", "", ...lines].join("\n"), "info");
}

// --- New setup-control-center flows -----------------------------------------

async function diagnoseShellFlow(ctx: ExtensionCommandContext, configPath: string): Promise<void> {
  const shellId = detectShell();
  if (!shellId) {
    ctx.ui.notify("Could not infer a supported shell from the environment. Supported: fish, zsh, bash.", "warning");
    return;
  }
  const descriptor = shellDescriptor(shellId);
  const config = loadConfig(configPath);
  const envNames = recognizedEnvNames(config);
  const presence = scanShellEnvPresence(descriptor, envNames);
  const lines: string[] = [
    `Detected shell: ${shellId}`,
    "",
    "Scanned files (bounded startup/private set):",
    ...descriptor.scanFiles.map((file) => `  - ${file}`),
    "",
    "Provider environment variable presence (names only, never values):",
  ];
  for (const entry of presence) {
    lines.push(entry.file ? `  - ${entry.envName}: present in ${entry.file}` : `  - ${entry.envName}: missing`);
  }
  lines.push("");
  lines.push("Recovery: restart Pi from the configured shell, or use masked setup above.");
  ctx.ui.notify(lines.join("\n"), "info");
}

async function livenessFlow(ctx: ExtensionCommandContext, registry: AdapterRegistry, configPath: string): Promise<void> {
  const config = loadConfig(configPath);
  const providerIds = Object.keys(config.providers).filter((id) => LIVENESS_PROBES[id]).sort();
  if (!providerIds.length) {
    ctx.ui.notify("No providers available for liveness checks.", "info");
    return;
  }
  const labels = providerIds.map((id) => `${id} (${LIVENESS_PROBES[id].description})`);
  labels.push("Back");
  const choice = await ctx.ui.select("Liveness check (one explicit call)", labels);
  if (!choice || choice === "Back") return;
  const providerId = providerIds[labels.indexOf(choice)];
  const probe = LIVENESS_PROBES[providerId];
  const confirmed = await ctx.ui.confirm(
    "Confirm one liveness call",
    `Provider: ${providerId}\nOperation: ${probe.description}\nExpected max provider attempts: 1\nThis will egress one request and may incur cost. Continue?`,
  );
  if (!confirmed) {
    ctx.ui.notify("Cancelled.", "info");
    return;
  }
  ctx.ui.notify(`Calling ${providerId}…`, "info");
  const result = await runLivenessProbe(providerId, registry, config, ctx.signal);
  const status = result.ok ? "ok" : `failed (${result.failureClass})`;
  ctx.ui.notify(`Liveness: ${providerId} · ${result.operation} → ${status} in ${result.durationMs}ms`, result.ok ? "info" : "warning");
}

async function persistEnvKeyFlow(ctx: ExtensionCommandContext, entry: ProviderCatalogEntry, configPath: string): Promise<void> {
  const shellId = detectShell();
  if (!shellId) {
    ctx.ui.notify("Could not infer a supported shell from the environment. Supported: fish, zsh, bash.", "warning");
    return;
  }
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Masked key entry needs the interactive TUI. Use /skill:websift-setup or edit shell config by hand.", "warning");
    return;
  }
  const descriptor = shellDescriptor(shellId);
  const status = credentialStatus(entry.id, loadConfig(configPath));
  const envName = status.envName;
  if (!isShellEnvName(envName)) {
    ctx.ui.notify(`${entry.label} has no shell-safe environment variable name configured. Use a name like EXA_API_KEY.`, "warning");
    return;
  }

  ctx.ui.notify([
    `This stores ${envName} for ${entry.label} in PLAINTEXT inside a command-owned private file:`,
    `  ${descriptor.secretFile}`,
    descriptor.needsLoader ? `A guarded loader line will be added to ${descriptor.loaderTarget} (idempotent, exact preview shown before write).` : "Fish conf.d auto-loads; no loader line needed.",
    "The value is accepted only by the masked local command and is never rendered or returned.",
  ].join("\n"), "warning");

  const proceed = await ctx.ui.confirm("Enter a masked API key?", `Continue to type or paste the ${entry.label} key in a masked prompt?`);
  if (!proceed) {
    ctx.ui.notify("Cancelled — nothing written.", "info");
    return;
  }

  const entered = await maskedSecretInput(ctx, `${entry.label} API key`);
  if (entered === undefined) {
    ctx.ui.notify("Cancelled — nothing written.", "info");
    return;
  }
  if (entered.containedLineBreak) {
    ctx.ui.notify("Rejected — the pasted key contained a line break. Nothing written.", "warning");
    return;
  }
  const apiKey = entered.value;
  if (!apiKey.trim()) {
    ctx.ui.notify("Rejected — the key was blank. Nothing written.", "warning");
    return;
  }
  if (/[\r\n]/.test(apiKey)) {
    ctx.ui.notify("Rejected — the key contained a line break. Nothing written.", "warning");
    return;
  }

  const quoted = quoteForShell(apiKey);
  if (quoted === undefined) {
    ctx.ui.notify("Rejected — the key contained a NUL byte, which cannot live in a shell string. Nothing written.", "warning");
    return;
  }

  const previewLines: string[] = [
    `Writing to ${descriptor.secretFile} (mode 0600):`,
    `  ${envName}=[redacted]`,
  ];
  if (descriptor.needsLoader && descriptor.loaderTarget) {
    previewLines.push("");
    previewLines.push(`Loader line in ${descriptor.loaderTarget} (exact):`);
    previewLines.push(`  ${buildLoaderLine(descriptor.secretFile)}`);
  }
  previewLines.push("");
  previewLines.push("Continue?");
  const confirmed = await ctx.ui.confirm("Store API key in shell config?", previewLines.join("\n"));
  if (!confirmed) {
    ctx.ui.notify("Cancelled — nothing written.", "info");
    return;
  }

  try {
    writeEnvSecret(descriptor, envName, quoted);
  } catch (error) {
    const failure = describeWriteFailure(error, descriptor.secretFile);
    ctx.ui.notify(failure.text, failure.type);
    return;
  }
  if (descriptor.needsLoader && descriptor.loaderTarget) {
    try {
      ensureRcLoader(descriptor);
    } catch {
      ctx.ui.notify([
        `Wrote ${envName} to ${descriptor.secretFile} (mode 0600), but could not update ${descriptor.loaderTarget}.`,
        "The key remains stored. Add this loader manually, then restart the shell:",
        buildLoaderLine(descriptor.secretFile),
      ].join("\n"), "warning");
      return;
    }
  }
  ctx.ui.notify(`Wrote ${envName} to ${descriptor.secretFile} (mode 0600). Restart your shell to load it.`, "info");
}
