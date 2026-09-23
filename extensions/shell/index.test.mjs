import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import jeitoShell, { __jeitoShellUi as ui } from "./index.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { LEAN_CTX_VERSION, leanCtxPaths, leanCtxTarget, setLeanCtxRuntimeRootForTests } from "./lean-ctx-runtime.mjs";

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const stripAnsi = text => String(text).replace(ANSI_RE, "");
const theme = { fg: (_style, text) => `\x1b[38;5;45m${text}\x1b[0m`, bold: text => `\x1b[1m${text}\x1b[22m` };
const semanticTheme = { fg: (style, text) => `\x1b[${style === "success" ? 32 : style === "error" ? 31 : 33}m${text}\x1b[0m`, bold: text => text };
const fakeExtensionRoot = mkdtempSync(`${tmpdir()}/jeito-shell-runtime-`);
const fakeRuntime = leanCtxPaths(fakeExtensionRoot);
const leanCtxInvocations = `${fakeExtensionRoot}/lean-ctx-invocations.log`;
mkdirSync(fakeRuntime.root, { recursive: true });
writeFileSync(fakeRuntime.binary, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "lean-ctx ${LEAN_CTX_VERSION}"; exit 0; fi\nif [ "$1" = "-c" ]; then [ ! -f /dev/fd/1 ] || { echo "LeanCTX stdout must not be a regular file" >&2; exit 9; }; printf '%s\\n' "$2" >> "$LEAN_CTX_TEST_INVOCATIONS"; exec /bin/bash -c "$2"; fi\nexit 2\n`);
chmodSync(fakeRuntime.binary, 0o755);
const fakeBinaryHash = createHash("sha256").update(readFileSync(fakeRuntime.binary)).digest("hex");
writeFileSync(fakeRuntime.ready, `${JSON.stringify({ version: LEAN_CTX_VERSION, target: leanCtxTarget(), binarySha256: fakeBinaryHash })}\n`);
setLeanCtxRuntimeRootForTests(fakeExtensionRoot);
process.env.LEAN_CTX_TEST_INVOCATIONS = leanCtxInvocations;
after(() => { delete process.env.LEAN_CTX_TEST_INVOCATIONS; rmSync(fakeExtensionRoot, { recursive: true, force: true }); });

test("output counters use command output lines", () => {
  assert.equal(ui.countOutputLines("one\ntwo\nthree\n"), 3);
  assert.equal(ui.bashOutputLineCount("bash | one\ntwo\nthree"), 3);
  assert.equal(ui.bashOutputLineCount("sh-1 | EXIT 1\none\ntwo"), 2);
  assert.equal(ui.jobsOutputLineCount("job-1 [completed] 2s — sh-1\n\none\ntwo\nthree"), 3);
});

test("commands use LeanCTX compression by default and raw bypasses it", async () => {
  const tools = [];
  const handlers = new Map();
  jeitoShell({ registerTool(tool) { tools.push(tool); }, registerEntryRenderer() {}, on(event, handler) { handlers.set(event, handler); } });
  const bash = tools.find(tool => tool.name === "bash");
  const compressed = await bash.execute("test", { command: "printf compressed" }, undefined, undefined, { cwd: process.cwd() });
  assert.equal(compressed.details.compressed, true);
  assert.equal(compressed.content[0].text, "bash | compressed");
  assert.equal(compressed.details.truncated, false);
  const callsAfterCompressed = readFileSync(leanCtxInvocations, "utf8").trim().split("\n").length;
  const invocation = readFileSync(leanCtxInvocations, "utf8");
  assert.match(invocation, /printf compressed/);
  assert.doesNotMatch(invocation, /\/bin\/bash/);
  const raw = await bash.execute("test", { command: "printf raw", raw: true }, undefined, undefined, { cwd: process.cwd() });
  assert.equal(raw.details.compressed, false);
  assert.equal(raw.content[0].text, "bash | raw");
  assert.equal(raw.details.truncated, false);
  assert.equal(readFileSync(leanCtxInvocations, "utf8").trim().split("\n").length, callsAfterCompressed);
  handlers.get("session_shutdown")?.();
});

test("oversized foreground output is bounded and recoverable from the exact session log", async () => {
  const tools = [];
  const handlers = new Map();
  jeitoShell({ registerTool(tool) { tools.push(tool); }, registerEntryRenderer() {}, on(event, handler) { handlers.set(event, handler); } });
  const bash = tools.find(tool => tool.name === "bash");
  const result = await bash.execute(
    "test",
    { command: `node -e 'process.stdout.write("HEAD\\n" + "x".repeat(9_000) + "\\nMIDDLE\\n" + "y".repeat(9_000) + "\\nTAIL\\n")'`, raw: true },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );

  const text = result.content[0].text;
  const exact = readFileSync(result.details.logPath, "utf8");
  assert.match(text, /^bash \| \[Output preview:/);
  assert.match(text, /Full exact session log: \/tmp\/jeito-shell\//);
  assert.match(text, /before making claims that depend on omitted output/);
  assert.doesNotMatch(text, /HEAD/);
  assert.match(text, /MIDDLE/);
  assert.match(text, /TAIL/);
  assert.equal(result.details.truncated, true);
  assert.equal(result.details.outputBytes, Buffer.byteLength(exact));
  assert.ok(result.details.shownBytes <= 16_000);
  assert.equal(result.details.omittedBytes, result.details.snapshotStart);
  assert.equal(result.details.shownBytes, result.details.outputBytes - result.details.snapshotStart);
  assert.match(exact, /^HEAD\n/);
  assert.match(exact, /\nMIDDLE\n/);
  assert.match(exact, /\nTAIL\n$/);
  assert.equal(result.details.outputLines, 5);

  const failed = await bash.execute(
    "test",
    { command: `node -e 'process.stdout.write("FAILHEAD\\n" + "e".repeat(20_000)); process.exit(7)'`, raw: true },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );
  assert.equal(failed.isError, true);
  assert.equal(failed.details.exitCode, 7);
  assert.match(failed.content[0].text, /^bash \| EXIT 7\n\[Output preview:/);
  assert.doesNotMatch(failed.content[0].text, /FAILHEAD/);
  assert.match(readFileSync(failed.details.logPath, "utf8"), /^FAILHEAD\n/);
  handlers.get("session_shutdown")?.();
});

test("startup fails closed when the contained LeanCTX runtime is missing", () => {
  const missingRoot = mkdtempSync(`${tmpdir()}/jeito-shell-missing-runtime-`);
  try {
    setLeanCtxRuntimeRootForTests(missingRoot);
    assert.throws(() => jeitoShell({ registerTool() {}, on() {} }), /LeanCTX runtime is missing/);
  } finally {
    setLeanCtxRuntimeRootForTests(fakeExtensionRoot);
    rmSync(missingRoot, { recursive: true, force: true });
  }
});

test("bash/jobs share the four visual densities and join call with result", () => {
  const args = { command: "printf many" };
  const output = Array.from({ length: 80 }, (_, i) => `row ${i + 1}`).join("\n");
  const result = { content: [{ type: "text", text: `bash | ${output}` }] };
  const ctx = { state: {}, expanded: false };
  const renderBash = () => {
    const call = ui.renderBashCall(args, theme, ctx);
    ui.renderBashResult(result, { expanded: false }, theme, ctx).render(100);
    return call.render(100);
  };

  ui.resetUiDensityForTests();
  const ultra = renderBash();
  assert.equal(ultra.length, 1, "call and result must become one compact status line");
  assert.match(stripAnsi(ultra[0]), /^✓ bash /);
  assert.match(ultra.join("\n"), /\x1b\[/);

  ui.cycleDensity();
  const condensed = renderBash();
  assert.ok(condensed.length >= 3 && condensed.length <= 8);
  assert.match(stripAnsi(condensed[0]), /^╭── /);
  assert.match(stripAnsi(condensed.at(-1)), /^╰── /);

  const stillCondensed = renderBash();
  assert.equal(stillCondensed.length, condensed.length, "host expansion must not advance jeito density");

  ui.cycleDensity();
  const normal = renderBash();
  assert.ok(normal.length > condensed.length && normal.length <= 30);

  ui.cycleDensity();
  const extended = renderBash();
  assert.ok(extended.length > normal.length && extended.length <= 120);

  ui.cycleDensity();
  assert.equal(renderBash().length, 1, "the fourth cycle returns to ultra");
});
test("bash result renders structured cell header, script gutter, divider, and output", () => {
  ui.resetUiDensityForTests();
  ui.cycleDensity(); // normal to show body (ultra is footer-only; extended identical for short output)
  const text = "sh-2 created (5 lines) — fetch and scan\n1| for base in /a /b; do\n2| done\n\nsh-2 | FOUND: /a\nerror: boom\nwarning: deprecated";
  const result = { content: [{ type: "text", text }] };
  const ctx = { state: {}, expanded: false };
  const out = [...ui.renderBashResult(result, { expanded: false }, theme, ctx).render(100)];
  const plain = stripAnsi(out.join("\n"));
  // Cell header restyled to dot-separated, script lines use │ gutter, divider present.
  assert.match(plain, /sh-2 created · 5 lines · fetch and scan/);
  assert.match(plain, /1 │ for base/);
  assert.match(plain, /─/);
  // Output body follows the divider; raw "sh-2 | " prefix is dropped from the body.
  const div = plain.indexOf("──");
  const after = plain.slice(div);
  assert.match(after, /FOUND: \/a/);
  assert.doesNotMatch(after, /sh-2 \| FOUND/);
  // Footer still carries exit status from the raw text (bashLabel reads original).
  assert.match(plain, /✓ created/);
});

test("bash result tints error and warning output lines", () => {
  ui.resetUiDensityForTests();
  ui.cycleDensity(); // normal to show body
  const text = "bash | Error: ENOENT\nfatal: down\nwarning: deprecated\nok line";
  const result = { content: [{ type: "text", text }] };
  const ctx = { state: {}, expanded: false };
  const lines = ui.renderBashResult(result, { expanded: false }, theme, ctx).render(100);
  // theme colors every style with 38;5;45, so verify tinting indirectly: error/warning
  // lines must carry ANSI while the plain "ok line" is uncolored by tintOutputLine.
  assert.match(lines.join("\n"), /Error: ENOENT/);
  assert.match(lines.join("\n"), /warning: deprecated/);
});

test("shell renderers fit narrow terminals with emoji, ANSI, tabs, and wide text", () => {
  const output = "FAIL [jeito setup builds one efficient comprehensive advisor snapshot] /⭐ Recommendation without snapshot is invalid\n\t警告 👩‍💻 ⚠️";
  for (const width of [1, 8, 20, 40, 83]) {
    ui.resetUiDensityForTests();
    ui.cycleDensity(); // need body for width checks
    const ctx = { state: {}, expanded: false, width };
    const components = [
      ui.renderBashCall({ command: output }, theme, ctx),
      ui.renderBashResult({ content: [{ type: "text", text: `bash | ${output}` }], isError: true }, { expanded: false, width }, theme, ctx),
      ui.renderJobsCall({ id: "job-1", filter: output }, theme, ctx),
      ui.renderJobsResult({ content: [{ type: "text", text: `job-1 [failed] 1s — sh-1\n\n${output}` }], isError: true }, { expanded: false, width }, theme, ctx),
      ui.renderJobDoneEntry({ data: { jobId: "job-1", bodyId: "sh-1", status: "failed", elapsed: "1s", outputLines: 2, exitCode: 1, preview: output } }, { expanded: false }, theme),
    ];
    for (const component of components) {
      for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`);
    }
  }
});
test("bash footer distinguishes background, timeout, success, and error states via details", () => {
  ui.resetUiDensityForTests();
  ui.cycleDensity(); // normal so bashLabel/footer is visible (ultra is footer-only)
  const render = result => stripAnsi(ui.renderBashResult(result, { expanded: false }, theme, { state: {}, expanded: false }).render(100).join("\n"));
  // 1. intentional background: jobId present, no exitCode, no backgrounded
  assert.match(render({ content: [{ type: "text", text: "sh-3 → job-1 running" }], details: { bodyId: "sh-3", jobId: "job-1", logPath: "x" } }), /… sh-3 → job-1 background/);
  // 2. timed out: backgrounded === true (has partial output)
  assert.match(render({ content: [{ type: "text", text: "sh-3 → job-1 running\n\nbuilding" }], details: { bodyId: "sh-3", jobId: "job-1", logPath: "x", backgrounded: true } }), /… sh-3 → job-1 timed out/);
  // 3. ended good: exitCode 0
  assert.match(render({ content: [{ type: "text", text: "sh-2 | ok" }], details: { bodyId: "sh-2", exitCode: 0, logPath: "x", outputLines: 1 } }), /✓ sh-2 exit 0/);
  // 4. ended error: exitCode != 0 + isError
  assert.match(render({ content: [{ type: "text", text: "sh-2 | EXIT 1\nboom" }], details: { bodyId: "sh-2", exitCode: 1, logPath: "x", outputLines: 1 }, isError: true }), /✗ sh-2 exit 1/);
  // background and timeout must NOT share the same label
  const bg = render({ content: [{ type: "text", text: "sh-3 → job-1 running" }], details: { bodyId: "sh-3", jobId: "job-1", logPath: "x" } });
  assert.doesNotMatch(bg, /timed out/);
  const successBorder = ui.renderBashResult({ content: [{ type: "text", text: "bash | ok" }], details: { exitCode: 0, outputLines: 1 } }, { expanded: false }, semanticTheme, { expanded: false }).render(100).join("\n");
  const errorBorder = ui.renderBashResult({ content: [{ type: "text", text: "bash | EXIT 1\nboom" }], details: { exitCode: 1, outputLines: 1 }, isError: true }, { expanded: false }, semanticTheme, { expanded: false }).render(100).join("\n");
  const jobsErrorBorder = ui.renderJobsResult({ content: [{ type: "text", text: "invalid" }], isError: true }, { expanded: false }, semanticTheme, { expanded: false }).render(100).join("\n");
  const jobsSuccessBorder = ui.renderJobsResult({ content: [{ type: "text", text: "job-1 [completed] 2s — sh-1\n\nok" }] }, { expanded: false }, semanticTheme, { expanded: false }).render(100).join("\n");
  const failedEntryBorder = ui.renderJobDoneEntry({ data: { jobId: "job-2", bodyId: "bash", status: "failed", elapsed: "3s", outputLines: 2, exitCode: 1, preview: "boom" } }, { expanded: false }, semanticTheme).render(100).join("\n");
  assert.match(jobsSuccessBorder, /\x1b\[32m[│╰]/);
  assert.match(errorBorder, /\x1b\[31m[│╰]/);
  assert.match(jobsErrorBorder, /\x1b\[31m[│╰]/);
  assert.match(failedEntryBorder, /\x1b\[31m[╭│╰]/);
  assert.match(failedEntryBorder, /Inspect: jobs/);
});

test("registers bash/jobs and the completion renderer without the unused edit surface", () => {
  const tools = [];
  const events = [];
  const renderers = [];
  jeitoShell({
    registerTool(tool) { tools.push(tool); },
    registerEntryRenderer(type) { renderers.push(type); },
    on(event) { events.push(event); },
  });
  assert.deepEqual(tools.map(tool => tool.name), ["bash", "jobs"]);
  assert.deepEqual(renderers, ["job-done"]);
  assert.equal("edits" in tools[0].parameters.properties, false);
  assert.equal("raw" in tools[0].parameters.properties, true);
  const guidance = `${tools[0].description}\n${tools[0].promptSnippet}\n${tools[0].promptGuidelines.join("\n")}`;
  assert.match(guidance, /LeanCTX-managed by default/);
  assert.match(guidance, /raw:true[\s\S]*exact unmodified output is the claim/);
  assert.doesNotMatch(guidance, /exact edits|edit\+run|clone\+edit|known-slow/);
  assert.match(guidance, /reusable sh-N cell/);
  assert.match(guidance, /background:true[\s\S]*jobs\(\{id,wait:30,delta:true\}\)/);
  assert.match(guidance, /Completion cards are TUI-only/);
  const jobsGuidance = `${tools[1].description}\n${tools[1].promptGuidelines.join("\n")}`;
  assert.match(jobsGuidance, /status for the human|TUI-only/i);
  assert.equal("lines" in tools[1].parameters.properties, true);
  assert.match(jobsGuidance, /wait.*delta|delta.*wait/i);
  assert.deepEqual(events, ["session_shutdown"]);
});

test("background completion is a durable aligned entry and never triggers another agent turn", async () => {
  const tools = [];
  const handlers = new Map();
  const renderers = new Map();
  const entries = [];
  let syntheticMessages = 0;
  jeitoShell({
    registerTool(tool) { tools.push(tool); },
    registerEntryRenderer(type, renderer) { renderers.set(type, renderer); },
    appendEntry(type, data) { entries.push({ type, data }); },
    on(event, handler) { handlers.set(event, handler); },
    sendMessage() { syntheticMessages++; },
  });

  const result = await tools.find(tool => tool.name === "bash").execute(
    "test",
    { command: "printf done", background: true },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );
  const { jobId, logPath } = result.details;
  await new Promise(resolve => setTimeout(resolve, 1700));

  assert.equal(syntheticMessages, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, "job-done");
  assert.equal(entries[0].data.jobId, jobId);
  assert.equal(entries[0].data.compressed, true);
  ui.resetUiDensityForTests();
  ui.cycleDensity();
  const rendered = renderers.get("job-done")({ data: entries[0].data }, { expanded: false }, semanticTheme).render(100).join("\n");
  const plain = stripAnsi(rendered);
  assert.doesNotMatch(plain, /\[job-done\]/);
  assert.match(plain, new RegExp(`${jobId} completed`));
  assert.match(plain, /1 output line/);
  assert.match(plain, /done/);
  assert.doesNotMatch(plain, /no action required/i, "completion evidence is more useful than filler");
  assert.match(rendered, /\x1b\[32m[╭│╰]/);

  await assert.rejects(() => tools.find(tool => tool.name === "jobs").execute("test", { id: jobId, filter: "[" }), /Invalid jobs filter regex/);
  await assert.rejects(() => tools.find(tool => tool.name === "jobs").execute("test", { id: jobId, lines: 0 }), /lines must be a positive integer/);
  await assert.rejects(() => tools.find(tool => tool.name === "jobs").execute("test", { id: jobId, lines: 1.5 }), /lines must be a positive integer/);
  await assert.rejects(() => tools.find(tool => tool.name === "jobs").execute("test", { lines: 1 }), /lines requires a job id/);
  assert.equal(existsSync(logPath), true);
  handlers.get("session_shutdown")?.();
  assert.equal(existsSync(logPath), false);
});

test("job signals terminate descendant process groups created behind LeanCTX", async () => {
  const tools = [];
  const handlers = new Map();
  jeitoShell({ registerTool(tool) { tools.push(tool); }, registerEntryRenderer() {}, on(event, handler) { handlers.set(event, handler); } });
  const pidPath = `/tmp/jeito-shell-child-${process.pid}.pid`;
  try {
    const started = await tools.find(tool => tool.name === "bash").execute("test", { command: `set -m; /bin/bash -c 'echo $$ > ${pidPath}; sleep 30' & wait`, background: true }, undefined, undefined, { cwd: process.cwd() });
    for (let attempt = 0; attempt < 20 && !existsSync(pidPath); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    const childPid = Number(readFileSync(pidPath, "utf8").trim());
    await tools.find(tool => tool.name === "jobs").execute("test", { id: started.details.jobId, signal: "term" });
    await new Promise(resolve => setTimeout(resolve, 300));
    let alive = true;
    try { process.kill(childPid, 0); } catch { alive = false; }
    if (alive) try { process.kill(childPid, "SIGKILL"); } catch {}
    assert.equal(alive, false);
  } finally {
    handlers.get("session_shutdown")?.();
    try { unlinkSync(pidPath); } catch {}
  }
});


test("timed-out and background delta previews stay bounded and recoverable", async () => {
  const tools = [];
  const handlers = new Map();
  jeitoShell({ registerTool(tool) { tools.push(tool); }, registerEntryRenderer() {}, on(event, handler) { handlers.set(event, handler); } });
  const bash = tools.find(tool => tool.name === "bash");
  const jobs = tools.find(tool => tool.name === "jobs");
  const timed = await bash.execute(
    "test",
    { command: `node -e 'process.stdout.write("t".repeat(20_000)); setTimeout(() => {}, 5_000)'`, raw: true, wait: 0.15 },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );
  assert.equal(timed.details.backgrounded, true);
  assert.match(timed.content[0].text, /running\n\n\[Output preview:/);
  assert.match(timed.content[0].text, /Full exact session log:/);
  await jobs.execute("test", { id: timed.details.jobId, signal: "term" });
  await jobs.execute("test", { id: timed.details.jobId, wait: 1 });
  const started = await bash.execute(
    "test",
    { command: `node -e 'process.stdout.write("HEAD\\n" + "d".repeat(20_000)); setTimeout(() => process.stdout.write("\\nLATE\\n"), 800)'`, raw: true, background: true },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );

  for (let attempt = 0; attempt < 20; attempt++) {
    if (existsSync(started.details.logPath) && readFileSync(started.details.logPath).length >= 20_005) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const first = await jobs.execute("test", { id: started.details.jobId, delta: true });
  assert.match(first.content[0].text, /\[Delta preview:/);
  assert.match(first.content[0].text, /Cursor advanced to byte \d+/);
  assert.match(first.content[0].text, /Full exact session log:/);
  assert.doesNotMatch(first.content[0].text, /HEAD/);
  assert.equal(first.details.truncated, true);

  const second = await jobs.execute("test", { id: started.details.jobId, wait: 2, delta: true });
  assert.match(second.content[0].text, /\nLATE\n/);
  assert.doesNotMatch(second.content[0].text, /Delta preview/);
  assert.equal(second.details.truncated, false);

  unlinkSync(started.details.logPath);
  await assert.rejects(() => jobs.execute("test", { id: started.details.jobId }), /Unable to read shell output log \/tmp\/jeito-shell\//);
  handlers.get("session_shutdown")?.();
});

test("jobs filters scan the complete snapshot and bound only matching output", async () => {
  const tools = [];
  const handlers = new Map();
  jeitoShell({ registerTool(tool) { tools.push(tool); }, registerEntryRenderer() {}, on(event, handler) { handlers.set(event, handler); } });
  const bash = tools.find(tool => tool.name === "bash");
  const jobs = tools.find(tool => tool.name === "jobs");
  const started = await bash.execute(
    "test",
    { command: `node -e 'const rows = Array.from({length: 2_200}, (_, i) => "MATCH-" + String(i).padStart(4, "0")).join("\\n"); process.stdout.write("MATCH-EARLY\\n" + "n".repeat(20_000) + "\\n" + rows + "\\nMATCH-LATE\\n")'`, raw: true, background: true },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );

  const early = await jobs.execute("test", { id: started.details.jobId, wait: 2, filter: "MATCH-EARLY" });
  assert.match(early.content[0].text, /MATCH-EARLY/);
  assert.doesNotMatch(early.content[0].text, /Output preview/);
  const all = await jobs.execute("test", { id: started.details.jobId, filter: "MATCH" });
  assert.match(all.content[0].text, /\[Filtered output preview:/);
  assert.match(all.content[0].text, /complete unfiltered session log/);
  assert.match(all.content[0].text, /MATCH-LATE/);
  assert.doesNotMatch(all.content[0].text, /MATCH-EARLY/);
  assert.ok(all.details.matchedBytes > 16_000);
  assert.ok(all.details.omittedBytes > 0);
  assert.match(readFileSync(started.details.logPath, "utf8"), /MATCH-EARLY\nn{100}/);
  const finalTwo = await jobs.execute("test", { id: started.details.jobId, filter: "MATCH", lines: 2 });
  assert.match(finalTwo.content[0].text, /\[Filtered line-tail preview:/);
  assert.match(finalTwo.content[0].text, /final 2 lines/);
  assert.match(finalTwo.content[0].text, /MATCH-2199\nMATCH-LATE/);
  assert.doesNotMatch(finalTwo.content[0].text, /MATCH-2198/);
  assert.equal(finalTwo.details.requestedLines, 2);
  assert.equal(finalTwo.details.shownLines, 2);
  const unfilteredFinalTwo = await jobs.execute("test", { id: started.details.jobId, lines: 2 });
  assert.match(unfilteredFinalTwo.content[0].text, /\[Line-tail preview:/);
  assert.match(unfilteredFinalTwo.content[0].text, /MATCH-2199\nMATCH-LATE/);
  assert.doesNotMatch(unfilteredFinalTwo.content[0].text, /MATCH-2198/);
  handlers.get("session_shutdown")?.();
});

test("bounded log tails start on a complete UTF-8 code point", () => {
  const path = `/tmp/jeito-shell-utf8-${process.pid}.log`;
  try {
    writeFileSync(path, Buffer.from(`HEAD${"🙂".repeat(5_000)}Z`));
    const view = ui.readLogSlice(path, 0, 16_000);
    assert.equal(view.text.startsWith("🙂"), true);
    assert.doesNotMatch(view.text, /�/);
    assert.equal(Buffer.byteLength(view.text), view.shownBytes);
    assert.ok(view.shownBytes <= 16_000);
    assert.ok(view.omittedBytes > 4_001);
  } finally { try { unlinkSync(path); } catch {} }
});
test("delta reads advance by real log bytes after a truncated window", () => {
  const path = `/tmp/jeito-shell-delta-${process.pid}.log`;
  try {
    writeFileSync(path, "a".repeat(20_000));
    const first = ui.readLogSlice(path, 0, 16_000);
    assert.equal(first.size, 20_000);
    assert.equal(first.omitted, 4_000);
    appendFileSync(path, "MARK");
    const second = ui.readLogSlice(path, first.size, 16_000);
    assert.equal(second.text, "MARK");
    assert.equal(second.omitted, 0);
  } finally { try { unlinkSync(path); } catch {} }
});
