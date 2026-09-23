// Decision protected: local section retrieval must carry novel fixture facts, refuse true absence, and avoid model-memory contamination.
// The contamination-controlled gate: self-authored fixtures whose facts are unique
// improbable strings no model can know. A pass here means the retrieved bytes carried
// the fact — memory cannot. easy/medium are gated (recall@3 + verbatim containment),
// hard is logged but not gated yet, negative queries must return not found (no fabrication).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { querySections } from "../src/section-rank.ts";
import { novelManifest } from "./fixtures/novel/manifest.mjs";

const here = dirname(fileURLToPath(import.meta.url));

for (const fixture of novelManifest) {
  test(`novel corpus: ${fixture.label}`, () => {
    const body = readFileSync(join(here, "fixtures/novel", fixture.file), "utf8");
    for (const q of fixture.queries) {
      const rank3 = querySections(body, q.q, 3);
      if (q.tier === "negative") {
        assert.equal(rank3.notFound, true, `negative "${q.q}" must return not found, got best score ${rank3.topScore.toFixed(2)}`);
      } else if (q.tier === "hard" || q.tier === "vague") {
        const all = querySections(body, q.q, 100);
        const factRank = all.sections.findIndex((s) => (s.heading + s.text).includes(q.fact));
        const carried5 = all.sections.slice(0, 5).some((s) => (s.heading + s.text).includes(q.fact));
        console.log(`  [${q.tier}] "${q.q}" -> ${rank3.notFound ? "not-found" : `top "${rank3.sections[0].heading}" score=${rank3.topScore.toFixed(2)}`} fact-rank=${factRank === -1 ? "absent" : factRank + 1} top3=${rank3.sections.some((s) => (s.heading + s.text).includes(q.fact))} top5=${carried5}`);
      } else {
        const carried = rank3.sections.some((s) => (s.heading + s.text).includes(q.fact));
        assert.ok(carried,
          `${q.tier} "${q.q}": fact "${q.fact}" must appear verbatim in top-3 (${rank3.sections.map((s) => `"${s.heading}"`).join(", ")})`);
      }
    }
  });
}
