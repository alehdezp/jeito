// ADR-002.002: failure classes and fallback eligibility are governed by docs/adr/0002-internal-architecture/0002-routing-and-failover.md.
import { credentialStatus, type WebConfig } from "./config.ts";
import type { FailureClass, Operation, RecoveryAdvice } from "./types.ts";

export class ProviderError extends Error {
  readonly failureClass: FailureClass;
  readonly retryAfterMs?: number;
  /** Site-owned recovery text. When present it replaces the generic class advice —
   *  the throw site knows the real fix (e.g. align the webclaw binary) and the
   *  generic "change the input" text would misdirect the caller. */
  readonly advice?: string;

  constructor(failureClass: FailureClass, message: string, retryAfterMs?: number, advice?: string) {
    super(message);
    this.name = "ProviderError";
    this.failureClass = failureClass;
    this.retryAfterMs = retryAfterMs;
    this.advice = advice;
  }
}

export function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export function classifyHttpFailure(status: number, retryAfter?: string | null, bodyText?: string | null): ProviderError {
  if (status === 401 || status === 403) return new ProviderError("auth", `Provider rejected credentials (${status})`);
  if (status === 429) return new ProviderError("rate_limited", "Provider rate limited the request", retryAfterMs(retryAfter ?? null));
  if (status >= 400 && status < 500 && bodyText && /credit|quota|billing|balance/i.test(bodyText)) {
    return new ProviderError("quota", `Provider rejected the request: ${bodyText.trim().slice(0, 200)} (${status})`, retryAfterMs(retryAfter ?? null));
  }
  if (status === 404 || status === 410) return new ProviderError("not_found", `Requested resource was not found (${status})`);
  if (status >= 500) return new ProviderError("network", `Provider request failed (${status})`);
  if (status >= 400) return new ProviderError("invalid_input", `Provider rejected the request (${status})`);
  return new ProviderError("network", `Unexpected provider response (${status})`);
}

export function mapFetchFailure(error: unknown, outerSignal?: AbortSignal): ProviderError {
  if (outerSignal?.aborted) return new ProviderError("aborted", "Request aborted");
  if (error instanceof ProviderError) return error;
  if (error instanceof DOMException && error.name === "AbortError") return new ProviderError("timeout", "Provider request timed out");
  return new ProviderError("network", error instanceof Error ? error.message : "Provider request failed");
}

/** Replace a resolved credential appearing in a mapped failure message with [redacted]. Shared by
 *  adapters whose credential can be echoed back by a transport error (Context7, SkillsMP, Serper).
 *  Not a general sanitizer — it scrubs only the exact known credential string. */
export function redactCredential(error: ProviderError, credential?: string): ProviderError {
  if (credential && error.message.includes(credential)) {
    return new ProviderError(error.failureClass, error.message.split(credential).join("[redacted]"), error.retryAfterMs, error.advice);
  }
  return error;
}

export function recoveryAdvice(error: ProviderError, provider: string, config: WebConfig, operation?: Operation): RecoveryAdvice {
  const base = classRecoveryAdvice(error, provider, config, operation);
  return error.advice ? { ...base, action: error.advice } : base;
}

function classRecoveryAdvice(error: ProviderError, provider: string, config: WebConfig, operation?: Operation): RecoveryAdvice {
  const credential = credentialStatus(provider, config);
  switch (error.failureClass) {
    case "missing_credential":
      return { retryable: false, action: credential.envName ? `Set ${credential.envName}, restart Pi, or run /skill:websift-setup.` : "Run /skill:websift-setup to configure an eligible provider." };
    case "auth":
      return { retryable: false, action: `Replace the ${provider} credential, restart Pi, then retry.` };
    case "rate_limited":
      return { retryable: true, retryAfterMs: error.retryAfterMs, action: error.retryAfterMs === undefined ? "Retry later; if the evidence is time-sensitive, deliberately choose another explicit evidence method." : `Retry after ${Math.ceil(error.retryAfterMs / 1000)} seconds.` };
    case "timeout":
      return { retryable: true, action: operation === "fetch" ? "Retry once; a smaller source or cached copy may complete faster." : "Retry once with a smaller result count (search) or faster depth (answer); otherwise deliberately choose another evidence method." };
    case "network":
    case "unavailable":
      return { retryable: true, action: operation === "fetch" ? "Retry once; if it still fails, return to discovery for another source or use a cached copy." : "Retry once; if it still fails, deliberately choose another evidence method." };
    case "empty":
      return { retryable: true, action: operation === "fetch" ? "The source returned no usable content; verify the URL/extraction mode or return to discovery for another source." : operation === "search" ? "Retry once with one changed lexical constraint; remove a constraint from a narrow query or add one to a broad query. Never repeat unchanged." : operation === "answer" ? "Reformulate the question or fetch decisive sources through $mini-research." : "Refine the input or choose another explicit evidence tool." };
    case "not_found":
      return { retryable: false, action: "Verify the source URL or return to discovery for its current canonical location; retrying the same URL unchanged will not help." };
    case "invalid_input": {
      const msg = error.message.toLowerCase();
      if (provider === "serper" && operation === "search" && (msg.includes("limit") || msg.includes("count") || msg.includes("num"))) {
        return { retryable: false, action: "web_search count is fixed at 10 — remove limit/count/num; keep 2–6 distinctive terms and at most one site:, quoted identity, year, or exclusion." };
      }
      if (msg.includes("source") && (msg.includes("required") || msg.includes("must have"))) {
        return { retryable: false, action: "source is required: use source:\"context7\" for versioned docs (with library), \"pi-packages\" for npm, or \"skillsmp\" for skills — e.g. {source:\"context7\", query:\"spawn\", library:\"tokio\"}." };
      }
      if (msg.includes("urls") || (msg.includes("url") && msg.includes("required"))) {
        return { retryable: false, action: "Provide urls — one URL string or array. Aliases url/link/sources are normalized to urls; schemeless hosts like example.com/docs/* are accepted." };
      }
      return { retryable: false, action: "Correct the parameters shown in the tool schema, then retry. Tip: pass one URL string, a comma-separated group, or an array — and country codes are lowercased (USA → usa)." };
    }
    case "policy":
      return { retryable: false, action: "Change the requested input or mode, or deliberately choose another explicit tool; retrying unchanged will not help." };
    case "quota":
      return { retryable: false, action: `The ${provider} account is out of credits — top up the account or deliberately choose another explicit provider tool.` };
    case "aborted":
      return { retryable: false, action: "The caller cancelled the request; retry only if the operation is still wanted." };
  }
}

export function mayFallback(failureClass: FailureClass, allowEmpty: boolean): boolean {
  if (failureClass === "empty") return allowEmpty;
  return ["unavailable", "missing_credential", "auth", "rate_limited", "timeout", "network", "quota"].includes(failureClass);
}
