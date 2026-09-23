import type { EmbedOptions, EmbeddingResult, GenerateOptions, GenerateResult, LLM, ModelInfo, Queryable, RerankDocument, RerankOptions, RerankResult } from "./llm.js";
export interface VoyageProviderOptions {
    apiKey: string;
    /** Embedding model; defaults to voyage-4-large (general, highest-accuracy retrieval). */
    model?: string;
    /** Rerank model; defaults to rerank-2.5. */
    rerankModel?: string;
    /** Output dimensions; omit to use the model default. */
    dimensions?: number;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    /** Retry on HTTP 429/5xx (honoring Retry-After) so transient rate limits don't abort the batch loop. */
    maxRetries?: number;
}
/**
 * Voyage AI provider (https://docs.voyageai.com). Embeddings use the
 * OpenAI-compatible /v1/embeddings endpoint; reranking uses /v1/rerank.
 * Generation and query expansion are not supported by Voyage and are no-ops
 * the store tolerates (same as the ZeroEntropy provider).
 *
 * Requests are retried on HTTP 429 / 5xx (honoring Retry-After) so transient
 * rate limits and server errors do not abort the embedding batch loop.
 */
export declare class VoyageProvider implements LLM {
    readonly embedModelName: string;
    readonly generateModelName = "voyage/no-generation";
    readonly rerankModelName: string;
    private readonly apiKey;
    private readonly dimensions?;
    private readonly fetchImpl;
    private readonly signal?;
    private readonly maxRetries;
    constructor(options: VoyageProviderOptions);
    embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null>;
    embedBatch(texts: string[], options?: EmbedOptions): Promise<(EmbeddingResult | null)[]>;
    generate(_prompt: string, _options?: GenerateOptions): Promise<GenerateResult | null>;
    expandQuery(_query: string, _options?: {
        context?: string;
        includeLexical?: boolean;
    }): Promise<Queryable[]>;
    rerank(query: string, documents: RerankDocument[], _options?: RerankOptions): Promise<RerankResult>;
    modelExists(model: string): Promise<ModelInfo>;
    dispose(): Promise<void>;
    private request;
}
