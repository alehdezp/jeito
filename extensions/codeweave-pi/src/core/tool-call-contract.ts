import { harnessEnvelope, referenceTokenCount } from "./harness-result.ts";

export interface ToolCallValidationDetails {
  kind: "tool-call-validation";
  tool: string;
  issue: string;
  accepted: string[];
  guidance: string[];
  received?: unknown;
}

export class ToolCallValidationError extends Error {
  readonly details: Omit<ToolCallValidationDetails, "kind" | "tool">;

  constructor(issue: string, options: { accepted?: string[]; guidance?: string[]; received?: unknown } = {}) {
    super(issue);
    this.name = "ToolCallValidationError";
    this.details = {
      issue,
      accepted: options.accepted ?? [],
      guidance: options.guidance ?? [],
      received: options.received,
    };
  }
}

export function asToolCallValidationError(error: unknown, options: { accepted?: string[]; guidance?: string[]; received?: unknown } = {}): ToolCallValidationError {
  if (!(error instanceof ToolCallValidationError)) return new ToolCallValidationError(error instanceof Error ? error.message : String(error), options);
  return new ToolCallValidationError(error.details.issue, {
    accepted: error.details.accepted.length ? error.details.accepted : options.accepted,
    guidance: [...new Set([...error.details.guidance, ...(options.guidance ?? [])])],
    received: error.details.received ?? options.received,
  });
}
export function invalidToolCallResult(tool: string, error: ToolCallValidationError) {
  const validation: ToolCallValidationDetails = { kind: "tool-call-validation", tool, ...error.details };
  const text = [
    `INVALID CALL: ${tool}`,
    `Issue: ${validation.issue}`,
    validation.received !== undefined ? `Received: ${safeValue(validation.received)}` : "",
    validation.accepted.length ? "Accepted forms:" : "",
    ...validation.accepted.map(item => `- ${item}`),
    validation.guidance.length ? "Guidance:" : "",
    ...validation.guidance.map(item => `- ${item}`),
    "Execution: nothing ran; no project evidence was produced.",
  ].filter(Boolean).join("\n");
  return {
    content: [{ type: "text" as const, text }],
    details: {
      validation,
      envelope: harnessEnvelope({
        status: "error",
        summary: `${tool} call was rejected before execution.`,
        next_actions: validation.guidance,
        artifacts: [],
        diagnostics: [validation.issue],
      }),
    },
  };
}

/** Routine navigation diagnostics must not bypass the complete-reply ceiling. */
export function boundedInvalidToolCallResult(tool: string, error: ToolCallValidationError) {
  const result = invalidToolCallResult(tool, error);
  if (referenceTokenCount(result.content[0].text) <= 4_000) return result;
  // Do not retain the oversized rejected input in details as a second escape.
  return invalidToolCallResult(tool, new ToolCallValidationError(
    "The detailed diagnostic exceeds the 4,000-reference-token reply ceiling and was withheld.",
    { guidance: ["Use only the documented parameters and a concise request."] },
  ));
}

export function withToolCallNormalizations<T extends { content?: Array<{ type?: string; text?: string }>; details?: Record<string, unknown> }>(result: T, normalizations: string[], boundEcho = false): T {
  if (!normalizations.length) return result;
  // Raw padding in a valid enum can dominate both the reply and tokenization
  // cost. Bounded tools retain the correction, not an enormous input echo.
  const unique = [...new Set(normalizations.map(note => boundEcho && note.length > 500
    ? "Oversized normalization detail omitted; canonical arguments used" : note))];
  const first = result.content?.find(item => item?.type === "text");
  if (first && typeof first.text === "string") first.text = `${first.text}\n\nCall normalization: ${unique.join("; ")}.`;
  result.details ??= {};
  result.details.callNormalizations = unique;
  return result;
}

export function normalizedEnum(value: unknown, label: string, allowed: readonly string[], normalizations: string[]): string {
  const authored = typeof value === "string" ? value.trim() : "";
  const normalized = authored.toLowerCase();
  const match = allowed.find(item => item.toLowerCase() === normalized);
  if (!match) {
    throw new ToolCallValidationError(`${label} must be one of: ${allowed.join(", ")}.`, {
      received: value,
      guidance: [`Use the exact ${label} value shown in the tool schema.`],
    });
  }
  if (authored !== match) normalizations.push(`${label} ${JSON.stringify(value)} → ${JSON.stringify(match)}`);
  return match;
}

export function normalizedInteger(value: unknown, label: string, defaultValue: number, min: number, max: number, normalizations: string[]): number {
  if (value === undefined) return defaultValue;
  const number = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof number !== "number" || !Number.isInteger(number) || number < min || number > max) {
    throw new ToolCallValidationError(`${label} must be an integer from ${min} to ${max}.`, {
      received: value,
      guidance: [`Use a whole number between ${min} and ${max}.`],
    });
  }
  if (typeof value === "string") normalizations.push(`${label} numeric string → ${number}`);
  return number;
}

function safeValue(value: unknown): string {
  try {
    const rendered = JSON.stringify(value);
    return rendered && rendered.length > 500 ? `${rendered.slice(0, 500)}…` : rendered ?? String(value);
  } catch {
    return String(value);
  }
}
