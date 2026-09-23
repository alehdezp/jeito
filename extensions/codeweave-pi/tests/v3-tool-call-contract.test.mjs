import assert from "node:assert/strict";
import test from "node:test";
import { getEncoding } from "js-tiktoken";
import { referenceTokenCount } from "../src/core/harness-result.ts";
import { registerGrepTool } from "../src/tools/grep.ts";
import { registerTraceTool } from "../src/tools/trace.ts";
import { registerExploreTool } from "../src/tools/explore.ts";

import {
  asToolCallValidationError,
  boundedInvalidToolCallResult,
  invalidToolCallResult,
  normalizedEnum,
  normalizedInteger,
  ToolCallValidationError,
  withToolCallNormalizations,
} from "../src/core/tool-call-contract.ts";

test("tool-call validation preserves the issue and adds accepted forms without executing evidence", () => {
  const authored = new ToolCallValidationError("wrong field", { received: { query: "x" } });
  const error = asToolCallValidationError(authored, { accepted: ["{anchor:'x'}"], guidance: ["Use anchor for code."] });
  const result = invalidToolCallResult("explore", error);
  assert.equal(result.details.validation.issue, "wrong field");
  assert.deepEqual(result.details.validation.accepted, ["{anchor:'x'}"]);
  assert.match(result.content[0].text, /Execution: nothing ran; no project evidence was produced/);
  assert.equal(result.details.envelope.status, "error");
});

test("safe enum and numeric normalization is explicit and bounded", () => {
  const normalizations = [];
  assert.equal(normalizedEnum(" CALLERS ", "relation", ["callers", "tests"], normalizations), "callers");
  assert.equal(normalizedInteger("5", "limit", 1, 1, 20, normalizations), 5);
  assert.deepEqual(normalizations, ['relation " CALLERS " → "callers"', "limit numeric string → 5"]);
  assert.throws(() => normalizedInteger("21", "limit", 1, 1, 20, []), ToolCallValidationError);
});

test("call normalization annotations deduplicate and preserve the underlying result", () => {
  const result = { content: [{ type: "text", text: "evidence" }], details: { native: { status: "ok" } } };
  const normalized = withToolCallNormalizations(result, ["one-item batch → target", "one-item batch → target"]);
  assert.equal(normalized.details.native.status, "ok");
  assert.deepEqual(normalized.details.callNormalizations, ["one-item batch → target"]);
  assert.match(normalized.content[0].text, /evidence[\s\S]*Call normalization: one-item batch → target/);
});

test("bounded normalization echo is opt-in and preserves ordinary annotations", () => {
  const result = () => ({ content: [{ type: "text", text: "evidence" }], details: {} });
  const ordinary = ['relation " CALLERS " → "callers"'];
  assert.deepEqual(withToolCallNormalizations(result(), ordinary, true), withToolCallNormalizations(result(), ordinary));
  const large = [`relation "${" ".repeat(40_000)}CALLERS" → "callers"`];
  const unchanged = withToolCallNormalizations(result(), large);
  assert.deepEqual(unchanged.details.callNormalizations, large, "other callers keep their existing behavior");
  const bounded = withToolCallNormalizations(result(), large, true);
  assert.match(bounded.content[0].text, /evidence[\s\S]*Oversized normalization detail omitted/);
  assert.ok(JSON.stringify(bounded).length < 500, "raw input is omitted from details too");
});

test("bounded validation preserves ordinary diagnostics and withholds oversized input without a details escape", () => {
  const error = new ToolCallValidationError("wrong field", { received: { query: "x" }, accepted: ["{anchor:'x'}"] });
  assert.deepEqual(boundedInvalidToolCallResult("explore", error), invalidToolCallResult("explore", error));
  const large = new ToolCallValidationError("unknown_".repeat(12_000), { received: "input_".repeat(12_000) });
  const result = boundedInvalidToolCallResult("explore", large);
  const counter = getEncoding("o200k_base");
  assert.ok(counter.encode(result.content[0].text, [], []).length <= 4_000);
  assert.ok(counter.encode(JSON.stringify(result.details), [], []).length <= 4_000);
  assert.equal(result.details.validation.received, undefined);
  assert.match(result.content[0].text, /diagnostic exceeds.*ceiling.*withheld/);
  assert.match(result.content[0].text, /nothing ran/);
});

test("registered Grep, Trace and Explore refuse oversized validation diagnostics before native execution", async () => {
  const counter = getEncoding("o200k_base");
  for (const [name, register, params] of [
    ["grep", registerGrepTool, { pattern: "Known" }],
    ["trace", registerTraceTool, { target: "Known", relation: "callers" }],
    ["explore", registerExploreTool, { view: "code", operation: "search", anchor: "Known" }],
  ]) {
    let tool, calls = 0;
    register({ registerTool: value => { tool = value; } }, { callNative: async () => { calls++; throw Error("native must not run"); } });
    const result = await tool.execute("invalid", { ...params, ["unexpected_".repeat(12_000)]: true }, undefined, undefined, { cwd: process.cwd() });
    assert.equal(calls, 0, name);
    assert.equal(result.details.envelope.status, "error", name);
    assert.ok(counter.encode(result.content.map(part => part.text ?? "").join("\n"), [], []).length <= 4_000, name);
    assert.match(result.content[0].text, /nothing ran/);
  }
});

test("shared reference counting treats source token spellings as ordinary text", () => {
  const text = "<|endoftext|>\n<|fim_prefix|> café 日本語";
  assert.equal(referenceTokenCount(text), getEncoding("o200k_base").encode(text, [], []).length);
});
