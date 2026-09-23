import type { EmbedOptions, EmbeddingResult, GenerateOptions, GenerateResult, LLM, ModelInfo, Queryable, RerankDocument, RerankOptions, RerankResult } from "./llm.js";
export interface OpenRouterProviderOptions {
    apiKey: string;
    embedModel?: string;
    rerankModel?: string;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
}
export declare class OpenRouterProvider implements LLM {
    readonly embedModelName: string;
    readonly generateModelName = "openrouter/no-generation";
    readonly rerankModelName: string;
    private readonly apiKey;
    private readonly baseUrl;
    private readonly fetchImpl;
    private readonly signal?;
    constructor(options: OpenRouterProviderOptions);
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
