// ADR-001.003 owns GCF model-visible structured output; provider-native JSON remains in tool details.
import { encodeGeneric } from "@blackwell-systems/gcf";
import { ProviderError } from "./failures.ts";

interface GcfRecordsOptions {
  comments?: string[];
  maxChars: number;
  metadata?: Record<string, unknown>;
}

function jsonValue(value: unknown): unknown {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("value is not representable as JSON");
    return JSON.parse(encoded);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderError("unavailable", `GCF output requires JSON-compatible data: ${message}`);
  }
}

function addComments(document: string, comments: string[]): string {
  if (comments.length === 0) return document;
  const newline = document.indexOf("\n");
  if (newline < 0) throw new ProviderError("unavailable", "GCF encoder returned a document without a header line");
  const rendered = comments.flatMap((comment) => comment.split(/\r?\n/u)).map((line) => `# ${line}`).join("\n");
  return `${document.slice(0, newline + 1)}${rendered}\n${document.slice(newline + 1)}`;
}

/** Encode JSON-shaped records without splitting a record to satisfy the model-visible character budget. */
export function encodeGcfRecords(records: unknown[], options: GcfRecordsOptions): string {
  const totalRecords = records.length;
  const comments = options.comments ?? [];

  for (let shownRecords = totalRecords; shownRecords >= 0; shownRecords -= 1) {
    const payload = jsonValue({
      ...(options.metadata ?? {}),
      totalRecords,
      shownRecords,
      omittedRecords: totalRecords - shownRecords,
      records: records.slice(0, shownRecords),
    });

    try {
      const document = addComments(encodeGeneric(payload), comments);
      if (document.length <= options.maxChars) return document;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderError("unavailable", `GCF encoding failed: ${message}`);
    }
  }

  throw new ProviderError("unavailable", `GCF metadata exceeds the ${options.maxChars}-character model-visible output budget`);
}
