#!/usr/bin/env node
import { lstatSync, readFileSync } from "node:fs";
import { homedir, platform, arch, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const SNAPSHOT_SCHEMA_VERSION = 1;
const MAX_INPUT_BYTES = 1_048_576;
const MAX_INSPECTED_FILE_BYTES = 1_048_576;
const MAX_INPUT_ENTRIES = 256;

function fail(code, message) {
  process.stderr.write(`${JSON.stringify({ code, message })}\n`);
  process.exitCode = 2;
}

function inputPath(value, cwd) {
  if (typeof value !== "string" || !value.trim()) throw new Error("path must be a non-empty string");
  const expanded = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function pathMetadata(path) {
  try {
    const stat = lstatSync(path);
    return {
      exists: true,
      kind: stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
      mode: (stat.mode & 0o777).toString(8).padStart(3, "0"),
      size: stat.size,
    };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { exists: false, kind: "missing", mode: null, size: null };
    return { exists: null, kind: "unreadable", mode: null, size: null };
  }
}

function readBounded(path, metadata) {
  if (!metadata.exists || metadata.kind !== "file") return { text: null, status: metadata.kind === "symlink" ? "symlink_refused" : metadata.kind };
  if (metadata.size > MAX_INSPECTED_FILE_BYTES) return { text: null, status: "too_large" };
  try {
    return { text: readFileSync(path, "utf8"), status: "readable" };
  } catch {
    return { text: null, status: "unreadable" };
  }
}

function yamlTopLevelVersion(text) {
  const match = text.match(/^version\s*:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*(?:#.*)?$/m);
  if (!match) return null;
  const value = match[1] ?? match[2] ?? match[3];
  return /^\d+$/.test(value) ? Number(value) : value;
}

function sortedEntries(entries) {
  return [...entries].sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function inspectConfig(entry, cwd, diagnostics) {
  const path = inputPath(entry.path, cwd);
  const metadata = pathMetadata(path);
  const read = readBounded(path, metadata);
  let declaredVersion = null;
  let versionStatus = metadata.exists ? read.status : "missing";
  let topLevelKeysOut = null;
  if (read.text !== null) {
    try {
      if (entry.format === "json") declaredVersion = JSON.parse(read.text)?.version ?? null;
      else if (entry.format === "yaml") declaredVersion = yamlTopLevelVersion(read.text);
      else throw new Error("format must be yaml or json");
      versionStatus = declaredVersion === null
        ? "undeclared"
        : entry.expectedVersion === undefined
          ? "observed"
          : declaredVersion === entry.expectedVersion ? "matching" : "mismatch";
    } catch {
      versionStatus = entry.format === "json" ? "malformed" : "unsupported_format";
    }
  } else if (read.status !== "missing") {
    versionStatus = read.status;
  }
  if (read.text !== null) topLevelKeysOut = topLevelKeys(read.text, entry.format);

  if (["mismatch", "malformed", "unreadable", "symlink_refused", "too_large", "unsupported_format"].includes(versionStatus)) {
    diagnostics.push(`config.${entry.id}.${versionStatus}`);
  }
  return { id: entry.id, path, ...metadata, declaredVersion, expectedVersion: entry.expectedVersion ?? null, versionStatus, topLevelKeys: topLevelKeysOut };
}

function topLevelKeys(text, format) {
  try {
    if (format === "json") return Object.keys(JSON.parse(text)).sort();
    const keys = [];
    for (const line of text.split("\n")) {
      const match = line.match(/^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:/);
      if (match && !keys.includes(match[1])) keys.push(match[1]);
      if (keys.length >= 64) break;
    }
    return keys.sort();
  } catch {
    return null;
  }
}

function inspectPackages(entries, cwd, diagnostics) {
  return sortedEntries(entries).map((entry) => {
    const path = inputPath(entry.path, cwd);
    const metadata = pathMetadata(path);
    const read = readBounded(path, metadata);
    let name = null;
    let version = null;
    if (read.text !== null) {
      try {
        const parsed = JSON.parse(read.text);
        name = typeof parsed.name === "string" ? parsed.name : null;
        version = typeof parsed.version === "string" ? parsed.version : null;
      } catch {
        diagnostics.push(`package.${entry.id}.malformed`);
      }
    }
    if (metadata.exists === null) diagnostics.push(`package.${entry.id}.unreadable`);
    return { id: entry.id, path, ...metadata, name, version };
  });
}

function inspectEntries(entries, cwd, diagnostics, prefix) {
  return sortedEntries(entries).map((entry) => {
    const path = inputPath(entry.path, cwd);
    const metadata = pathMetadata(path);
    if (metadata.exists === null) diagnostics.push(`${prefix}.${entry.id}.unreadable`);
    if (entry.expectedKind && metadata.exists && metadata.kind !== entry.expectedKind) diagnostics.push(`${prefix}.${entry.id}.unexpected_kind`);
    return { id: entry.id, path, expectedKind: entry.expectedKind ?? null, ...metadata };
  });
}

function inspectCommonShellConfigs(cwd, diagnostics) {
  const userConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return inspectEntries([
    { id: "zsh.user.environment", path: "~/.zshenv" },
    { id: "zsh.user.profile", path: "~/.zprofile" },
    { id: "zsh.user.rc", path: "~/.zshrc" },
    { id: "zsh.user.login", path: "~/.zlogin" },
    { id: "bash.user.profile", path: "~/.bash_profile" },
    { id: "bash.user.login", path: "~/.bash_login" },
    { id: "posix.user.profile", path: "~/.profile" },
    { id: "bash.user.rc", path: "~/.bashrc" },
    { id: "bash.user.logout", path: "~/.bash_logout" },
    { id: "fish.user.config", path: join(userConfig, "fish", "config.fish") },
  ], cwd, diagnostics, "shell_config");
}

function inspectPiConfig(cwd, diagnostics) {
  const agentDir = inputPath(process.env.PI_CODING_AGENT_DIR || "~/.pi/agent", cwd);
  const settingsPath = join(agentDir, "settings.json");
  return {
    settings: inspectConfig({ id: "settings", path: settingsPath, format: "json" }, cwd, diagnostics),
    files: inspectEntries([
      { id: "navigation", path: join(agentDir, "navigation.yaml") },
      { id: "web", path: join(agentDir, "web.yaml") },
      { id: "appendSystem", path: join(agentDir, "APPEND_SYSTEM.md") },
      { id: "toolConfig", path: join(agentDir, "tool.yaml") },
    ], cwd, diagnostics, "pi_config"),
  };
}

function inspectContentChecks(entries, cwd, diagnostics) {
  return sortedEntries(entries).map((entry) => {
    const path = inputPath(entry.path, cwd);
    const metadata = pathMetadata(path);
    const read = readBounded(path, metadata);
    const present = read.text === null ? false : read.text.includes(entry.needle);
    if (["unreadable", "symlink_refused", "too_large"].includes(read.status)) diagnostics.push(`loader.${entry.id}.${read.status}`);
    return { id: entry.id, path, ...metadata, markerPresent: present };
  });
}

async function readInput() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_INPUT_BYTES) throw new Error("input exceeds 1 MiB");
  }
  if (!raw.trim()) throw new Error("expected JSON input on stdin");
  return JSON.parse(raw);
}

try {
  const input = await readInput();
  if (input.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) throw new Error(`unsupported input schemaVersion ${input.schemaVersion}`);
  const cwd = inputPath(input.cwd ?? process.cwd(), process.cwd());
  const diagnostics = [];
  const credentialNames = [...new Set(input.credentials ?? [])].sort();
  if (credentialNames.some((name) => typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(name))) {
    throw new Error("credential names must match ^[A-Z][A-Z0-9_]*$");
  }
  const totalEntries = credentialNames.length
    + (input.configs?.length ?? 0) + (input.models?.length ?? 0) + (input.markers?.length ?? 0)
    + (input.loaderChecks?.length ?? 0) + (input.packages?.length ?? 0);
  if (totalEntries > MAX_INPUT_ENTRIES) throw new Error(`input exceeds ${MAX_INPUT_ENTRIES} total entries`);

  let loginShell = null;
  try { loginShell = userInfo().shell || null; } catch { diagnostics.push("shell.login.unavailable"); }

  const output = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    platform: { os: platform(), arch: arch(), node: process.versions.node },
    shell: { environment: process.env.SHELL || null, login: loginShell, configFiles: inspectCommonShellConfigs(cwd, diagnostics) },
    pi: inspectPiConfig(cwd, diagnostics),
    cwd: { path: cwd, navigationConfig: { path: join(cwd, ".pi-navigation.json"), ...pathMetadata(join(cwd, ".pi-navigation.json")) } },
    configs: sortedEntries(input.configs ?? []).map((entry) => inspectConfig(entry, cwd, diagnostics)),
    credentials: credentialNames.map((name) => ({ name, present: typeof process.env[name] === "string" && process.env[name].trim().length > 0 })),
    models: inspectEntries(input.models ?? [], cwd, diagnostics, "model"),
    markers: inspectEntries(input.markers ?? [], cwd, diagnostics, "marker"),
    packages: inspectPackages(input.packages ?? [], cwd, diagnostics),
    loaderChecks: inspectContentChecks(input.loaderChecks ?? [], cwd, diagnostics),
    diagnostics: [...new Set(diagnostics)].sort(),
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch {
  fail("invalid_input", "machine snapshot input is invalid");
}
