// Decision protected: local section retrieval holds its recall and context-budget contract on retained real-world source snapshots.
// Real-surface regression: the spike's 15 queries over qmd README, graphify README, and
// the Graphify-vs-code-review-graph forum thread. Recall@3 >= 90%; top-3 <= ~6.5K raw chars
// (~1.6K tokens) on every corpus and <= 20% of the page on doc corpora (the pre-fix thread
// value was 98%); negatives are true-absence queries (zero shared terms) and must return
// not found. Sources: github.com/tobi/qmd README, github.com/Graphify-Labs/graphify README,
// and reddit.com/r/ClaudeCode/comments/1sme1zw (fetched extraction).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { querySections } from "../src/section-rank.ts";

const here = dirname(fileURLToPath(import.meta.url));

const corpora = [
  {
    name: "qmd-readme", file: "qmd-readme.md", maxFrac: 0.2,
    queries: [
      { q: "install qmd globally npm", exp: "npm install -g @tobilu/qmd", tier: "E" },
      { q: "MCP server tools query get status", exp: "MCP Server", tier: "M" },
      { q: "context add tree collection", exp: "Quick Start", tier: "M" },
      { q: "connect MCP client over HTTP streamable endpoint", exp: "HTTP Transport", tier: "H" },
      { q: "gradient boosting ensemble", exp: null, tier: "N" },
    ],
  },
  {
    name: "graphify-readme", file: "graphify-readme.md", maxFrac: 0.2,
    queries: [
      { q: "install graphify CLI uv", exp: "Install", tier: "E" },
      { q: "query instead of grep knowledge graph", exp: "See it in action", tier: "M" },
      { q: "edge confidence extracted inferred", exp: "See it in action", tier: "M" },
      { q: "benchmark LOCOMO recall accuracy", exp: "Benchmarks", tier: "M" },
      { q: "share graph over HTTP team server", exp: "Shared HTTP server", tier: "H" },
      { q: "astronomy telescope calibration", exp: null, tier: "N" },
    ],
  },
  {
    name: "reddit-thread", file: "reddit-graphify-thread.md",
    queries: [
      { q: "which tool for python data backend recommendation", exp: "code-review-graph for the Market Analysis", tier: "M" },
      { q: "graphify large repos not capable criticism", exp: "not capable of handling large repos", tier: "M" },
      { q: "token savings 71x scale reduction", exp: "71x reduction", tier: "M" },
      { q: "quantum computing hardware", exp: null, tier: "N" },
    ],
  },
];

test("real corpora: recall@3 >= 90%, token budget, negatives not found", () => {
  let total = 0;
  let hits = 0;
  let negatives = 0;
  let negOk = 0;
  for (const c of corpora) {
    const body = readFileSync(join(here, "fixtures/real", c.file), "utf8");
    for (const t of c.queries) {
      const rank = querySections(body, t.q);
      if (t.exp === null) {
        negatives++;
        if (rank.notFound) negOk++;
        continue;
      }
      total++;
      const found = rank.sections.find((s) => (s.heading + s.text).includes(t.exp));
      if (found) hits++;
      const chars = rank.sections.reduce((a, s) => a + s.text.length, 0);
      assert.ok(chars <= 6_500, `${c.name} "${t.q}": top-3 is ${chars} raw chars (cap 6,500)`);
      if (c.maxFrac) {
        const frac = chars / body.length;
        assert.ok(frac <= c.maxFrac,
          `${c.name} "${t.q}": top-3 is ${(frac * 100).toFixed(0)}% of the page (cap ${c.maxFrac * 100}%)`);
      }
    }
  }
  assert.ok(hits / total >= 0.9, `recall@3 ${hits}/${total} below the 90% gate`);
  assert.equal(negOk, negatives, `negatives must return not found (${negOk}/${negatives})`);
});
