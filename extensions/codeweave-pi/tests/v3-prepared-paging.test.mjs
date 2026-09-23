import assert from "node:assert/strict";
import test from "node:test";

import { pagePreparedEvidence } from "../src/core/prepared-page.ts";
import { summaryFromNative } from "../src/providers/pi-nav-smart-summary-provider.ts";

test("prepared paging exposes stable reachable windows and omits repeated continuation summaries explicitly", () => {
  const native = {
    summary: "native summary",
    results: Array.from({ length: 12 }, (_, index) => ({ id: index + 1 })),
    relationships: Array.from({ length: 7 }, (_, index) => ({ edge: index + 1 })),
    candidates: Array.from({ length: 6 }, (_, index) => ({ candidate: index + 1 })),
    community: { member_details: Array.from({ length: 6 }, (_, index) => ({ member: index + 1 })) },
    flow: { steps: Array.from({ length: 6 }, (_, index) => ({ step: index + 1 })) },
    project_navigation: { file_backed_results: Array.from({ length: 6 }, (_, index) => ({ lead: index + 1 })) },
    source_claims: [{ path: "src/a.ts", raw_digest: "A".repeat(64) }],
    rank: 0.91,
  };
  const request = { query: "lifecycle", limit: 5 };
  const first = pagePreparedEvidence(native, { page: 1, limit: 5, request, rootIdentity: "root", generationIdentity: "gen" });
  const second = pagePreparedEvidence(native, { page: 2, limit: 5, request, rootIdentity: "root", generationIdentity: "gen" });

  assert.deepEqual(first.results.map(item => item.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(second.results.map(item => item.id), [6, 7, 8, 9, 10]);
  assert.deepEqual(second.relationships.map(item => item.edge), [6, 7]);
  assert.deepEqual(second.candidates.map(item => item.candidate), [6]);
  assert.deepEqual(second.community.member_details.map(item => item.member), [6]);
  assert.deepEqual(second.flow.steps.map(item => item.step), [6]);
  assert.deepEqual(second.project_navigation.file_backed_results.map(item => item.lead), [6]);
  assert.deepEqual(second.source_claims, native.source_claims, "private proof sidecars are not structurally paged or exposed by this helper");
  assert.equal(first.summary, native.summary);
  assert.equal(second.summary, undefined);
  assert.ok(second.project_navigation.continuation_omitted_fields.includes("summary"));
  assert.equal(second.rank, native.rank);
  assert.equal(first.project_navigation.request_identity, second.project_navigation.request_identity);
  assert.equal(second.project_navigation.page_windows.find(window => window.path === "results").omitted_before, 5);
  assert.equal(second.project_navigation.page_windows.find(window => window.path === "results").next_page, 3);
  assert.equal(second.project_navigation.generation_identity, "gen");
});

test("prepared paging can bind continuation to one public collection without hiding additive sidecars", () => {
  const native = {
    results: [{ id: 1 }, { id: 2 }],
    project_navigation: { file_backed_results: Array.from({ length: 9 }, (_, index) => ({ lead: index + 1 })) },
  };
  const first = pagePreparedEvidence(native, { page: 1, limit: 3, request: { operation: "search" }, collectionPaths: ["results"] });
  assert.deepEqual(first.results, native.results);
  assert.deepEqual(first.project_navigation.file_backed_results, native.project_navigation.file_backed_results);
  assert.deepEqual(first.project_navigation.page_windows.map(window => window.path), ["results"]);
  assert.equal(first.project_navigation.continuation, undefined, "an additive sidecar must not create a false next page");
});

test("smart summary validates outline ranges against file source lines, not outline totals", () => {
  const input = {
    cwd: ".",
    absolutePath: "/tmp/example.ts",
    displayPath: "example.ts",
    kind: "file",
    extension: ".ts",
    text: "",
    lines: Array.from({ length: 444 }, (_, index) => `// ${index + 1}`),
    sizeBytes: 1000,
  };
  const summary = summaryFromNative({ files: [{
    totalLines: 444,
    outlineEntries: [{ start: 400, end: 410, label: "late function", kind: "function" }],
    completeness: { complete: true, returned: 43, total: 43 },
  }] }, input);
  assert.equal(summary?.entries[0]?.start, 400);
  assert.equal(summary?.totalLines, 444);
});
