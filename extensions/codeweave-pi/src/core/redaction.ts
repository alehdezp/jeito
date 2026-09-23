import { createHash } from "node:crypto";

export interface RedactionFinding {
  kind: "env_value" | "bearer_token" | "secret_assignment" | "api_key_like";
  name?: string;
  count: number;
}

export interface RedactionOptions {
  env?: Record<string, string | undefined>;
}

const SECRET_NAME = /(?:api[_-]?key|token|secret|password|passwd|pwd|credential|auth|private[_-]?key)/i;
const NON_SECRET_ENV_NAMES = new Set(["PWD", "OLDPWD"]);

const BEARER = /\bBearer\s+([A-Za-z0-9._~+\/-]{12,}={0,2})/g;
const ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|passwd|pwd|credential|auth)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["']?)([^"'\s,;}\[]{8,})(\3)/gi;
const API_KEY_LIKE = /\b(?:sk|pk|ghp|gho|github_pat|xox[baprs]|AIza)[A-Za-z0-9_=-]{16,}\b/g;

export function redactText(value: unknown, options: RedactionOptions = {}): string {
  let text = String(value ?? "");
  for (const [name, secret] of secretEnvValues(options.env ?? process.env)) {
    text = replaceLiteral(text, secret, marker(name, secret));
  }
  text = text.replace(BEARER, (_match, secret) => `Bearer ${marker("bearer", secret)}`);
  text = text.replace(ASSIGNMENT, (_match, name, separator, quote, secret, close) => `${name}${separator}${quote}${marker(name, secret)}${close}`);
  text = text.replace(API_KEY_LIKE, secret => marker("api-key-like", secret));
  return text;
}

export function redactJson<T>(value: T, options: RedactionOptions = {}): T {
  if (typeof value === "string") return redactText(value, options) as T;
  if (Array.isArray(value)) return value.map(item => redactJson(item, options)) as T;
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) output[key] = redactJson(item, options);
    return output as T;
  }
  return value;
}

export function scanTextForSecrets(value: unknown, options: RedactionOptions = {}): RedactionFinding[] {
  const text = String(value ?? "");
  const findings = new Map<string, RedactionFinding>();
  for (const [name, secret] of secretEnvValues(options.env ?? process.env)) {
    const count = countLiteral(text, secret);
    if (count > 0) addFinding(findings, "env_value", name, count);
  }
  countRegex(text, BEARER, () => addFinding(findings, "bearer_token", undefined, 1));
  countRegex(text, ASSIGNMENT, match => addFinding(findings, "secret_assignment", String(match[1] ?? "secret"), 1));
  countRegex(text, API_KEY_LIKE, () => addFinding(findings, "api_key_like", undefined, 1));
  return [...findings.values()].sort((a, b) => `${a.kind}:${a.name ?? ""}`.localeCompare(`${b.kind}:${b.name ?? ""}`));
}

function secretEnvValues(env: Record<string, string | undefined>): [string, string][] {
  return Object.entries(env)
    .filter(([name, value]) => isSecretEnvName(name) && typeof value === "string" && value.length >= 8)
    .sort((a, b) => b[1]!.length - a[1]!.length) as [string, string][];
}

function isSecretEnvName(name: string): boolean {
  const normalized = String(name).trim().toUpperCase();
  if (NON_SECRET_ENV_NAMES.has(normalized)) return false;
  return SECRET_NAME.test(name);
}

function replaceLiteral(text: string, secret: string, replacement: string): string {
  return text.split(secret).join(replacement);
}

function countLiteral(text: string, needle: string): number {
  if (!needle || !text.includes(needle)) return 0;
  return text.split(needle).length - 1;
}

function countRegex(text: string, regex: RegExp, onMatch: (match: RegExpExecArray) => void): void {
  regex.lastIndex = 0;
  for (let match = regex.exec(text); match; match = regex.exec(text)) onMatch(match);
}

function addFinding(findings: Map<string, RedactionFinding>, kind: RedactionFinding["kind"], name: string | undefined, count: number): void {
  const key = `${kind}:${name ?? ""}`;
  const existing = findings.get(key);
  if (existing) existing.count += count;
  else findings.set(key, { kind, name, count });
}

function marker(name: string, secret: string): string {
  const safeName = String(name).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
  return `[REDACTED name=${safeName} len=${secret.length} sha256=${digest(secret)}]`;
}

function digest(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 12);
}
