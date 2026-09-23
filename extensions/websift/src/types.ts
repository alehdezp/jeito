// ADR-002.001 owns normalized contracts; ADR-002.002 owns the FailureClass taxonomy; ADR-001.002 owns
// Source evidence semantics. See docs/adr/0002-internal-architecture/0001-layered-provider-architecture.md.
export type Operation = "search" | "fetch" | "answer" | "lookup";
export type FailureClass =
  | "unavailable"
  | "missing_credential"
  | "auth"
  | "rate_limited"
  | "timeout"
  | "network"
  | "empty"
  | "not_found"
  | "invalid_input"
  | "aborted"
  | "policy"
  | "quota";
export type EvidenceStatus = "lead" | "catalog" | "provider-citation" | "fetched";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  score?: number;
  sourceType?: string;
  serper?: SerperEnvelope;
  exa?: ExaSearchEnvelope;
  tavily?: TavilySearchEnvelope;
  xsearch?: XSearchEnvelope;
}

/** Search rows plus provider metadata that must survive even when a valid search returns zero rows. */
export type SearchResultList = SearchResult[] & {
  serper?: SerperEnvelope;
  exa?: ExaSearchEnvelope;
  xsearch?: XSearchEnvelope;
  tavily?: TavilySearchEnvelope;
};

export interface Source {
  url: string;
  requestedUrl?: string;
  title: string;
  passage?: string;
  fetched: boolean;
  evidenceStatus: EvidenceStatus;
  provider: string;
}

export interface Attempt {
  provider: string;
  operation: Operation;
  status: "ok" | "failed" | "skipped";
  durationMs: number;
  failureClass?: FailureClass;
  fallbackReason?: string;
}

export interface RecoveryAdvice {
  retryable: boolean;
  action: string;
  retryAfterMs?: number;
}

export interface ToolDetails {
  provider: string;
  attempts: Attempt[];
  sources: Source[];
  fallbackOccurred: boolean;
  cached: boolean;
  warnings: string[];
  recovery?: RecoveryAdvice;
  results?: SearchResult[];
  derivedCalls?: number;
  [key: string]: unknown;
}

export interface ExaSearchEnvelope {
  reportedCostUsd?: number;
  /** Compact local hard-filter verdict when domain or publication-bound controls were requested.
   *  Only safely observable constraints are enforced (hostname, *.wildcard, and hostname/path
   *  domain forms; inclusive parseable publication dates); everything else is reported
   *  unverifiable/not enforced. See exa.ts::adjudicateExaRows. */
  adjudication?: {
    providerCount: number;
    qualifyingCount: number;
    unverifiableCount: number;
    rejected: { reason: string; count: number }[];
    enforced: string[];
    notEnforced: string[];
  };
}

export interface TavilySearchEnvelope extends TavilyUsageEnvelope {}

export interface ExaSearchControls {
  searchType?: "keyword" | "neural" | "auto" | "hybrid" | "fast" | "instant" | "deep-lite" | "deep" | "deep-reasoning";
  category?: "company" | "publication" | "news" | "personal site" | "financial report" | "people";
  publishedWithinDays?: number;
  includeText?: string;
  excludeText?: string;
  userLocation?: string;
  moderation?: boolean;
  returnFullText?: boolean;
  maxCharacters?: number;
  systemPrompt?: string;
  additionalQueries?: string[];
  flags?: string[];
  outputSchema?: Record<string, unknown>;
}

export interface ExaAnswerControls {
  text?: boolean;
  userLocation?: string;
  systemPrompt?: string;
  outputSchema?: Record<string, unknown>;
}
// Tavily typed controls (internal; grounded in @tavily/core 0.7.6 and current official API docs — see docs/upstreams/tavily.md).
export interface TavilySearchControls {
  searchDepth?: "basic" | "advanced" | "fast" | "ultra-fast";
  topic?: "general" | "news" | "finance";
  days?: number;
  maxResults?: number;
  includeImages?: boolean;
  includeImageDescriptions?: boolean;
  includeAnswer?: boolean | "basic" | "advanced";
  includeRawContent?: false | "markdown" | "text";
  includeDomains?: string[];
  excludeDomains?: string[];
  maxTokens?: number;
  timeRange?: "year" | "month" | "week" | "day" | "y" | "m" | "w" | "d";
  chunksPerSource?: number;
  country?: string;
  startDate?: string;
  endDate?: string;
  autoParameters?: boolean;
  exactMatch?: boolean;
  timeout?: number;
  includeUsage?: boolean;
}


export interface TavilyExtractControls {
  includeImages?: boolean;
  extractDepth?: "basic" | "advanced";
  format?: "markdown" | "text";
  query?: string;
  chunksPerSource?: number;
  timeout?: number;
  includeUsage?: boolean;
}

export interface TavilyMapControls {
  url: string;
  instructions?: string;
  maxDepth?: number;
  maxBreadth?: number;
  limit?: number;
  selectPaths?: string[];
  selectDomains?: string[];
  excludePaths?: string[];
  excludeDomains?: string[];
  allowExternal?: boolean;
  timeout?: number;
}

export interface TavilyCrawlControls {
  url: string;
  instructions?: string;
  maxDepth?: number;
  maxBreadth?: number;
  limit: number;
  selectPaths?: string[];
  selectDomains?: string[];
  excludePaths?: string[];
  excludeDomains?: string[];
  allowExternal?: boolean;
  includeImages?: boolean;
  extractDepth?: "basic" | "advanced";
  format?: "markdown" | "text";
  chunksPerSource?: number;
  timeout?: number;
}

export interface TavilyResearchControls {
  input: string;
  model?: "mini" | "pro" | "auto";
  outputSchema?: Record<string, unknown>;
  citationFormat?: "numbered" | "mla" | "apa" | "chicago";
  includeDomains?: string[];
  excludeDomains?: string[];
  outputLength?: "short" | "standard" | "long";
  files?: Array<{ name: string; data: string; type?: "base64" }>;
  maxWaitMs: number;
  pollIntervalMs?: number;
}

// Tavily provider response types — preserve metadata for focused apprenticeship code.
export interface TavilyImage { url: string; description?: string }
export interface TavilyUsageEnvelope { usageCredits?: number; responseTime?: number; requestId?: string; malformedOmissionCount?: number }

export interface TavilySearchResponse {
  answer?: string;
  query: string;
  responseTime: number;
  images: TavilyImage[];
  results: Array<{
    title: string; url: string; content: string;
    rawContent?: string; score: number; publishedDate: string;
  }>;
  autoParameters?: Partial<TavilySearchControls>;
  usageCredits?: number;
  requestId?: string;
}

export interface TavilyExtractResponse {
  results: Array<{ url: string; title?: string | null; rawContent: string; images?: string[]; favicon?: string }>;
  failedResults: Array<{ url: string; error: string }>;
  responseTime: number;
  usageCredits?: number;
  requestId?: string;
}

export interface TavilyMapResponse {
  baseUrl: string;
  results: string[];
  responseTime: number;
  usageCredits?: number;
  requestId?: string;
}

export interface TavilyCrawlResponse {
  baseUrl: string;
  results: Array<{ url: string; rawContent: string; favicon?: string }>;
  responseTime: number;
  usageCredits?: number;
  requestId?: string;
}

export interface TavilyResearchResponse {
  requestId: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  createdAt?: string;
  input?: string;
  model?: string;
  content?: string | Record<string, unknown>;
  sources?: Array<{ title: string; url: string; favicon?: string }>;
  responseTime: number;
}

/** Linkup search depth; fast/standard/deep change retrieval latency and cost. */
export type LinkupSearchDepth = "fast" | "standard" | "deep";

/** Current Linkup HTTP contract. Public evidence stays SearchResult/Source/FetchedContent. */
export interface LinkupSearchControls {
  query: string;
  depth: LinkupSearchDepth;
  maxResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  fromDate?: string;
  toDate?: string;
  includeImages?: boolean;
  includeInlineCitations?: boolean;
  outputType?: "searchResults" | "sourcedAnswer" | "structured";
  structuredOutputSchema?: Record<string, unknown>;
  includeSources?: boolean;
}
export interface LinkupSearchResult { name: string; url: string; content?: string; favicon?: string; type?: "text" | "image" }
export interface LinkupSearchResponse { results: LinkupSearchResult[] }
export interface LinkupSourcedAnswerControls extends Omit<LinkupSearchControls, "outputType" | "structuredOutputSchema" | "includeSources"> {}
export interface LinkupSource { name: string; url: string; snippet?: string; favicon?: string }
export interface LinkupSourcedAnswerResponse { answer: string; sources: LinkupSource[] }
export interface LinkupStructuredResponse { data?: Record<string, unknown>; sources?: LinkupSearchResult[]; [key: string]: unknown }
export interface LinkupFetchControls { url: string; renderJs: boolean; includeRawContent?: boolean; extractImages?: boolean }
export interface LinkupFetchResponse { markdown: string; rawContent?: string; contentType?: string; images?: Array<{ alt: string; url: string }> }
export interface LinkupBalanceResponse { balance: number }
export interface LinkupResearchControls {
  query: string;
  outputType: "sourcedAnswer" | "structured";
  mode?: "answer" | "auto" | "investigate" | "research";
  reasoningDepth?: "S" | "M" | "L" | "XL";
  includeDomains?: string[];
  excludeDomains?: string[];
  fromDate?: string;
  toDate?: string;
  structuredOutputSchema?: Record<string, unknown>;
  maxWaitMs: number;
  pollIntervalMs?: number;
}
export interface LinkupResearchResponse {
  id: string;
  status: "pending" | "processing" | "completed" | "failed";
  createdAt?: string;
  updatedAt?: string;
  error?: string | null;
  output?: LinkupSourcedAnswerResponse | LinkupStructuredResponse | null;
}

// Tavily GET /usage response (internal maintenance capability). Shape derived ONLY from the
// official OpenAPI reference at docs.tavily.com/documentation/api-reference/endpoint/usage
// (GET /usage, 200 response: top-level `key` and `account` objects with integer usage fields;
// `limit` fields may be null when unlimited). Unrecognized/additive fields are ignored by the
// adapter; malformed bodies are rejected. This is NOT inferred from reachability probes.
export interface TavilyUsageSection {
  usage?: number;
  limit?: number | null;
  searchUsage?: number;
  extractUsage?: number;
  crawlUsage?: number;
  mapUsage?: number;
  researchUsage?: number;
}
export interface TavilyAccountUsage extends TavilyUsageSection {
  currentPlan?: string;
  planUsage?: number;
  planLimit?: number | null;
  paygoUsage?: number;
  paygoLimit?: number | null;
}
export interface TavilyUsageResponse {
  key?: TavilyUsageSection;
  account?: TavilyAccountUsage;
}

// xAI Responses API x_search contract (internal; grounded in @pi-lab/xsearch 1.0.3 and
// docs.x.ai/developers/tools/x-search — see docs/upstreams/xsearch.md). The wire contract is
// snake_case; the public route options are camelCase and mapped internally.
export type XSearchControls = {
  query: string;
  allowedHandles?: string[];
  excludedHandles?: string[];
  fromDate?: string;
  toDate?: string;
  model?: string;
  enableImageUnderstanding?: boolean;
  enableVideoUnderstanding?: boolean;
  maxTurns?: number;
  parallelToolCalls?: boolean;
  maxOutputTokens?: number;
};

/** Public controls accepted by the dedicated xAI search specialist. Model choice and video
 *  understanding remain internal; count only bounds returned citations, never upstream work. */
export type XSearchPublicOptions = {
  allowedHandles?: string[];
  excludedHandles?: string[];
  enableImageUnderstanding?: boolean;
  maxTurns?: number;
  parallelToolCalls?: boolean;
  maxOutputTokens?: number;
};

export type XSearchUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  xSearchCalls?: number;
  webSearchCalls?: number;
};

/** Raw xAI Responses API shape (loose — fields optional until asserted). Internal validation target
 *  for one x_search call; see docs/upstreams/xsearch.md. */
export type XSearchResponse = {
  output?: Array<{ content?: Array<{ text?: string; annotations?: Array<{ url?: string }> }> }>;
  citations?: string[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    server_side_tool_usage_details?: { x_search_calls?: number; web_search_calls?: number };
  };
};

/** Model and usage metadata retained once per xAI result set. The synthesis remains lead-only and
 * appears once in model-visible output; metadata is never written to retained fetched evidence. */
export type XSearchEnvelope = { model: string; usage: XSearchUsage; synthesis?: string; warnings?: string[] };

export type XSearchFull = {
  results: SearchResult[];
  text: string;
  citations: string[];
  model: string;
  usage: XSearchUsage;
  warnings: string[];
};

/** Public Serper route options. `country` maps to `gl` and `language` to `hl`. The current Serper
 *  platform exposes additional Search controls and specialist endpoints internally; keep those out
 *  of the public route until a recurring research task proves the distinction (see ADR 5.2). */
export type SerperPublicOptions = {
  country?: string;
  language?: string;
  /** Google time-search code (`qdr:h|d|w|m|y`). Agent-facing name is `freshness`; the tool maps
   *  intent words to this dialect so wire codes never reach the model. */
  tbs?: string;
};

/** The bounded request controls actually sent to Serper, after trimming and num clamping. */
export type SerperEffective = {
  query: string;
  num: number;
  country?: string;
  language?: string;
};

/** Namespaced Serper envelope carried once on the first SearchResult and lifted into `details.serper`.
 *  `answerBox`/`knowledgeGraph` are bounded lead-only candidates, never fetched evidence and never a
 *  provider-quality signal. */
export type SerperEnvelope = {
  effective: SerperEffective;
  answerBox?: Record<string, unknown>;
  knowledgeGraph?: Record<string, unknown>;
  credits?: number;
  warnings?: string[];
};

/** Full normalized outcome of one focused `serperSearch` call. Organic results are leads; candidate
 *  structured data is preserved bounded and lead-only. */
export type SerperFull = {
  results: SearchResult[];
  effective: SerperEffective;
  answerBox?: Record<string, unknown>;
  knowledgeGraph?: Record<string, unknown>;
  credits?: number;
  warnings: string[];
};

export interface SearchIntent {
  operation: "search";
  query: string;
  extraQueries?: string[];
  kind: "general" | "news" | "academic" | "code" | "social";
  depth: "fast" | "standard" | "deep";
  strategy: "single" | "compare";
  provider?: string;
  fallbackOnExplicit: boolean;
  recency?: { from?: string; to?: string };
  domains?: { include?: string[]; exclude?: string[] };
  count: number;
  exa?: ExaSearchControls;
  tavily?: TavilySearchControls;
  xsearch?: XSearchPublicOptions;
  serper?: SerperPublicOptions;
}

export interface FetchIntent {
  operation: "fetch";
  url?: string;
  urls?: string[];
  mode: "page" | "site" | "map";
  /** Internal-only now: the public web_fetch schema no longer exposes `extract` (ADR-002.005
   *  single-format lock). Remaining consumers: tavily maps depth/format, linkup preferRaw. */
  extract?: "readable" | "markdown" | "raw";
  provider?: string;
  linkup?: { renderJs: boolean };
}

export interface AnswerIntent {
  operation: "answer";
  question: string;
  mode: "answer";
  provider?: string;
  exa?: ExaAnswerControls;
  linkup?: Pick<LinkupSourcedAnswerControls, "depth" | "fromDate" | "toDate" | "includeDomains" | "excludeDomains" | "includeInlineCitations">;
}

export interface LookupIntent {
  operation: "lookup";
  source: "context7" | "skillsmp" | "pi-packages";
  query: string;
  library?: string;
  version?: string;
  page: number;
  limit?: number;
  sortBy?: SkillsMpSort;
  category?: string;
  occupation?: string;
  language?: string;
  provider?: string;
  context7?: Context7PublicOptions;
}

export interface FetchedContent {
  url: string;
  title: string;
  content: string;
  contentType?: string;
  tavily?: TavilyUsageEnvelope;
  webclaw?: {
    description?: string;
    author?: string;
    language?: string;
    wordCount?: number;
  };
}

export interface AnswerResult {
  answer: string;
  sources: Source[];
  model?: string;
  reportedCostUsd?: number;
  structuredData?: unknown;
  nativeResult?: unknown;
}

export interface LookupResult {
  title: string;
  url?: string;
  description?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

/** Lookup rows plus catalog metadata that must survive even when a valid catalog returns zero rows. */
export type LookupResultList = LookupResult[] & {
  skillsmp?: { effective?: SkillsMpEffective; rateLimits?: SkillsMpRateLimits };
};

/** Public Context7 options on the `web_lookup` `source:"context7"` branch. Context7-only; the
 *  discriminated schema rejects these on SkillsMP and Pi-package branches. */
export type Context7PublicOptions = {
  mode?: "docs" | "resolve";
  libraryId?: string;
  topic?: string;
  fast?: boolean;
  responseType?: "txt" | "json";
};

// Context7 API contract types (internal; grounded in the official Context7 Public API v2.0.0 and the
// installed @dreki-gg/pi-context7 0.2.0 donor — see docs/upstreams/context7.md).
export type Context7Candidate = {
  id: string;
  title?: string;
  description?: string;
  versions?: string[];
  totalSnippets?: number;
  trustScore?: number;
  benchmarkScore?: number;
  source?: string;
  stars?: number;
  branch?: string;
  state?: string;
};
export type Context7SearchResponse = { results: Context7Candidate[]; searchFilterApplied?: boolean };
export type Context7CodeExample = { language?: string; code?: string };
export type Context7CodeSnippet = {
  codeTitle?: string; codeDescription?: string; codeLanguage?: string; codeTokens?: number;
  codeId?: string; pageTitle?: string; codeList?: Context7CodeExample[];
};
export type Context7InfoSnippet = { pageId?: string; breadcrumb?: string; content?: string; contentTokens?: number };
export type Context7DocsResponse = { codeSnippets?: Context7CodeSnippet[]; infoSnippets?: Context7InfoSnippet[] };

// SkillsMP API contract types (internal; grounded in the official SkillsMP API docs at
// skillsmp.com/docs/api and the first-party @alehdezp/skillsmp-search 0.1.0 contract — see
// docs/upstreams/skillsmp.md). Catalog discovery only; never fetched evidence.
export type SkillsMpSort = "stars" | "recent";
/** Parsed from the grounded x-ratelimit-* response headers. Operational state, not a ranking signal. */
export type SkillsMpRateLimits = {
  dailyLimit?: number;
  dailyRemaining?: number;
  minuteLimit?: number;
  minuteRemaining?: number;
};
/** The bounded request controls actually sent, after trimming and integer clamping. */
export type SkillsMpEffective = {
  query: string;
  page: number;
  limit: number;
  sortBy: SkillsMpSort;
  category?: string;
  occupation?: string;
  language?: string;
};
/** Typed full result of the focused skillsMpSearch boundary. */
export type SkillsMpFull = {
  records: LookupResult[];
  effective: SkillsMpEffective;
  rateLimits?: SkillsMpRateLimits;
};

export interface AdapterCapability {
  id: string;
  operations: Operation[];
  credentials: string[];
  strengths: string[];
  modes?: string[];
  returns: ("leads" | "content" | "answers")[];
  filters?: string[];
  timeoutMs: number;
  concurrency: number;
  fallbackEligible: boolean;
  provenance: string;
}

export interface OpContext {
  signal?: AbortSignal;
  credential?: string;
  timeoutMs: number;
  persist(data: unknown): void;
  /** Cache root for js-needs DB reads/writes (webclaw adapter). Defaults to cacheRoot(cwd). */
  root?: string;
}

export interface Adapter {
  capability: AdapterCapability;
  search?(intent: SearchIntent, ctx: OpContext): Promise<SearchResultList>;
  fetch?(intent: FetchIntent, ctx: OpContext): Promise<FetchedContent[]>;
  answer?(intent: AnswerIntent, ctx: OpContext): Promise<AnswerResult>;
  lookup?(intent: LookupIntent, ctx: OpContext): Promise<LookupResult[]>;
}

export type Intent = SearchIntent | FetchIntent | AnswerIntent | LookupIntent;
