/**
 * Leaf constants for provider/model fallbacks. No imports.
 *
 * Single source of truth so a provider model rename touches one place.
 * Extracted as a leaf module to avoid circular imports between
 * navigation-automation-config.ts and navigation-friendly-yaml.ts.
 *
 * OpenAI remains the default Graphify provider. QMD docs uses its own
 * ZeroEntropy zembed-1/zerank-2 contract when configured and otherwise stays
 * lexical. Graphify deep extraction remains manual/guided; lifecycle queries
 * never infer provider availability from unrelated keys.
 *
 * Historical note: older defaults coupled all lanes to one provider and to
 * generated documentation summaries. The QMD lane has no summary aliases.
 */

export const DEFAULT_GRAPHIFY_PROVIDER = "openai";
export const DEFAULT_GRAPHIFY_MODEL = "gpt-4o";
export const DEFAULT_LLM_PROVIDER = "openai";
export const DEFAULT_LLM_MODEL_OPENAI = "gpt-4o";
export const DEFAULT_EMBEDDING_PROVIDER = "openai";
export const DEFAULT_EMBEDDING_MODEL_OPENAI = "text-embedding-3-small";
export const DEFAULT_EMBEDDING_MODEL_VOYAGE = "voyage-4-large";
