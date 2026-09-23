import assert from "node:assert/strict";
import test from "node:test";

import { OpenRouterProvider } from "../native/qmd/runtime/openrouter.js";

test("OpenRouter QMD provider preserves Nemotron query/passage roles and maps reranking", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, authorization: init.headers.Authorization, body });
    if (url.endsWith("/embeddings")) return Response.json({ data: body.input.map((_, index) => ({ index, embedding: [index, 1] })) });
    if (url.endsWith("/rerank")) return Response.json({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }] });
    return new Response("unexpected", { status: 500 });
  };
  const provider = new OpenRouterProvider({ apiKey: "test-key", fetchImpl });

  const documents = await provider.embedBatch(["first", "second"]);
  const query = await provider.embed("question", { isQuery: true });
  const ranked = await provider.rerank("question", [
    { file: "first.md", text: "first" },
    { file: "second.md", text: "second" },
  ]);

  assert.deepEqual(documents.map(result => result.embedding), [[0, 1], [1, 1]]);
  assert.deepEqual(query.embedding, [0, 1]);
  assert.deepEqual(requests[0].body.input, ["passage: first", "passage: second"]);
  assert.deepEqual(requests[1].body.input, ["query: question"]);
  assert.equal(requests[0].body.model, "nvidia/nemotron-3-embed-1b:free");
  assert.equal(requests[2].body.model, "nvidia/llama-nemotron-rerank-vl-1b-v2:free");
  assert.deepEqual(requests[2].body.documents, [{ text: "first" }, { text: "second" }]);
  assert.ok(requests.every(request => request.authorization === "Bearer test-key"));
  assert.deepEqual(ranked.results.map(result => [result.file, result.score]), [["second.md", 0.9], ["first.md", 0.2]]);
});

test("OpenRouter QMD provider fails closed without exposing response bodies", async () => {
  const provider = new OpenRouterProvider({ apiKey: "test-key", fetchImpl: async () => new Response("secret echoed by provider", { status: 401 }) });
  await assert.rejects(provider.embed("question", { isQuery: true }), error => {
    assert.doesNotMatch(String(error), /secret echoed by provider|test-key/);
    assert.match(String(error), /OpenRouter \/embeddings failed \(401\)/);
    return true;
  });
});
