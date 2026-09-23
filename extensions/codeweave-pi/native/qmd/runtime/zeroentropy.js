export class ZeroEntropyProvider {
    embedModelName;
    generateModelName = "zeroentropy/no-generation";
    rerankModelName = "zeroentropy/zerank-2";
    apiKey;
    dimensions;
    latency;
    fetchImpl;
    signal;
    constructor(options) {
        if (!options.apiKey)
            throw new Error("ZeroEntropy API key is required");
        this.apiKey = options.apiKey;
        this.dimensions = options.dimensions ?? 2560;
        this.latency = options.latency ?? "fast";
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.signal = options.signal;
        this.embedModelName = `zeroentropy/zembed-1/${this.dimensions}`;
    }
    async embed(text, options) {
        return (await this.embedBatch([text], options))[0] ?? null;
    }
    async embedBatch(texts, options) {
        if (texts.length === 0)
            return [];
        const data = await this.request("/models/embed", {
            model: "zembed-1",
            input_type: options?.isQuery ? "query" : "document",
            input: texts,
            dimensions: this.dimensions,
            encoding_format: "float",
            latency: this.latency,
        });
        const results = Array.isArray(data?.results) ? data.results : [];
        const ordered = results.some((item) => Number.isInteger(item?.index))
            ? [...results].sort((a, b) => Number(a.index) - Number(b.index))
            : results;
        return texts.map((_, index) => {
            const embedding = ordered[index]?.embedding;
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
        const data = await this.request("/models/rerank", {
            model: "zerank-2",
            query,
            documents: documents.map(document => document.title ? `${document.title}\n${document.text}` : document.text),
            top_n: documents.length,
            latency: this.latency,
        });
        const results = (Array.isArray(data?.results) ? data.results : []).map((item) => {
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
        const response = await this.fetchImpl(`https://api.zeroentropy.dev/v1${path}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: this.signal,
        });
        if (!response.ok) {
            const text = (await response.text()).slice(0, 300).replace(/ze_[A-Za-z0-9]+/g, "<redacted>");
            throw new Error(`ZeroEntropy ${path} failed (${response.status}): ${text}`);
        }
        return response.json();
    }
}
