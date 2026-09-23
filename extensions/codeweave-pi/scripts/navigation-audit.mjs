#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { scanTextForSecrets } from "../src/core/redaction.ts";

const REQUIRED_RECORD_FIELDS = ["undo", "verification", "writes", "command"];

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { path: process.cwd(), log: undefined, since: undefined, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--path" || flag === "-C") args.path = value();
    else if (flag === "--log") args.log = value();
    else if (flag === "--since") args.since = value();
    else if (flag === "--json") args.json = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

export async function summarizeNavigationAudit(argv = process.argv.slice(2), options = {}) {
  const args = Array.isArray(argv) ? parseArgs(argv) : argv;
  if (args.help) return { help: true, text: helpText() };

  const root = path.resolve(args.path ?? process.cwd());
  const logPath = path.resolve(root, args.log ?? ".pi/navigation-setup.log.jsonl");
  const now = options.now ?? new Date();
  const since = args.since ? parseSince(args.since, now) : undefined;
  if (!existsSync(logPath)) {
    return envelope({
      status: "warning",
      summary: `No navigation audit log found at ${relativeDisplay(root, logPath)}.`,
      next_actions: ["Run npm run nav:prepare -- --path <repo> --auto to create setup audit records, or pass --log PATH."],
      artifacts: [relativeDisplay(root, logPath)],
      root,
      logPath,
      since,
      records: [],
      malformedLines: [],
      validationErrors: [],
      privacyFindings: [],
    });
  }

  const text = await readFile(logPath, "utf8");
  const parsed = parseJsonl(text);
  const records = parsed.records.filter(item => !since || recordTime(item.record) >= since.cutoffMs);
  const privacyText = since ? records.map(item => item.raw).join("\n") : text;
  const privacyFindings = scanTextForSecrets(privacyText, { env: options.env ?? process.env });
  const validationErrors = validateRecords(records);
  const counts = summarizeRecords(records);
  // F1: warn only on CURRENTLY failing lanes; historically-failed-but-resolved
  // lanes no longer force a warning (they are listed separately in resolved_failed_lanes).
  const hasFailures = counts.failedLanes.length > 0;
  const hasIssues = parsed.malformedLines.length > 0 || validationErrors.length > 0;
  const hasPrivacyFindings = privacyFindings.length > 0;
  const status = hasPrivacyFindings ? "error" : hasIssues || hasFailures ? "warning" : "success";
  const privacyCount = privacyFindings.reduce((total, finding) => total + finding.count, 0);
  const resolvedNote = counts.resolvedFailedLanes.length ? `, ${counts.resolvedFailedLanes.length} historically-failed lane(s) now resolved` : "";
  const summary = `${records.length} audit record${records.length === 1 ? "" : "s"}; completed ${counts.byStatus.completed}, failed ${counts.byStatus.failed}, skipped ${counts.byStatus.skipped}, guided ${counts.byPolicy.guided}, blocked ${counts.byPolicy.blocked}; malformed ${parsed.malformedLines.length}, schema issues ${validationErrors.length}, unredacted secret findings ${privacyCount}${resolvedNote}.`;

  return envelope({
    status,
    summary,
    next_actions: nextActions({ hasIssues, hasFailures, hasPrivacyFindings, records }),
    artifacts: [relativeDisplay(root, logPath)],
    root,
    logPath,
    since,
    records,
    malformedLines: parsed.malformedLines,
    validationErrors,
    privacyFindings,
    counts,
  });
}

function parseJsonl(text) {
  const records = [];
  const malformedLines = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    if (!raw.trim()) continue;
    const line = index + 1;
    try {
      records.push({ line, raw, record: JSON.parse(raw) });
    } catch (error) {
      malformedLines.push({ line, error: String(error?.message ?? error) });
    }
  }
  return { records, malformedLines };
}

function validateRecords(records) {
  const errors = [];
  for (const item of records) {
    for (const field of REQUIRED_RECORD_FIELDS) {
      if (missingField(item.record, field)) errors.push({ line: item.line, field, message: `record missing ${field}` });
    }
  }
  return errors;
}

function missingField(record, field) {
  if (!record || typeof record !== "object" || !(field in record)) return true;
  const value = record[field];
  if (field === "command") return !Array.isArray(value) || value.length === 0;
  if (field === "undo" || field === "writes") return !Array.isArray(value);
  if (field === "verification") return !value || typeof value !== "object";
  return false;
}

function summarizeRecords(records) {
  const byStatus = countBy(records, item => String(item.record.status ?? "unknown"));
  const byPolicy = countBy(records, item => String(item.record.policy ?? "unknown"));
  const enabledLanes = unique(records.filter(item => item.record.enabledLane === true).map(item => laneLabel(item.record)));
  const failedLaneSet = new Set(records.filter(item => item.record.status === "failed" || item.record.verification?.passed === false && item.record.status !== "skipped").map(item => laneLabel(item.record)));
  // F1: a historically-failed lane is "resolved" if its most recent record is not a
  // failure (records are append-only/chronological, last write wins). This stops audit
  // from warning forever about old failures that were later repaired (doctor clean).
  const lastStatusByLane = new Map();
  for (const item of records) lastStatusByLane.set(laneLabel(item.record), String(item.record.status ?? "unknown"));
  const RESOLVED = new Set(["completed", "ready_no_prepare", "skipped", "unknown"]);
  const resolvedFailedLanes = [...failedLaneSet].filter(label => RESOLVED.has(lastStatusByLane.get(label) ?? ""));
  const currentFailedLanes = [...failedLaneSet].filter(label => !RESOLVED.has(lastStatusByLane.get(label) ?? ""));
  return {
    byStatus: withDefaults(byStatus, ["completed", "failed", "skipped", "ready_no_prepare", "unknown"]),
    byPolicy: withDefaults(byPolicy, ["auto", "guided", "blocked", "unknown"]),
    enabledLanes,
    failedLanes: currentFailedLanes,
    resolvedFailedLanes,
  };
}

function countBy(records, keyFn) {
  const counts = {};
  for (const item of records) counts[keyFn(item)] = (counts[keyFn(item)] ?? 0) + 1;
  return counts;
}

function withDefaults(counts, keys) {
  const output = { ...counts };
  for (const key of keys) output[key] ??= 0;
  return output;
}

function laneLabel(record) {
  return [record.lane, record.backend].filter(Boolean).join(":") || "unknown";
}

function unique(values) {
  return [...new Set(values)].sort();
}

function recordTime(record) {
  const ms = Date.parse(String(record.time ?? ""));
  return Number.isFinite(ms) ? ms : 0;
}

function parseSince(value, now) {
  const text = String(value).trim();
  const relative = /^(\d+(?:\.\d+)?)(m|h|d)$/i.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2].toLowerCase()];
    return { input: text, cutoffIso: new Date(now.getTime() - amount * unitMs).toISOString(), cutoffMs: now.getTime() - amount * unitMs };
  }
  const ms = Date.parse(text);
  if (Number.isFinite(ms)) return { input: text, cutoffIso: new Date(ms).toISOString(), cutoffMs: ms };
  throw new Error(`invalid --since value ${JSON.stringify(value)}; use 24h, 30m, 7d, or an ISO timestamp`);
}

function nextActions({ hasIssues, hasFailures, hasPrivacyFindings, records }) {
  const actions = [];
  if (!records.length) actions.push("Run nav:prepare --auto or choose a log file with --log.");
  if (hasPrivacyFindings) actions.push("Treat the audit log as unsafe evidence until unredacted secret findings are removed or regenerated through redacted setup output.");
  if (hasIssues) actions.push("Fix malformed JSONL lines or records missing undo, verification, writes, or command before treating the audit as production evidence.");
  if (hasFailures) actions.push("Inspect failed lanes and rerun only after resolving the recorded command/verification failure.");
  if (!actions.length) actions.push("Audit log is structurally valid and has no unredacted secret findings; use enabled_lanes as prepared-intelligence candidates and keep live reads as proof.");
  return actions;
}

function envelope(input) {
  const counts = input.counts ?? summarizeRecords(input.records);
  return {
    status: input.status,
    summary: input.summary,
    next_actions: input.next_actions,
    artifacts: input.artifacts,
    recovery: {
      safe_retry: "npm run nav:audit -- --path <repo> --json",
      stop_conditions: ["audit log path is wrong", "malformed JSONL remains", "records lack undo/verification/writes/command", "unredacted secret findings remain", "failed setup records remain unresolved"],
    },
    root: input.root,
    logPath: input.logPath,
    since: input.since ? { input: input.since.input, cutoffIso: input.since.cutoffIso } : undefined,
    counts,
    enabled_lanes: counts.enabledLanes,
    failed_lanes: counts.failedLanes,
    resolved_failed_lanes: counts.resolvedFailedLanes ?? [],
    malformed_lines: input.malformedLines,
    validation_errors: input.validationErrors,
    privacy_findings: input.privacyFindings ?? [],
  };
}

function relativeDisplay(root, file) {
  const rel = path.relative(root, file).replace(/\\/g, "/");
  return rel && !rel.startsWith("..") ? rel : file;
}

function helpText() {
  return `Usage: node scripts/navigation-audit.mjs [--path DIR] [--log FILE] [--since 24h|7d|ISO] [--json]\n\nReads .pi/navigation-setup.log.jsonl without mutating it, summarizes setup outcomes, reports malformed lines, flags records missing undo/verification/writes/command, and reports unredacted secret findings without printing secret values.`;
}

function renderText(result) {
  if (result.help) return result.text;
  const lines = [
    `Navigation audit: ${result.status}`,
    result.summary,
    `Log: ${relativeDisplay(result.root, result.logPath)}`,
    `Enabled lanes: ${result.enabled_lanes.length ? result.enabled_lanes.join(", ") : "none"}`,
    `Failed lanes: ${result.failed_lanes.length ? result.failed_lanes.join(", ") : "none"}`,
  ];
  for (const item of result.malformed_lines) lines.push(`Malformed line ${item.line}: ${item.error}`);
  for (const item of result.validation_errors) lines.push(`Schema issue line ${item.line}: ${item.field}`);
  for (const item of result.privacy_findings) lines.push(`Privacy finding: ${item.kind}${item.name ? ` ${item.name}` : ""} (${item.count})`);
  lines.push(`Next: ${result.next_actions.join("; ")}`);
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  summarizeNavigationAudit().then(result => {
    if (parseArgs().json && !result.help) console.log(JSON.stringify(result, null, 2));
    else console.log(renderText(result));
    if (result.status === "error") process.exitCode = 2;
  }).catch(error => {
    console.error(`ERROR: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
