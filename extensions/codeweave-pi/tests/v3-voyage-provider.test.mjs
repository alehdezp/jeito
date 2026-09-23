import assert from "node:assert/strict";
import test from "node:test";

import { VoyageProvider } from "../native/qmd/runtime/voyage.js";

test("Voyage QMD provider sends authenticated document/query embeddings and maps reranking", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, authorization: init.headers.Authorization, body });
    if (url.endsWith("/v1/embeddings")) return Response.json({ model: body.model, data: body.input.map((_, index) => ({ index, embedding: [index, 1] })) });
    if (url.endsWith("/v1/rerank")) return Response.json({ data: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }] });
    return new Response("unexpected", { status: 500 });
  };
  const provider = new VoyageProvider({ apiKey: "test-key", fetchImpl });

  const documents = await provider.embedBatch(["first", "second"]);
  const query = await provider.embed("question", { isQuery: true });
  const ranked = await provider.rerank("question", [
    { file: "first.md", text: "first" },
    { file: "second.md", text: "second" },
  ]);

  assert.deepEqual(documents.map(result => result.embedding), [[0, 1], [1, 1]]);
  assert.deepEqual(query.embedding, [0, 1]);
  assert.equal(requests[0].body.input_type, "document");
  assert.equal(requests[1].body.input_type, "query");
  assert.ok(requests.every(request => request.authorization === "Bearer test-key"));
  assert.deepEqual(ranked.results.map(result => [result.file, result.score]), [["second.md", 0.9], ["first.md", 0.2]]);
});

test("Voyage QMD provider fails closed and redacts provider-shaped error text", async () => {
  const provider = new VoyageProvider({ apiKey: "test-key", fetchImpl: async () => new Response("voyage-secret-token", { status: 401 }) });
  await assert.rejects(provider.embed("question", { isQuery: true }), error => {
    assert.doesNotMatch(String(error), /voyage-secret-token/);
    assert.match(String(error), /<redacted>/);
    return true;
  });
});
