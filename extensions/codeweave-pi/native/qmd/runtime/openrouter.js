const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_EMBED_MODEL = "nvidia/nemotron-3-embed-1b:free";
const DEFAULT_RERANK_MODEL = "nvidia/llama-nemotron-rerank-vl-1b-v2:free";
export class OpenRouterProvider {
    embedModelName;
    generateModelName = "openrouter/no-generation";
    rerankModelName;
    apiKey;
    baseUrl;
    fetchImpl;
    signal;
    constructor(options) {
        if (!options.apiKey)
            throw new Error("OpenRouter API key is required");
        this.apiKey = options.apiKey;
        this.embedModelName = options.embedModel ?? DEFAULT_EMBED_MODEL;
        this.rerankModelName = options.rerankModel ?? DEFAULT_RERANK_MODEL;
        this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.signal = options.signal;
    }
    async embed(text, options) {
        return (await this.embedBatch([text], options))[0] ?? null;
    }
    async embedBatch(texts, options) {
        if (texts.length === 0)
            return [];
        const prefix = options?.isQuery ? "query: " : "passage: ";
        const data = await this.request("/embeddings", {
            model: this.embedModelName,
            input: texts.map(text => `${prefix}${text}`),
            encoding_format: "float",
        });
        const results = Array.isArray(data?.data) ? data.data : [];
        const byIndex = new Map(results.map((item, index) => [Number.isInteger(item?.index) ? Number(item.index) : index, item]));
        return texts.map((_, index) => {
            const embedding = byIndex.get(index)?.embedding;
            return Array.isArray(embedding) ? { embedding: embedding.map(Number), model: this.embedModelName } : null;
        });
    }
    async generate(_prompt, _options) {
        return null;
    }
    async expandQuery(_query, _options) {
        return [];
    }
    async rerank(query, documents, _options) {
        if (documents.length === 0)
            return { results: [], model: this.rerankModelName };
        const data = await this.request("/rerank", {
            model: this.rerankModelName,
            query,
            documents: documents.map(document => ({ text: document.title ? `${document.title}\n${document.text}` : document.text })),
            top_n: documents.length,
        });
        const results = (Array.isArray(data?.results) ? data.results : []).map((item) => {
            const index = Number(item?.index);
            return {
                file: documents[index]?.file ?? "",
                score: Number(item?.relevance_score ?? 0),
                index,
            };
        }).filter((item) => item.file && Number.isFinite(item.score) && Number.isInteger(item.index));
        return { results, model: this.rerankModelName };
    }
    async modelExists(model) {
        const exists = model === this.embedModelName || model === this.rerankModelName || model === this.generateModelName;
        return { name: model, exists };
    }
    async dispose() { }
    async request(path, body) {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: this.signal,
        });
        if (!response.ok)
            throw new Error(`OpenRouter ${path} failed (${response.status})`);
        return response.json();
    }
}
