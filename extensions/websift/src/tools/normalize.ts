// ponytail: alias/tolerance layer — reuses fetch tolerant doctrine, no new dep
// Keep strict core but alias leaf keys before validation-enforced failure.

import { ProviderError } from "../failures.ts";

export function normMode(mode: unknown): unknown {
  if (typeof mode === "string") return mode.trim().toLowerCase();
  if (Array.isArray(mode)) return mode.map((m) => (typeof m === "string" ? m.trim().toLowerCase() : m));
  return mode;
}
