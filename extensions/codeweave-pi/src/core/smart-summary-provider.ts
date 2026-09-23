export type SummaryInputKind = "file" | "directory";

export interface SummaryInput {
  cwd: string;
  absolutePath: string;
  displayPath: string;
  kind: SummaryInputKind;
  text?: string;
  lines?: string[];
  sizeBytes?: number;
  extension?: string;
}

export type SummaryEntryKind =
  | "import"
  | "function"
  | "class"
  | "type"
  | "heading"
  | "config"
  | "file"
  | "directory"
  | "text";

export interface SummaryEntry {
  start?: number;
  end?: number;
  label: string;
  kind?: SummaryEntryKind;
  children?: SummaryEntry[];
  confidence?: "high" | "medium" | "low";
  /** Internal canonical Pi read target for directory/file candidates. Never rendered as a backend id. */
  targetPath?: string;
  note?: string;
}

export interface SummaryResult {
  title: string;
  entries: SummaryEntry[];
  totalLines?: number;
  totalEntries?: number;
  note?: string;
  truncated?: boolean;
  providerName?: string;
  /** Directory overview: count of files among listed children. */
  fileCount?: number;
  /** Directory overview: count of directories among listed children. */
  dirCount?: number;
  /** Directory overview: generated/vendor/cache child dir names shown as skipped. */
  skippedEntries?: string[];
}

export interface SmartSummaryProvider {
  readonly name: string;
  readonly priority: number;
  canHandle(input: SummaryInput): boolean;
  summarize(input: SummaryInput, signal: AbortSignal): Promise<SummaryResult | null>;
}

export interface RunSummaryProviderOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_PROVIDER_TIMEOUT_MS = 1_000;

export async function runSummaryProvider(
  provider: SmartSummaryProvider,
  input: SummaryInput,
  options: RunSummaryProviderOptions = {},
): Promise<SummaryResult | null> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS);
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) return null;
  options.signal?.addEventListener("abort", abortFromParent, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => {
      controller.abort(new Error(`summary provider timed out after ${timeoutMs}ms`));
      resolve(null);
    }, timeoutMs);
  });

  const work = provider.summarize(input, controller.signal).catch(() => null);
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}
