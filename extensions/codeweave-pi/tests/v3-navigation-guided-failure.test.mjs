import assert from "node:assert/strict";
import test from "node:test";

import { laneUnavailableText, unavailableResult } from "../src/core/navigation-clean.ts";

const graphReadiness = { lane: "graph", ok: false, reason: "graph artifact missing", command: undefined };
const crgReadiness = { lane: "crg", ok: false, reason: "no code graph", command: undefined };

test("F6: graph-lane unavailable message gives automatic-mode deployment diagnostics", () => {
  const text = laneUnavailableText("graph map", graphReadiness);
  assert.match(text, /UNAVAILABLE: graph map unavailable/);
  assert.match(text, /Automatic mode schedules safe graph preparation\/refresh/);
  assert.match(text, /navigation-prepare-err\.log/);
  assert.match(text, /nav:doctor/);
});

test("F6: non-graph lane keeps the prepare/repair guidance, not the build-graph note", () => {
  const text = laneUnavailableText("code orientation", crgReadiness);
  assert.match(text, /UNAVAILABLE: code orientation unavailable/);
  assert.doesNotMatch(text, /No graph artifact exists yet/);
  assert.match(text, /navigation-setup to prepare the missing lane/);
});

test("F6: unavailableResult envelope next_actions are graph-specific for graph lanes", () => {
  const r = unavailableResult("graph trace", graphReadiness);
  const actions = r.details?.envelope?.next_actions ?? [];
  assert.ok(Array.isArray(actions) && actions.length > 0);
  assert.ok(actions.some((a) => /nav:doctor/.test(a)), JSON.stringify(actions));
});

test("F6: unavailableResult still reports no mutation/fallback occurred", () => {
  const text = (unavailableResult("graph map", graphReadiness).content[0]).text;
  assert.match(text, /No query-time setup, indexing, provider call, mutation, or fallback/);
});
