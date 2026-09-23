import type { NativeOutput } from "./pi-nav-native.ts";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

let referenceTokenizer: Tiktoken | undefined;
/** Count complete model-visible text; source token spellings are not controls. */
export function referenceTokenCount(text: string): number {
  referenceTokenizer ??= new Tiktoken(o200kBase);
  return referenceTokenizer.encode(text, [], []).length;
}

const MAX_MODEL_TEXT_BYTES = 128 * 1024;
const MAX_MODEL_DETAILS_BYTES = 256 * 1024;

const PRIVATE_EVIDENCE_KEYS = new Set([
  "source_claims",
  "sourceSnapshots",
  "raw_digest",
  "rawDigest",
  "file_hash",
  "fileHash",
  "proof_bytes",
  "source_bytes",
]);

const PRIVATE_EVIDENCE_KEY_PATTERN = /^(?:source_(?:snippet|text|code|content|bytes)|raw_source|file_content|content_bytes|proof_(?:text|content|bytes|payload)|snapshot_bytes)$/i;

function isPrivateEvidenceKey(key: string): boolean {
  return PRIVATE_EVIDENCE_KEYS.has(key) || PRIVATE_EVIDENCE_KEY_PATTERN.test(key);
}

/** Remove private proof payloads recursively before model-facing or persisted output. */
export function stripPrivateEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPrivateEvidence);
  if (!value || typeof value !== "object") return value;
  const visible: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (isPrivateEvidenceKey(key)) continue;
    visible[key] = stripPrivateEvidence(item);
  }
  return visible;
}

export type HarnessStatus = "success" | "warning" | "error";

export interface HarnessEnvelope {
  status: HarnessStatus;
  summary: string;
  next_actions: string[];
  artifacts: string[];
  diagnostics?: string[];
}

export function harnessEnvelope(params: HarnessEnvelope): HarnessEnvelope {
  return {
    status: params.status,
    summary: params.summary,
    next_actions: params.next_actions,
    artifacts: params.artifacts,
    diagnostics: params.diagnostics?.length ? params.diagnostics : undefined,
  };
}

export function nativeToolResult(
  text: string,
  native: NativeOutput["structured"],
  envelope: HarnessEnvelope,
  details: Record<string, unknown> = {},
) {
  const modelText = String(text ?? "");
  const textBytes = utf8ByteLength(modelText);
  if (textBytes > MAX_MODEL_TEXT_BYTES) {
    return oversizedToolResult(native, textBytes, "text");
  }

  const safeDetails = stripPrivateEvidence(details) as Record<string, unknown>;
  const safeNative = stripPrivateEvidence(native) as NativeOutput["structured"];
  const safeEnvelope = stripPrivateEvidence(envelope) as HarnessEnvelope;
  const modelDetails = { ...safeDetails, envelope: safeEnvelope, native: safeNative };
  const detailsBytes = utf8ByteLength(JSON.stringify(modelDetails));
  if (detailsBytes > MAX_MODEL_DETAILS_BYTES) {
    return oversizedToolResult(native, detailsBytes, "structured metadata");
  }

  return {
    content: [{ type: "text" as const, text: modelText }],
    details: modelDetails,
  };
}

function oversizedToolResult(native: NativeOutput["structured"], actualBytes: number, component: string) {
  const operation = typeof native?.operation === "string" ? native.operation : "native tool";
  const diagnostic = `${component} exceeded the model-facing safety ceiling; oversized payload withheld`;
  return {
    content: [{
      type: "text" as const,
      text: `ERROR: ${operation} response was withheld by the model-facing output safety ceiling (${actualBytes} bytes). Narrow the scope or continue from a bounded cursor. No oversized payload was returned.`,
    }],
    details: {
      envelope: harnessEnvelope({
        status: "error",
        summary: "Oversized tool response was withheld before entering model context.",
        next_actions: ["Narrow the target or use a bounded continuation."],
        artifacts: [],
        diagnostics: [diagnostic],
      }),
      native: {
        schemaVersion: native?.schemaVersion,
        operation: native?.operation,
        completeness: native?.completeness,
        diagnostics: [...(Array.isArray(native?.diagnostics) ? native.diagnostics.slice(0, 8) : []), diagnostic],
      },
    },
  };
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
