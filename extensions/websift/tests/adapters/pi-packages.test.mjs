// Decision protected: Pi package lookup stays bounded, catalog-only, cancellable, and non-installing.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createPiPackagesAdapter } from "../../src/adapters/pi-packages.ts";
const fixture = JSON.parse(await readFile(new URL("../fixtures/pi-packages/lookup.json", import.meta.url), "utf8"));
test("maps a bounded npm Pi-package query to catalog leads without installing", async () => {
  let request;
  const signal = new AbortController().signal;
  const adapter = createPiPackagesAdapter(async (url, options) => {
    request = { url: new URL(url), options };
    return new Response(JSON.stringify(fixture), { headers: { "content-type": "application/json" } });
  });
  const [result] = await adapter.lookup({ operation: "lookup", query: "memory", page: 1, limit: 99 }, { signal, timeoutMs: 1000, persist() {} });
  assert.equal(request.url.searchParams.get("text"), "keywords:pi-package memory");
  assert.equal(request.url.searchParams.get("size"), "20");
  assert.equal(request.options.signal, signal);
  assert.equal(result.title, "pi-test");
  assert.equal(result.metadata.installCommand, "pi install npm:pi-test");
});
test("Pi-package valid zero objects are a successful scoped zero; malformed rows and shapes are unavailable", async () => {
  const signal = new AbortController().signal;
  const zero = createPiPackagesAdapter(async () => new Response(JSON.stringify({ objects: [] })));
  const zeroResult = await zero.lookup({ operation: "lookup", query: "memory", page: 1 }, { signal, timeoutMs: 1000, persist() {} });
  assert.deepEqual(zeroResult, []);
  const malformedRows = createPiPackagesAdapter(async () => new Response(JSON.stringify({ objects: [null, { noPackage: true }] })));
  await assert.rejects(() => malformedRows.lookup({ operation: "lookup", query: "x", page: 1 }, { signal, timeoutMs: 1000, persist() {} }), { failureClass: "unavailable" });
  const badShape = createPiPackagesAdapter(async () => new Response(JSON.stringify({ nope: 1 })));
  await assert.rejects(() => badShape.lookup({ operation: "lookup", query: "x", page: 1 }, { signal, timeoutMs: 1000, persist() {} }), { failureClass: "unavailable" });
  const badJson = createPiPackagesAdapter(async () => new Response("{not json"));
  await assert.rejects(() => badJson.lookup({ operation: "lookup", query: "x", page: 1 }, { signal, timeoutMs: 1000, persist() {} }), { failureClass: "unavailable" });
});
