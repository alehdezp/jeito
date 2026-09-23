import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import jeitoCodeweavePiExtension from "../index.ts";
import { registerTraceTool } from "../src/tools/trace.ts";

function makePi() {
  const tools = new Map();
  return {
    registerTool(tool) { tools.set(tool.name, tool); },
    on() {},
    getActiveTools() { return []; },
    setActiveTools() {},
    tool(name) { const found = tools.get(name); assert.ok(found); return found; },
  };
}

async function call(pi, cwd, params) {
  const result = await pi.tool("trace").execute("trace", params, undefined, undefined, { cwd });
  return {
    text: result.content.map(part => part.type === "text" ? part.text : "").join("\n"),
    details: result.details,
  };
}

async function fixture(t, files) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-trace-callers-identity-"));
  t.after(async () => { await rm(cwd, { recursive: true, force: true }); });
  await mkdir(join(cwd, "relations"), { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(join(cwd, name), content);
  return cwd;
}

test("file-qualified callers identity finds every external call site without narrowing scope", async t => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await fixture(t, {
    "relations/target.ts": "export function Wanted() { return 1; }\n",
    "relations/caller.ts": "import { Wanted } from './target.js';\nexport function Caller() { return Wanted(); }\nexport function Inner() { return Wanted() + Wanted(); }\n",
  });
  const { text, details } = await call(pi, cwd, { target: "relations/target.ts::Wanted", relation: "callers", scope: cwd });
  assert.equal(details.envelope.status, "success");
  // All three call expressions live outside the declaration file, on two site records.
  assert.match(text, /relations\/caller\.ts:2/);
  assert.match(text, /relations\/caller\.ts:3/);
  assert.match(text, /Caller/);
  assert.match(text, /Inner/);
  assert.doesNotMatch(text, /no call sites found/i);
  assert.doesNotMatch(text, /0 relation rows/i);
});

test("same-named definitions refuse instead of mixing callers across files", async t => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await fixture(t, {
    "relations/target.ts": "export function Wanted() { return 1; }\n",
    "relations/caller.ts": "import { Wanted } from './target.js';\nexport function Caller() { return Wanted(); }\n",
    "relations/decoy.ts": "export function Wanted() { return 2; }\n",
  });
  const { text, details } = await call(pi, cwd, { target: "relations/target.ts::Wanted", relation: "callers", scope: cwd });
  assert.equal(details.envelope.status, "warning");
  assert.match(text, /same-named current declaration sites|ambiguous/i);
  assert.match(text, /relations\/decoy\.ts/);
  assert.doesNotMatch(text, /relations\/caller\.ts/);
});

test("two same-named declarations in one file refuse instead of hiding behind the path", async t => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await fixture(t, {
    "relations/target.ts": "export function Wanted() { return 1; }\nexport function Wanted() { return 2; }\n",
    "relations/caller.ts": "import { Wanted } from './target.js';\nexport function Caller() { return Wanted(); }\n",
  });
  const { text, details } = await call(pi, cwd, { target: "relations/target.ts::Wanted", relation: "callers", scope: cwd });
  assert.equal(details.envelope.status, "warning");
  assert.match(text, /2 same-named current declaration sites/);
  assert.match(text, /relations\/target\.ts:1-1/);
  assert.match(text, /relations\/target\.ts:2-2/);
  assert.doesNotMatch(text, /relations\/caller\.ts/);
});

test("missing declaration refuses instead of reporting a complete zero", async t => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await fixture(t, {
    "relations/target.ts": "export function Wanted() { return 1; }\n",
  });
  const { text, details } = await call(pi, cwd, { target: "relations/target.ts::Missing", relation: "callers", scope: cwd });
  assert.equal(details.envelope.status, "warning");
  assert.match(text, /no current definition/i);
  assert.doesNotMatch(text, /complete.*true/i);
});

test("truncated ownership probe refuses instead of claiming uniqueness", async t => {
  const pi = makePi();
  registerTraceTool(pi, { callNative: async request => {
    if (request.args?.kind === "symbol") {
      return {
        text: "symbol probe",
        structured: {
          data: { matches: [{ role: "definition", symbol: "Wanted", location: { path: "relations/target.ts", start: 1, end: 1 } }] },
          diagnostics: [],
          completeness: { complete: false, returned: 1, total: 99 },
        },
        sourceSnapshots: [],
      };
    }
    throw new Error("main callers query must not run after an incomplete ownership probe");
  } });
  const cwd = await fixture(t, {
    "relations/target.ts": "export function Wanted() { return 1; }\n",
  });
  const { text, details } = await call(pi, cwd, { target: "relations/target.ts::Wanted", relation: "callers", scope: cwd });
  assert.equal(details.envelope.status, "warning");
  assert.match(text, /ownership probe reply was incomplete/i);
  assert.doesNotMatch(text, /relations\/caller\.ts/);
});

test("file-qualified tests identity discovers the test file instead of a no-test zero", async t => {
  const pi = makePi();
  jeitoCodeweavePiExtension(pi);
  const cwd = await fixture(t, {
    "relations/target.ts": "export function Wanted() { return 1; }\n",
    "relations/target.test.ts": "import { Wanted } from './target.js';\ntest('wanted', () => { Wanted(); });\n",
  });
  const { text, details } = await call(pi, cwd, { target: "relations/target.ts::Wanted", relation: "tests", scope: cwd });
  assert.equal(details.envelope.status, "success");
  assert.match(text, /relations\/target\.test\.ts/);
});
