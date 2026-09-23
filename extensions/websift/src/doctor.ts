import { statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { credentialStatus, getAgentDir, loadConfig } from "./config.ts";
import type { AdapterRegistry } from "./registry.ts";
import type { Operation } from "./types.ts";
import { parseWebclawVersion, runWebclaw, webclawVersionSupported, WEBCLAW_MAX_VERSION_EXCLUSIVE, WEBCLAW_MIN_VERSION } from "./webclaw-spawn.ts";

export interface DoctorReport {
  text: string;
  warnings: string[];
  operations: Record<Operation, string[]>;
}

export async function buildDoctorReport(registry: AdapterRegistry, path = join(getAgentDir(), "web.yaml")): Promise<DoctorReport> {
  const config = loadConfig(path);
  const warnings = [...config.warnings];
  const operations: Record<Operation, string[]> = { search: [], fetch: [], answer: [], lookup: [] };
  const providerLines = registry.adapters.map((adapter) => {
    const status = credentialStatus(adapter.capability.id, config);
    const required = adapter.capability.credentials.length > 0;
    const available = status.enabled && (!required || status.present);
    if (available) for (const operation of adapter.capability.operations) operations[operation].push(adapter.capability.id);
    let state = "disabled";
    if (available && status.source === "inline") state = "available · inline credential";
    else if (available && status.source === "environment") state = `available · ${status.envName} present`;
    else if (available && status.envName) state = `available anonymously · optional ${status.envName} missing`;
    else if (available) state = "available · no credential required";
    else if (status.enabled) state = `unavailable · set ${status.envName ?? "a credential"}`;
    return `- ${adapter.capability.id}: ${state}`;
  });

  // webclaw binary presence: the local extraction engine is an environment fact, not a
  // network call. A missing binary breaks the fetch lane, so it is a doctor warning.
  const binary = await runWebclaw(["--version"], { timeoutMs: 5_000 });
  if (binary.ok) {
    const version = parseWebclawVersion(binary.stdout);
    if (version && webclawVersionSupported(version)) {
      providerLines.push(`- webclaw binary: found (webclaw ${version}) — inside the supported range ${WEBCLAW_MIN_VERSION} <= v < ${WEBCLAW_MAX_VERSION_EXCLUSIVE}`);
    } else {
      providerLines.push(`- webclaw binary: found (${binary.stdout.trim().split("\n")[0] ?? "version unknown"}) — OUTSIDE the supported range ${WEBCLAW_MIN_VERSION} <= v < ${WEBCLAW_MAX_VERSION_EXCLUSIVE}: URL fetches (page/crawl/map/llm_answer) are blocked until aligned`);
      warnings.push("webclaw_version_mismatch");
    }
  } else {
    providerLines.push("- webclaw binary: MISSING — brew install 0xmassi/webclaw/webclaw (macOS) or the GitHub-release/cargo path in https://github.com/0xMassi/webclaw#install (Linux/Windows)");
    warnings.push("webclaw_binary_missing");
  }

  let configMode: number | undefined;
  try { configMode = statSync(path).mode; } catch { configMode = undefined; }
  const hasInlineCredential = Object.values(config.providers).some((provider) => Boolean(provider.apiKey?.trim()));
  if (hasInlineCredential && configMode !== undefined && (configMode & 0o077) !== 0) warnings.push("config_permissions_too_open");
  if (hasInlineCredential && configMode === undefined) warnings.push("config_permissions_unknown");
  const configState = configMode === undefined ? "missing; defaults active" : config.warnings.includes("config_parse_error") ? "invalid YAML; defaults active" : "loaded";
  const operationLines = (Object.entries(operations) as [Operation, string[]][]).map(([operation, providers]) => `- ${operation}: ${providers.length ? providers.join(", ") : "unavailable"}`);
  const fixes = [
    ...(config.warnings.includes("config_parse_error") ? [`Fix ${path}, then run /web-doctor again.`] : []),
    ...(warnings.includes("config_permissions_too_open") ? [`Run chmod 600 ${path}.`] : []),
    ...(warnings.includes("webclaw_binary_missing") ? ["Install webclaw: `brew install 0xmassi/webclaw/webclaw` (macOS) or the Linux/Windows path in https://github.com/0xMassi/webclaw#install, then restart Pi."] : []),
    ...(warnings.includes("webclaw_version_mismatch") ? [`Align webclaw into ${WEBCLAW_MIN_VERSION} <= v < ${WEBCLAW_MAX_VERSION_EXCLUSIVE}: \`brew upgrade 0xmassi/webclaw/webclaw\` (macOS) or install a build from https://github.com/0xMassi/webclaw/releases, then run /web-doctor again. A failed version check re-reads automatically on the next web_fetch — no restart needed.`] : []),
    ...(Object.values(operations).some((providers) => !providers.length) ? ["Run /skill:websift-setup for exact environment-variable instructions."] : []),
    "Restart Pi after changing environment variables or limits.responseBytes; other web.yaml settings reload on modification.",
  ];
  return {
    warnings,
    operations,
    text: [`jeito websift doctor`, `Config: ${path} · ${configState}`, "", "Providers:", ...providerLines, "", "Operations:", ...operationLines, "", "Next:", ...fixes.map((fix) => `- ${fix}`)].join("\n"),
  };
}

export function registerWebDoctor(pi: ExtensionAPI, registry: AdapterRegistry): void {
  pi.registerCommand("web-doctor", {
    description: "Report jeito websift config health, credential presence, webclaw binary presence and version conformance, and operation coverage without network calls",
    handler: async (_args, ctx) => {
      const report = await buildDoctorReport(registry);
      ctx.ui.notify(report.text, report.warnings.length ? "warning" : "info");
    },
  });
}
