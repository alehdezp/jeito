import assert from "node:assert/strict";
import test from "node:test";

import { encodeGenericGCFormat } from "../src/core/gcformat.ts";
import { formatBackendJsonForOutput } from "../src/core/navigation-clean.ts";

test("backend JSON is encoded as local GCF-style generic tables before navigation shaping", () => {
  const out = formatBackendJsonForOutput({
    summary: "caller results",
    results: [
      { path: "src/a.ts", start: 1, end: 3, summary: "first" },
      { path: "src/b.ts", start: 4, end: 5, summary: "second" },
    ],
  });

  assert.match(out, /^summary=caller results/m);
  assert.match(out, /## results \[2\]\{summary,path,start,end\}/);
  assert.match(out, /first\|src\/a\.ts\|1\|3/);
  assert.doesNotMatch(out, /^\{/m, "backend output should not remain raw JSON when GCF encoding is possible");
});

test("navigation shaping preserves backend-native semantic fields and only removes named implementation noise", () => {
  const out = formatBackendJsonForOutput({
    summary: "native parity",
    results: [{
      path: "src/a.ts",
      start: 1,
      end: 3,
      summary: "community relationship",
      size: 175,
      language: "typescript",
      cohesion: 0.42,
      why: "query token matched this community",
      is_test: true,
      context: "call-site",
      native_new_field: "preserve-me",
    }],
    metadata: { backend: "crg", tool: "overview", detail_level: "standard", source_status: "ready", warnings: 2 },
    backend_new_top_level: { marker: "preserve-top" },
  });

  for (const value of ["size", "language", "cohesion", "why", "is_test", "context", "native_new_field", "preserve-me", "backend_new_top_level", "preserve-top"]) {
    assert.match(out, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), out);
  }
  assert.match(out, /warnings=2/);
  assert.doesNotMatch(out, /backend=crg|tool=overview|detail_level=standard|source_status=ready/);
});

test("navigation shaping lets GCF report the true native array total", () => {
  const out = formatBackendJsonForOutput({
    summary: "large native result",
    results: Array.from({ length: 100 }, (_, index) => ({ path: `src/${index}.ts`, start: 1, end: 2, summary: `row ${index}` })),
  });

  assert.match(out, /## results \[100\]/);
  assert.match(out, /\.\.\.truncated 20 of 100/);
});

test("navigation JSON formatting prioritizes semantic review warnings before generic result tables", () => {
  const out = formatBackendJsonForOutput({
    summary: "review synthesis",
    results: Array.from({ length: 5 }, (_, index) => ({ path: `src/${index}.ts`, start: 1, end: 2, summary: `row ${index}` })),
    relationship_edges: Array.from({ length: 5 }, (_, index) => ({ kind: "CALLS", source: `a${index}`, target: `b${index}`, confidence_tier: "EXTRACTED" })),
    review: {
      risk_score: 0.9,
      scope_drift: { warning: "out-of-scope rows are context only" },
      review_priorities: ["protect scope"],
      context_savings: { saved_tokens: 123 },
      test_gaps: [{ path: "tests/a.test.ts", start: 1, end: 2, summary: "gap" }],
    },
  });

  assert.ok(out.indexOf("## review") >= 0, out);
  assert.ok(out.indexOf("## review") < out.indexOf("## results"), "semantic review evidence should render before generic rows");
  assert.ok(out.indexOf("## scope_drift") < out.indexOf("## test_gaps"), "scope drift warning should not be buried after large evidence arrays");
  assert.match(out, /review_priorities\[1\]: protect scope/);
  assert.ok(out.indexOf("## relationship_edges") < out.indexOf("## results"), "edge provenance should render before generic rows");
  assert.match(out, /confidence_tier/);
  assert.match(out, /saved_tokens=123/);
});

test("navigation JSON formatting omits undefined fields instead of rendering blank scalars", () => {
  const out = formatBackendJsonForOutput({ summary: "clean", artifact_quality: undefined, signal: { target: "src/a.ts", risk_score: undefined } });
  assert.match(out, /^summary=clean/m);
  assert.doesNotMatch(out, /artifact_quality=/);
  assert.doesNotMatch(out, /risk_score=/);
});

test("local GCF-style generic encoder handles nested metadata and primitive arrays", () => {
  const out = encodeGenericGCFormat({ metadata: { backend: "crg", diagnostics: ["ready", "fresh"] } });
  assert.match(out, /## metadata/);
  assert.match(out, /backend=crg/);
  assert.match(out, /diagnostics\[2\]: ready,fresh/);
});

test("local GCF-style generic encoder shows empty workflow sections without exposing all empty arrays", () => {
  const out = encodeGenericGCFormat({
    debug_triage: {
      possible_entry_points_or_callers: [],
      downstream_dependencies_or_callees: [],
      direct_target_evidence: [],
      relationships_to_check: [],
      changed_context_evidence: [],
      tests_found: [],
      test_gaps_or_absence_warnings: [],
      irrelevant_backend_empty: [],
    },
  });

  assert.match(out, /## possible_entry_points_or_callers \[0\]/);
  assert.match(out, /## downstream_dependencies_or_callees \[0\]/);
  assert.match(out, /## direct_target_evidence \[0\]/);
  assert.match(out, /## relationships_to_check \[0\]/);
  assert.match(out, /## changed_context_evidence \[0\]/);
  assert.match(out, /## tests_found \[0\]/);
  assert.match(out, /## test_gaps_or_absence_warnings \[0\]/);
  assert.doesNotMatch(out, /irrelevant_backend_empty/);
});
