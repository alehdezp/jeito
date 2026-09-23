import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("..", import.meta.url));

// The Pi host loads index.ts with a stricter parser than Node's
// --experimental-strip-types: duplicate top-level declarations that Node
// silently strips (e.g. `export type CorpusLane` declared twice) hard-fail
// extension load with "Identifier 'X' has already been declared". This scan
// guards the whole extension graph so the class cannot recur unnoticed.

const DECL = /^(export\s+)?(interface|type|class|const|let|var|function|async\s+function)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
const SKIP_DIRS = new Set(["node_modules", ".runtime", "native", ".git", ".pi", ".cache", ".tmp", ".agents"]);

function collectTsFiles(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectTsFiles(join(dir, entry.name), out);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

test("no duplicate top-level declarations in the extension load graph", () => {
  const files = collectTsFiles(join(EXT, "src"), []);
  files.push(join(EXT, "index.ts"));
  const duplicates = [];
  for (const file of files) {
    const seen = new Map();
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s/.test(line)) continue; // block-scoped; only top level matters
      const m = DECL.exec(line);
      if (!m) continue;
      const key = m[1] ?? "";
      const name = m[3];
      const declKey = `${key}${name}`;
      const first = seen.get(declKey);
      if (first !== undefined) {
        duplicates.push(`${file}:${i + 1}: duplicate top-level ${m[2]} ${name} (first at ${first})`);
      } else {
        seen.set(declKey, i + 1);
      }
    }
  }
  assert.deepEqual(duplicates, [], "duplicate top-level declarations break the Pi host loader even though Node strip-types tolerates them");
});
