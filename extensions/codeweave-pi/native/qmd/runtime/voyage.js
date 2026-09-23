/**
 * Voyage AI provider (https://docs.voyageai.com). Embeddings use the
 * OpenAI-compatible /v1/embeddings endpoint; reranking uses /v1/rerank.
 * Generation and query expansion are not supported by Voyage and are no-ops
 * the store tolerates (same as the ZeroEntropy provider).
 *
 * Requests are retried on HTTP 429 / 5xx (honoring Retry-After) so transient
 * rate limits and server errors do not abort the embedding batch loop.
 */
export class VoyageProvider {
    embedModelName;
    generateModelName = "voyage/no-generation";
    rerankModelName;
    apiKey;
    dimensions;
    fetchImpl;
    signal;
    maxRetries;
    constructor(options) {
        if (!options.apiKey)
            throw new Error("Voyage API key is required");
        this.apiKey = options.apiKey;
        this.embedModelName = options.model ?? "voyage-4-large";
        this.rerankModelName = options.rerankModel ?? "rerank-2.5";
        this.dimensions = options.dimensions;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.signal = options.signal;
        this.maxRetries = options.maxRetries ?? 5;
    }
    async embed(text, options) {
        return (await this.embedBatch([text], options))[0] ?? null;
    }
    async embedBatch(texts, options) {
        if (texts.length === 0)
            return [];
        const body = {
            model: options?.model ?? this.embedModelName,
            input: texts,
            input_type: options?.isQuery ? "query" : "document",
        };
        if (this.dimensions !== undefined)
            body.output_dimension = this.dimensions;
        const data = await this.request("/v1/embeddings", body);
        const results = Array.isArray(data?.data) ? data.data : [];
        const ordered = results.some((item) => Number.isInteger(item?.index))
            ? [...results].sort((a, b) => Number(a.index) - Number(b.index))
            : results;
        const model = data?.model ?? this.embedModelName;
        return texts.map((_, index) => {
            const embedding = ordered[index]?.embedding;
            return Array.isArray(embedding) ? { embedding: embedding.map(Number), model } : null;
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
        const data = await this.request("/v1/rerank", {
            model: this.rerankModelName,
            query,
            documents: documents.map(document => document.title ? `${document.title}\n${document.text}` : document.text),
            top_k: documents.length,
        });
        const results = (Array.isArray(data?.data) ? data.data : []).map((item) => {
            const index = Number(item?.index);
            return {
                file: documents[index]?.file ?? "",
                score: Number(item?.relevance_score ?? 0),
                index,
            };
        }).filter((item) => item.file);
        return { results, model: this.rerankModelName };
    }
    async modelExists(model) {
        const exists = model === this.embedModelName || model === this.rerankModelName || model === this.generateModelName;
        return { name: model, exists };
    }
    async dispose() { }
    async request(path, body) {
        const maxAttempts = this.maxRetries;
        for (let attempt = 0;; attempt++) {
            let response;
            try {
                response = await this.fetchImpl(`https://api.voyageai.com${path}`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                    signal: this.signal,
                });
            }
            catch (networkError) {
                if (attempt >= maxAttempts - 1)
                    throw networkError;
                await new Promise(resolve => setTimeout(resolve, 2 ** attempt * 1000));
                continue;
            }
            if (response.ok)
                return response.json();
            const text = (await response.text()).slice(0, 300).replace(/voyage[_-]?[A-Za-z0-9]+/g, "<redacted>");
            const retryable = response.status === 429 || response.status >= 500;
            if (!retryable || attempt >= maxAttempts - 1) {
                throw new Error(`Voyage ${path} failed (${response.status}): ${text}`);
            }
            // Honor the server's Retry-After when present so the provider adapts to the
            // account's actual rate limit; otherwise back off exponentially.
            const retryAfterSec = Number(response.headers?.get?.("retry-after"));
            const delayMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 2 ** attempt * 1000;
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}
