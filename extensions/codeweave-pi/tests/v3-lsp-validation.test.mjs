import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { applyPatch } from "../src/core/patch-apply.ts";
import { shutdownLspValidation, validateLspPaths } from "../src/core/lsp-validation.ts";
import { registerLspValidateTool } from "../src/tools/lsp-validate.ts";
import { renderLspValidateResult } from "../src/core/tui-render.ts";
import { renderRead } from "../src/core/read-renderer.ts";

const HEADER_RE = /^\[([^\]\n]+)#([A-F0-9]{8})\]$/m;
async function fixture() { return mkdtemp(join(tmpdir(), "pi-nav-lsp-")); }
test.after(async () => { await shutdownLspValidation(); });
test.beforeEach(async () => { await shutdownLspValidation(); });
function lspTool() {
  let tool;
  registerLspValidateTool({ registerTool(value) { tool = value; } });
  return tool;
}

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const plain = value => String(value).replace(ANSI_RE, "");


function fakeDependencies(options = {}) {
  const calls = { init: [], warm: [], touch: [], shutdown: 0, reset: 0, active: new Map(), max: new Map(), contents: new Map() };
  const service = {
    supportsLSP: path => /\.(ts|py)$/.test(path),
    async ensureWarmForSweep(path) {
      calls.warm.push(path);
      if (basename(path).startsWith("install")) throw new Error("primary server unavailable");
    },
    async touchFile(path, content, { signal }) {
      const group = path.endsWith(".py") ? "python" : "typescript";
      const active = (calls.active.get(group) ?? 0) + 1;
      calls.active.set(group, active);
      calls.max.set(group, Math.max(calls.max.get(group) ?? 0, active));
      calls.touch.push(path);
      calls.contents.set(path, content);
      try {
        if (basename(path).startsWith("slow")) return await new Promise(resolve => signal?.addEventListener("abort", () => resolve(Object.assign([], { inconclusive: true })), { once: true }));
        if (basename(path).startsWith("crash")) throw new Error("fake server crashed");
        await new Promise(resolve => setTimeout(resolve, options.delayMs ?? 0));
        if (basename(path).startsWith("missing")) return undefined;
        if (basename(path).startsWith("silent")) return Object.assign([], { inconclusive: true });
        if (basename(path).startsWith("warning")) return [{ severity: 2, message: "fake warning" }];
        if (basename(path).startsWith("diagnostic") || basename(path).startsWith("push")) return [{ severity: 1, message: "fake diagnostic" }];
        return [];
      } finally {
        calls.active.set(group, (calls.active.get(group) ?? 1) - 1);
      }
    },
    async shutdown() { calls.shutdown++; },
  };
  const dependencies = {
    async initConfig(root) { calls.init.push(root); },
    getService: () => service,
    groupFiles(paths) {
      const groups = new Map();
      for (const path of paths) {
        const id = path.endsWith(".py") ? "python" : "typescript";
        if (!groups.has(id)) groups.set(id, { id, files: [] });
        groups.get(id).files.push(path);
      }
      return [...groups.values()];
    },
    async runGroups(groups, concurrency, worker, signal) {
      assert.ok(concurrency >= 1);
      await Promise.all(groups.map(group => signal?.aborted ? undefined : worker(group)));
    },
    resetService() { calls.reset++; },
  };
  return { dependencies, calls };
}

async function fakeLspServer(cwd) {
  const server = join(cwd, "fake-lsp.mjs");
  await writeFile(server, `let buffer=Buffer.alloc(0); const mode=process.argv[2]; const send=m=>{const body=Buffer.from(JSON.stringify(m)); process.stdout.write('Content-Length: '+body.length+'\\r\\n\\r\\n'); process.stdout.write(body);}; const diagnostic={range:{start:{line:0,character:0},end:{line:0,character:1}},severity:1,message:'fake '+mode+' diagnostic',source:'fake-'+mode}; process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]); while(true){const marker=buffer.indexOf('\\r\\n\\r\\n'); if(marker<0)return; const head=buffer.subarray(0,marker).toString(); const length=Number(/Content-Length:\\s*(\\d+)/i.exec(head)?.[1]); if(buffer.length<marker+4+length)return; const message=JSON.parse(buffer.subarray(marker+4,marker+4+length)); buffer=buffer.subarray(marker+4+length); if(message.method==='initialize') send({jsonrpc:'2.0',id:message.id,result:{capabilities:{textDocumentSync:1,...(mode==='pull'?{diagnosticProvider:{interFileDependencies:false,workspaceDiagnostics:false}}:{})}}}); else if(message.method==='textDocument/diagnostic') send({jsonrpc:'2.0',id:message.id,result:{kind:'full',items:[diagnostic]}}); else if(message.method==='textDocument/didOpen'&&mode==='push') setTimeout(()=>send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri:message.params.textDocument.uri,diagnostics:[diagnostic]}}),5); else if(message.method==='shutdown') send({jsonrpc:'2.0',id:message.id,result:null}); else if(message.method==='exit') process.exit(0); else if(message.id!==undefined) send({jsonrpc:'2.0',id:message.id,result:null}); }});`);
  return server;
}

test("pinned pi-lens compatibility seam exports only the required standalone LSP primitives", async () => {
  const lsp = await import("pi-lens/dist/clients/lsp/index.js");
  const config = await import("pi-lens/dist/clients/lsp/config.js");
  for (const name of ["getLSPService", "resetLSPService", "groupFilesByPrimaryServer", "runPerServerGroups"]) assert.equal(typeof lsp[name], "function");
  for (const name of ["initLSPConfig", "primaryServerId", "getServersForFileWithConfig"]) assert.equal(typeof config[name], "function");
});

test("public lsp_validate normalizes safe scalar calls and renders actionable invalid-call evidence", async () => {
  const cwd = await fixture();
  await writeFile(join(cwd, "notes.txt"), "text\n");
  const tool = lspTool();
  const normalized = await tool.execute("lsp-scalar", { paths: "notes.txt", limit: "5", includeWarnings: false }, undefined, undefined, { cwd });
  assert.deepEqual(normalized.details.callNormalizations, ["scalar paths → one-item paths array", "lsp_validate limit numeric string → 5"]);
  assert.equal(normalized.details.files[0].status, "unsupported");
  const invalid = await tool.execute("lsp-empty", { paths: [] }, undefined, undefined, { cwd });
  assert.equal(invalid.details.validation.kind, "tool-call-validation");
  assert.match(invalid.content[0].text, /INVALID CALL: lsp_validate[\s\S]*at least one non-empty/);
  const rendered = plain(renderLspValidateResult(invalid, {}, {}, {}).render(140).join("\n"));
  assert.match(rendered, /Accepted forms:[\s\S]*Nothing executed[\s\S]*lsp_validate invalid call/);
});

test("scoped validation preserves input order and distinguishes unsupported from missing", async () => {
  const cwd = await fixture();
  const a = join(cwd, "a.txt");
  const b = join(cwd, "b.unknown");
  await writeFile(a, "a\n");
  await writeFile(b, "b\n");
  const result = await validateLspPaths({ cwd, paths: ["b.unknown", "missing.ts", "a.txt"] });
  assert.deepEqual(result.files.map(file => file.path), [join(result.root, "b.unknown"), join(result.root, "missing.ts"), join(result.root, "a.txt")]);
  assert.deepEqual(result.files.map(file => file.status), ["unsupported", "skipped", "unsupported"]);
});

test("directory scans error instead of silently truncating and explicit external files are accepted", async () => {
  const cwd = await fixture();
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, "src", "a.txt"), "a\n");
  await writeFile(join(cwd, "src", "b.txt"), "b\n");
  await assert.rejects(validateLspPaths({ cwd, paths: ["src"], limit: 1 }), /more than 1 files/);
  const outside = await fixture();
  await writeFile(join(outside, "outside.txt"), "outside\n");
  const external = await validateLspPaths({ cwd, paths: [join(outside, "outside.txt")] });
  assert.equal(external.files[0]?.status, "unsupported");
});

test("CHECK LSP validates only the final landed canonical path and remains advisory", async () => {
  const cwd = await fixture();
  const path = join(cwd, "checked.txt");
  await writeFile(path, "one\n");
  const read = (await renderRead({ cwd, path: `${path}:1` })).text;
  const match = HEADER_RE.exec(read);
  assert.ok(match);
  const result = await applyPatch({ cwd, patch: `[${match[1]}#${match[2]}]\nREPLACE 1:\n+ONE\nCHECK LSP` });
  assert.equal(result.details.status, "success");
  assert.match(result.text, /Unsupported: .*checked\.txt/);
  assert.equal(await readFile(path, "utf8"), "ONE\n");
});

test("CHECK LSP with no landed content reports skipped", async () => {
  const cwd = await fixture();
  const path = join(cwd, "unchanged.txt");
  await writeFile(path, "one\n");
  const read = (await renderRead({ cwd, path: `${path}:1` })).text;
  const match = HEADER_RE.exec(read);
  assert.ok(match);
  const result = await applyPatch({ cwd, patch: `[${match[1]}#${match[2]}]\nCHECK LSP` });
  assert.match(result.text, /LSP validation skipped/);
  assert.equal(await readFile(path, "utf8"), "one\n");
});

test("deterministic fake primary services preserve diagnostics, clean, unconfirmed, unavailable, crash, and severity states", async () => {
  const cwd = await fixture();
  const names = ["diagnostic.ts", "push.ts", "clean.ts", "silent.ts", "missing.ts", "crash.ts", "warning.ts", "unsupported.txt"];
  await Promise.all(names.map(name => writeFile(join(cwd, name), `content-${name}\n`)));
  const { dependencies, calls } = fakeDependencies();
  const progress = [];
  const result = await validateLspPaths({ cwd, paths: names, dependencies, onProgress: event => progress.push(event) });
  assert.deepEqual(result.files.map(file => file.status), ["diagnostics", "diagnostics", "clean", "unconfirmed", "unavailable", "unavailable", "clean", "unsupported"]);
  assert.deepEqual(calls.touch.map(path => basename(path)), names.slice(0, 7));
  assert.equal([...calls.contents.entries()].find(([path]) => basename(path) === "diagnostic.ts")?.[1], "content-diagnostic.ts\n");
  assert.deepEqual([...new Set(progress.map(item => item.phase))], ["detecting", "warming", "checking"]);

  await shutdownLspValidation();
  const warned = fakeDependencies();
  const withWarnings = await validateLspPaths({ cwd, paths: ["warning.ts"], includeWarnings: true, dependencies: warned.dependencies });
  assert.equal(withWarnings.files[0].status, "diagnostics");
});

test("the first confirmed diagnostics touch is the group warmup instead of an unchanged duplicate round trip", async () => {
  const cwd = await fixture();
  await writeFile(join(cwd, "clean.ts"), "export const clean = true;\n");
  const fake = fakeDependencies();
  const result = await validateLspPaths({ cwd, paths: ["clean.ts"], dependencies: fake.dependencies });
  assert.equal(result.files[0].status, "clean");
  assert.equal(fake.calls.warm.length, 0, "codeweave-pi must not warm with one diagnostics touch then immediately repeat the same content");
  assert.deepEqual(fake.calls.touch.map(path => basename(path)), ["clean.ts"]);
});

test("mixed primary-server groups run in parallel but files stay serial within each server", async () => {
  const cwd = await fixture();
  const names = ["a.ts", "b.ts", "a.py", "b.py"];
  await Promise.all(names.map(name => writeFile(join(cwd, name), "ok\n")));
  const { dependencies, calls } = fakeDependencies({ delayMs: 20 });
  const result = await validateLspPaths({ cwd, paths: names, dependencies });
  assert.ok(result.files.every(file => file.status === "clean"));
  assert.equal(calls.max.get("typescript"), 1);
  assert.equal(calls.max.get("python"), 1);
});

test("deadlines and cancellation never turn an empty response into clean", async () => {
  const cwd = await fixture();
  await writeFile(join(cwd, "slow.ts"), "ok\n");
  let fake = fakeDependencies();
  const timed = await validateLspPaths({ cwd, paths: ["slow.ts"], dependencies: fake.dependencies, deadlineMs: 10 });
  assert.equal(timed.files[0].status, "unconfirmed");
  assert.match(timed.files[0].note, /timed out/);
  assert.match(timed.text, /do not rerun the unchanged validation/i);
  assert.match(timed.envelope.next_actions.join("\n"), /Do not retry the unchanged validation/i);

  await shutdownLspValidation();
  fake = fakeDependencies();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  const cancelled = await validateLspPaths({ cwd, paths: ["slow.ts"], dependencies: fake.dependencies, deadlineMs: 1000, signal: controller.signal });
  assert.equal(cancelled.files[0].status, "unconfirmed");
  assert.match(cancelled.files[0].note, /Cancelled/);
});

test("process-global owner is reused and shutdown resets exactly once", async () => {
  const cwd = await fixture();
  await writeFile(join(cwd, "a.ts"), "ok\n");
  const fake = fakeDependencies();
  await validateLspPaths({ cwd, paths: ["a.ts"], dependencies: fake.dependencies });
  await validateLspPaths({ cwd, paths: ["a.ts"], dependencies: { ...fake.dependencies, getService() { throw new Error("must reuse owner"); } } });
  await shutdownLspValidation();
  assert.equal(fake.calls.shutdown, 1);
  assert.equal(fake.calls.reset, 1);
});

test("symlinked external files are accepted and pinned TypeScript roots use nearest package markers, loose fallback, and Deno exclusion", async () => {
  const cwd = await fixture();
  const outside = await fixture();
  await writeFile(join(outside, "escape.ts"), "ok\n");
  await symlink(join(outside, "escape.ts"), join(cwd, "escape.ts"));
  const fake = fakeDependencies();
  const escaped = await validateLspPaths({ cwd, paths: ["escape.ts"], dependencies: fake.dependencies });
  assert.equal(escaped.files.length, 1);

  const { initLSPConfig, getServersForFileWithConfig } = await import("pi-lens/dist/clients/lsp/config.js");
  const mono = join(cwd, "mono");
  const pkg = join(mono, "packages", "app");
  await mkdir(join(pkg, "src"), { recursive: true });
  await writeFile(join(mono, "package.json"), "{}");
  await writeFile(join(pkg, "package-lock.json"), "{}");
  const marked = join(pkg, "src", "marked.ts");
  await writeFile(marked, "");
  await initLSPConfig(mono);
  const server = getServersForFileWithConfig(marked)[0];
  assert.equal(await server.root(marked), pkg);

  const looseDir = join(cwd, "loose");
  await mkdir(looseDir);
  const loose = join(looseDir, "loose.ts");
  await writeFile(loose, "");
  assert.equal(await getServersForFileWithConfig(loose)[0].root(loose), looseDir);

  const deno = join(cwd, "deno");
  await mkdir(deno);
  await writeFile(join(deno, "deno.json"), "{}");
  const denoFile = join(deno, "mod.ts");
  await writeFile(denoFile, "");
  assert.equal(await getServersForFileWithConfig(denoFile)[0].root(denoFile), undefined);
});

test("runtime module-load trace imports narrow pi-lens LSP subpaths without the full entrypoint", async () => {
  const cwd = await fixture();
  const hook = join(cwd, "hook.mjs");
  const script = join(cwd, "probe.mjs");
  const log = join(cwd, "loads.log");
  await writeFile(hook, `import { registerHooks } from 'node:module'; import { appendFileSync } from 'node:fs'; registerHooks({ resolve(specifier, context, nextResolve) { if (specifier.startsWith('pi-lens')) appendFileSync(${JSON.stringify(log)}, specifier + '\\n'); return nextResolve(specifier, context); } });`);
  await writeFile(script, `import { writeFile } from 'node:fs/promises'; import { join } from 'node:path'; import { validateLspPaths, shutdownLspValidation } from ${JSON.stringify(new URL("../src/core/lsp-validation.ts", import.meta.url).href)}; const file=join(${JSON.stringify(cwd)},'x.txt'); await writeFile(file,'x'); await validateLspPaths({cwd:${JSON.stringify(cwd)},paths:['x.txt']}); await shutdownLspValidation();`);
  const child = spawn(process.execPath, ["--import", hook, script], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(chunk));
  const status = await new Promise(resolve => child.once("exit", resolve));
  assert.equal(status, 0, Buffer.concat(stderr).toString());
  const loads = await readFile(log, "utf8");
  assert.match(loads, /pi-lens\/dist\/clients\/lsp\/config\.js/);
  assert.match(loads, /pi-lens\/dist\/clients\/lsp\/index\.js/);
  assert.doesNotMatch(loads, /^pi-lens$|pi-lens\/dist\/index\.js/m);
});


test("local stdio fake servers exercise actual pull and publish-diagnostics paths without network access", async () => {
  const cwd = await fixture();
  await writeFile(join(cwd, "package.json"), "{}\n");
  const server = await fakeLspServer(cwd);
  await mkdir(join(cwd, ".pi-lens"));
  await writeFile(join(cwd, ".pi-lens", "lsp.json"), JSON.stringify({ servers: {
    "fixture-pull": { name: "Fixture Pull", extensions: [".fakepull"], command: process.execPath, args: [server, "pull"], rootMarkers: ["package.json"] },
    "fixture-push": { name: "Fixture Push", extensions: [".fakepush"], command: process.execPath, args: [server, "push"], rootMarkers: ["package.json"] },
  } }));
  const pull = join(cwd, "a.fakepull");
  const push = join(cwd, "b.fakepush");
  await writeFile(pull, "broken\n");
  await writeFile(push, "broken\n");
  const result = await validateLspPaths({ cwd, paths: [pull, push], deadlineMs: 5_000 });
  assert.deepEqual(result.files.map(file => file.status), ["diagnostics", "diagnostics"]);
  assert.match(result.files[0].diagnostics[0].message, /fake pull diagnostic/);
  assert.match(result.files[1].diagnostics[0].message, /fake push diagnostic/);
});
test("CHECK LSP collapses repeated same-file requests to one final landed canonical path", async () => {
  const cwd = await fixture();
  const path = join(cwd, "checked.ts");
  await writeFile(path, "const a = 1;\nconst b = 2;\n");
  const read = (await renderRead({ cwd, path: `${path}:1-2` })).text;
  const match = HEADER_RE.exec(read);
  assert.ok(match);
  const header = `[${match[1]}#${match[2]}]`;
  const calls = [];
  const lspValidator = async input => {
    calls.push(input.paths);
    return { root: cwd, files: input.paths.map(file => ({ path: file, status: "clean", diagnostics: [] })), text: "LSP validation: clean fixture." };
  };
  const result = await applyPatch({ cwd, patch: `${header}\nREPLACE 1:\n+const a = 3;\nCHECK LSP\n${header}\nREPLACE 2:\n+const b = 4;\nCHECK LSP`, lspValidator });
  assert.equal(result.details.status, "success");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].map(file => basename(file)), ["checked.ts"]);
});
