import type { EmbedOptions, EmbeddingResult, GenerateOptions, GenerateResult, LLM, ModelInfo, Queryable, RerankDocument, RerankOptions, RerankResult } from "./llm.js";
export interface ZeroEntropyProviderOptions {
    apiKey: string;
    dimensions?: number;
    latency?: "fast" | "slow";
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
}
export declare class ZeroEntropyProvider implements LLM {
    readonly embedModelName: string;
    readonly generateModelName = "zeroentropy/no-generation";
    readonly rerankModelName = "zeroentropy/zerank-2";
    private readonly apiKey;
    private readonly dimensions;
    private readonly latency;
    private readonly fetchImpl;
    private readonly signal?;
    constructor(options: ZeroEntropyProviderOptions);
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
