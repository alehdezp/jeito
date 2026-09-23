/**
 * voyage.test.ts - Unit tests for the Voyage AI provider (embeddings + rerank).
 *
 * Uses a mocked fetch so no network or API key is required.
 */
import { describe, expect, test, vi } from "vitest";
import { VoyageProvider } from "../src/voyage.js";

function mockFetchOnce(payload: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as Response);
}

describe("VoyageProvider", () => {
  test("requires an api key", () => {
    expect(() => new VoyageProvider({ apiKey: "" })).toThrow(/Voyage API key is required/);
  });

  test("defaults to the general embed model and rerank-2.5", () => {
    const provider = new VoyageProvider({ apiKey: "k" });
    expect(provider.embedModelName).toBe("voyage-4-large");
    expect(provider.rerankModelName).toBe("rerank-2.5");
  });

  test("embedBatch posts OpenAI-compatible embeddings and orders by index", async () => {
    const fetchImpl = mockFetchOnce({
      model: "voyage-4-large",
      data: [
        { index: 1, embedding: [0.2, 0.2] },
        { index: 0, embedding: [0.1, 0.1] },
      ],
    });
    const provider = new VoyageProvider({ apiKey: "k", fetchImpl });
    const result = await provider.embedBatch(["a", "b"]);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ embedding: [0.1, 0.1], model: "voyage-4-large" });
    expect(result[1]).toEqual({ embedding: [0.2, 0.2], model: "voyage-4-large" });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://api.voyageai.com/v1/embeddings");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("voyage-4-large");
    expect(body.input).toEqual(["a", "b"]);
    expect(body.input_type).toBe("document");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer k" });
  });

  test("embed marks query input type", async () => {
    const fetchImpl = mockFetchOnce({ model: "voyage-4-large", data: [{ index: 0, embedding: [0.5] }] });
    const provider = new VoyageProvider({ apiKey: "k", fetchImpl });
    await provider.embed("q", { isQuery: true });
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.input_type).toBe("query");
  });

  test("rerank maps Voyage results onto RerankResult", async () => {
    const fetchImpl = mockFetchOnce({
      data: [
        { index: 1, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.4 },
      ],
    });
    const provider = new VoyageProvider({ apiKey: "k", fetchImpl });
    const docs = [
      { file: "a.md", text: "alpha" },
      { file: "b.md", text: "beta", title: "Beta" },
    ];
    const result = await provider.rerank("q", docs);

    expect(result.model).toBe("rerank-2.5");
    expect(result.results).toEqual([
      { file: "b.md", score: 0.9, index: 1 },
      { file: "a.md", score: 0.4, index: 0 },
    ]);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://api.voyageai.com/v1/rerank");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("rerank-2.5");
    expect(body.documents).toEqual(["alpha", "Beta\nbeta"]);
    expect(body.top_k).toBe(2);
  });

  test("generate and expandQuery are tolerated no-ops", async () => {
    const provider = new VoyageProvider({ apiKey: "k", fetchImpl: mockFetchOnce({}) });
    expect(await provider.generate("p")).toBeNull();
    expect(await provider.expandQuery("q")).toEqual([]);
  });

  test("non-ok response throws with redacted key", async () => {
    const fetchImpl = mockFetchOnce({ error: "unauthorized voyage_abc123" }, false, 401);
    const provider = new VoyageProvider({ apiKey: "k", fetchImpl });
    await expect(provider.embed("x")).rejects.toThrow(/Voyage \/v1\/embeddings failed \(401\)/);
  });

  test("retries on 429 honoring Retry-After, then succeeds", async () => {
    vi.useFakeTimers();
    try {
      const throttled = { ok: false, status: 429, json: async () => ({}), text: async () => "rate limited", headers: new Headers({ "retry-after": "1" }) } as Response;
      const success = { ok: true, status: 200, json: async () => ({ model: "voyage-4-large", data: [{ index: 0, embedding: [0.7] }] }), text: async () => "", headers: new Headers() } as Response;
      const fetchImpl = vi.fn(async () => (fetchImpl.mock.calls.length === 1 ? throttled : success));
      const provider = new VoyageProvider({ apiKey: "k", fetchImpl });

      const pending = provider.embed("x");
      // First call returns 429 with Retry-After: 1s; advance past the wait so the retry fires.
      await vi.advanceTimersByTimeAsync(1500);
      const result = await pending;

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ embedding: [0.7], model: "voyage-4-large" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("gives up after max retry attempts on persistent 429", async () => {
    vi.useFakeTimers();
    try {
      const throttled = { ok: false, status: 429, json: async () => ({}), text: async () => "rate limited", headers: new Headers({ "retry-after": "1" }) } as Response;
      const fetchImpl = vi.fn(async () => throttled);
      const provider = new VoyageProvider({ apiKey: "k", fetchImpl });

      const pending = provider.embed("x");
      pending.catch(() => {}); // attach handler so the rejection is observed
      // 5 attempts with exponential backoff (1s,2s,4s,8s) between them.
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(pending).rejects.toThrow(/failed \(429\)/);
      expect(fetchImpl).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });
});
