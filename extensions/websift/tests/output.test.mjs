// Decision protected: GCF output preserves whole records, evidence state, and visible truncation.
import assert from "node:assert/strict";
import test from "node:test";
import { decodeGeneric } from "@blackwell-systems/gcf";
import { encodeGcfRecords } from "../src/gcf.ts";
import { formatAnswer, formatSearch } from "../src/output.ts";


test("xsearch output preserves complete synthesis and provider-reported work in GCF", () => {
  const snippet = "first-hand synthesis ".repeat(200);
  const xsearch = { model: "grok-4.5", usage: { totalTokens: 120145, xSearchCalls: 10 } };
  const result = { title: "X source 1", url: "https://x.com/a", snippet, sourceType: "social", xsearch };
  const content = formatSearch([result], 12000);
  const decoded = decodeGeneric(content);
  assert.match(content, /^GCF profile=generic/);
  const synthesis = decoded.records.find((record) => record.recordType === "xsearch-synthesis");
  assert.equal(synthesis.xsearch.usage.xSearchCalls, 10);
  assert.equal(synthesis.xsearch.usage.totalTokens, 120145);
  assert.equal(synthesis.text, snippet);
  assert.equal(decoded.records.filter((record) => record.recordType === "xsearch-synthesis").length, 1);
});

test("oversized xsearch synthesis is omitted as one record without dropping citation rows", () => {
  const snippet = "x".repeat(20_000);
  const xsearch = { model: "grok", usage: { xSearchCalls: 4 } };
  const result = { title: "Citation", url: "https://x.com/a", snippet, sourceType: "social", xsearch };
  const decoded = decodeGeneric(formatSearch([result], 2_000));
  assert.equal(decoded.records[0].title, "Citation");
  assert.equal(decoded.records.some((record) => record.recordType === "xsearch-synthesis"), false);
  assert.equal(decoded.omittedRecords, 1);
});

test("GCF model output round-trips nested provider data and truncates only whole records", () => {
  const records = Array.from({ length: 6 }, (_, index) => ({ index, body: `row-${index}:` + "x".repeat(180), nested: { ok: true, values: [index, index + 1] } }));
  const content = encodeGcfRecords(records, { maxChars: 650, comments: ["lead-only"], metadata: { provider: "fixture" } });
  const decoded = decodeGeneric(content);
  assert.ok(content.length <= 650);
  assert.ok(decoded.shownRecords > 0 && decoded.shownRecords < records.length);
  assert.equal(decoded.records.length, decoded.shownRecords);
  assert.equal(decoded.omittedRecords, records.length - decoded.shownRecords);
  assert.deepEqual(decoded.records, records.slice(0, decoded.shownRecords));
});

test("prose answer reserves every source identity while GCF omits only complete passage records", () => {
  const answer = "Grounded answer. ".repeat(25);
  const sources = Array.from({ length: 8 }, (_, index) => ({ title: `Source ${index + 1}`, url: `https://example.com/${index + 1}`, passage: `passage-${index + 1}:` + "x".repeat(240), fetched: false, evidenceStatus: "provider-citation", provider: "exa" }));
  const content = formatAnswer({ answer, sources, model: "exa", reportedCostUsd: 0.005 }, sources, "exa", 1_400);
  const gcfStart = content.indexOf("GCF profile=generic");
  assert.ok(gcfStart > 0);
  assert.ok(content.length <= 1_400);
  assert.match(content, /^Grounded answer/);
  const decoded = decodeGeneric(content.slice(gcfStart));
  assert.equal(decoded.totalRecords, sources.length);
  assert.deepEqual(decoded.sourceIndex, sources.map((source, index) => ({ providerOrder: index + 1, title: source.title, url: source.url, evidenceStatus: source.evidenceStatus, provider: source.provider })));
  assert.ok(decoded.shownRecords < sources.length);
  assert.equal(decoded.omittedRecords, sources.length - decoded.shownRecords);
  assert.deepEqual(decoded.records, sources.slice(0, decoded.shownRecords).map((source, index) => ({ recordType: "source", providerOrder: index + 1, ...source })));
});

test("answer fails instead of hiding source identities when the complete index cannot fit", () => {
  const sources = Array.from({ length: 20 }, (_, index) => ({ title: `Long source ${index} ${"x".repeat(40)}`, url: `https://example.com/very/long/source/${index}`, passage: "p", fetched: false, evidenceStatus: "provider-citation", provider: "exa" }));
  assert.throws(() => formatAnswer({ answer: "answer", sources }, sources, "exa", 500), /metadata exceeds/);
});

test("structured answer data is the first GCF record before provider-ordered sources", () => {
  const sources = [{ title: "Source", url: "https://example.com", fetched: false, evidenceStatus: "provider-citation", provider: "exa" }];
  const content = formatAnswer({ answer: "", structuredData: { verdict: "qualified", rows: [1, 2] }, sources, model: "exa" }, sources, "exa", 2_000);
  const decoded = decodeGeneric(content);
  assert.equal(decoded.records[0].recordType, "answer");
  assert.deepEqual(decoded.records[0].data, { verdict: "qualified", rows: [1, 2] });
  assert.deepEqual(decoded.sourceIndex, [{ providerOrder: 1, title: "Source", url: "https://example.com", evidenceStatus: "provider-citation", provider: "exa" }]);
  assert.equal(decoded.records[1].providerOrder, 1);
  assert.equal(decoded.totalRecords, 2);
});