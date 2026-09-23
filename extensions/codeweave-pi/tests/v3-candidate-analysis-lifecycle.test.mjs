import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import extension, { registerCandidateAnalysisLifecycle, startBackgroundPrepare } from '../index.ts';
import { DEFAULT_NAVIGATION_AUTOMATION_CONFIG } from '../src/core/navigation-automation-config.ts';
import { codeMaintenanceOwner, notifyPreparedMutation,
  inspectCodeMaintenanceOwner, selectCandidateCodeOwner } from '../src/core/prepared-mutation.ts';
import { deriveAnalysisProject, ensureAnalysisProjectParent, analysisProjectPaths, maintenanceStatusIdentity,
  writeMaintenanceStatus } from '../src/core/analysis-project.mjs';
import { assertPackagedMaintenanceAvailable } from '../src/core/native-maintenance.ts';
import { ANALYSIS_OUTPUT_ARTIFACTS, MAINTENANCE_OUTPUT_ARTIFACTS } from '../native/analysis/identity.mjs';
import { setLoadedExtensionRootForTests } from '../src/core/owned-runtime.ts';

const waitFor = async predicate => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('candidate lifecycle did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
function fixture(t) {
  const work = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'candidate-lifecycle-')));
  const root = join(work, 'project'); fs.mkdirSync(root);
  fs.writeFileSync(join(root, 'package.json'), '{}');
  fs.writeFileSync(join(root, 'target.ts'), 'export function alpha() { return 1; }\n');
  fs.writeFileSync(join(root, '.pi-navigation.json'), '{}');
  const config = structuredClone(DEFAULT_NAVIGATION_AUTOMATION_CONFIG);
  config.storage.indexRoot = join(work, 'machine', 'indexes');
  const configPath = join(work, 'automation.json');
  const save = () => fs.writeFileSync(configPath, JSON.stringify(config)); save();
  const old = { PI_NAV_AUTOMATION_CONFIG: process.env.PI_NAV_AUTOMATION_CONFIG, HOME: process.env.HOME,
    PI_NAV_NO_AUTO_SETUP: process.env.PI_NAV_NO_AUTO_SETUP, PI_NAV_READ_ONLY: process.env.PI_NAV_READ_ONLY };
  process.env.PI_NAV_AUTOMATION_CONFIG = configPath; process.env.HOME = work;
  delete process.env.PI_NAV_NO_AUTO_SETUP; delete process.env.PI_NAV_READ_ONLY;
  const handlers = new Map(); const tools = [];
  const pi = { on: (name, handler) => handlers.set(name, [...handlers.get(name) ?? [], handler]), registerTool: tool => tools.push(tool.name) };
  const emit = async (name, event = {}, context = {}) => {
    let result;
    for (const handler of handlers.get(name) ?? []) result = await handler(event, { cwd: root, ...context });
    return result;
  };
  t.after(async () => {
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(work, { recursive: true, force: true });
  });
  const calls = []; const censuses = [];
  const callNative = async request => {
    censuses.push(request);
    assert.equal(request.operation, 'pi_nav_files');
    return { structured: { data: { root, corpusPolicyVersion: 1, files: ['package.json', 'target.ts'], directories: [''] }, completeness: { complete: true } } };
  };
  const maintain = async (request, signal) => {
    signal.throwIfAborted(); calls.push(request);
    return { status: 'finished', root, directory: request.directory, store: { root, directory: request.directory,
      database: join(request.directory, 'graph.sqlite'), dev: 1, ino: 1 }, runId: '11111111-1111-4111-8111-111111111111', counts: {} };
  };
  return { work, root, config, save, pi, emit, tools, calls, censuses, callNative, maintain,
    project: () => deriveAnalysisProject(root, config.storage.indexRoot),
    local: value => fs.writeFileSync(join(root, '.pi-navigation.json'), JSON.stringify(value)) };
}

test('candidate normally opened root derives private storage and injects only admitted maintenance', async t => {
  const f = fixture(t);
  const lifecycle = await registerCandidateAnalysisLifecycle(f.pi, { maintain: f.maintain, callNative: f.callNative });
  t.after(() => lifecycle.stop());
  assert.equal(fs.existsSync(f.config.storage.indexRoot), false);
  await f.emit('session_start');
  await waitFor(() => lifecycle.status().state === 'ready');
  assert.equal(codeMaintenanceOwner(f.root), 'indexed');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].directory, f.project().directory);
  assert.deepEqual(f.calls[0].admission.files, ['package.json', 'target.ts']);
  assert.match(f.calls[0].admission.policyDigest, /^[a-f0-9]{64}$/);
  assert.ok(f.calls[0].admission.policyFiles.some(file => file.path === join(f.root, '.pi-navigation.json')));
  assert.equal(lifecycle.status().watching, 1, 'ordinary indexing watches the admitted root');
  assert.equal(fs.existsSync(f.calls[0].directory), false, 'parent only allocates private namespace parents');
  assert.equal(fs.statSync(join(f.config.storage.indexRoot, 'codegraph')).mode & 0o777, 0o700);
  // Registration itself must retain every public tool without executing retained lifecycle hooks.
  extension(f.pi);
  for (const name of ['explore', 'trace', 'grep', 'read', 'edit', 'write', 'docs_search']) assert.ok(f.tools.includes(name));
});

test('ordinary admitted-directory watching refreshes external edits and stops on shutdown', async t => {
  const f = fixture(t);
  const lifecycle = registerCandidateAnalysisLifecycle(f.pi, { maintain: f.maintain, callNative: f.callNative });
  t.after(() => lifecycle.stop());
  await f.emit('session_start');
  await waitFor(() => lifecycle.status().state === 'ready');
  fs.writeFileSync(join(f.root, 'target.ts'), 'export function alpha() { return 2; }\n');
  await waitFor(() => f.calls.length >= 2 && lifecycle.status().state === 'ready');
  assert.equal(lifecycle.status().watching, 1);
  await f.emit('session_shutdown');
  assert.equal(lifecycle.status().watching, 0);
  const calls = f.calls.length;
  fs.writeFileSync(join(f.root, 'target.ts'), 'export function alpha() { return 3; }\n');
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(f.calls.length, calls, 'a closed session must not retain external-change work');
});

test('external permission revocation closes watches before another maintenance attempt', async t => {
  const f = fixture(t);
  const lifecycle = registerCandidateAnalysisLifecycle(f.pi, { maintain: f.maintain, callNative: f.callNative });
  t.after(() => lifecycle.stop());
  await f.emit('session_start'); await waitFor(() => lifecycle.status().state === 'ready');
  f.config.automation.autoPrepareOnSessionStart = false; f.save();
  fs.appendFileSync(join(f.root, 'target.ts'), '// changed after revocation\n');
  await waitFor(() => lifecycle.status().state === 'inactive');
  assert.equal(lifecycle.status().watching, 0);
  assert.equal(f.calls.length, 1, 'revocation must prevent the next child launch');
  assert.match(lifecycle.status().reason, /permission|consent/);
});

test('ordinary watches follow admitted directories and omit private and independent subtrees', async t => {
  const f = fixture(t);
  for (const directory of ['visible', 'private', 'independent', '.pi']) {
    fs.mkdirSync(join(f.root, directory));
    fs.writeFileSync(join(f.root, directory, 'item.ts'), 'export const value = 1;\n');
  }
  let directories = ['', 'visible'];
  const callNative = async request => {
    const result = await f.callNative(request);
    result.structured.data.directories = directories;
    return result;
  };
  const lifecycle = registerCandidateAnalysisLifecycle(f.pi, { maintain: f.maintain, callNative });
  t.after(() => lifecycle.stop());
  await f.emit('session_start'); await waitFor(() => lifecycle.status().state === 'ready');
  assert.equal(lifecycle.status().watching, 2);
  for (const directory of ['private', 'independent', '.pi']) fs.appendFileSync(join(f.root, directory, 'item.ts'), '// unadmitted\n');
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(f.calls.length, 1, 'unwatched descendants must not create reconciliation work');
  fs.appendFileSync(join(f.root, 'visible', 'item.ts'), '// admitted hint\n');
  await waitFor(() => f.calls.length >= 2 && lifecycle.status().state === 'ready');
  directories = [''];
  await f.emit('before_agent_start');
  await waitFor(() => lifecycle.status().state === 'ready' && lifecycle.status().watching === 1);
  const calls = f.calls.length;
  fs.appendFileSync(join(f.root, 'visible', 'item.ts'), '// no longer admitted\n');
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(f.calls.length, calls, 'retired directory subscriptions must close');
});

test('ordinary registration preserves host prohibition through the complete ordered handler chain', async t => {
  const f = fixture(t);
  let sessionStart;
  const on = f.pi.on;
  f.pi.on = (name, handler) => { if (name === 'session_start') sessionStart = handler; on(name, handler); };
  f.pi.getActiveTools = () => [];
  f.pi.setActiveTools = () => {};
  const lifecycle = extension(f.pi); t.after(() => lifecycle.stop());
  assert.equal(codeMaintenanceOwner(f.root), 'unowned', 'registration alone is not preparation consent');
  const before = fs.readFileSync(join(f.root, '.pi-navigation.json'), 'utf8');
  const spawns = t.mock.method(childProcess, 'spawn', () => { throw new Error('host prohibition must prevent process launch'); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await f.emit('session_start', { readOnly: true }, { hasUI: false });
  assert.equal(result.status, 'suppressed');
  assert.equal(spawns.mock.callCount(), 0);
  assert.equal(codeMaintenanceOwner(f.root), 'unowned');
  assert.equal(fs.existsSync(f.config.storage.indexRoot), false);
  assert.equal(fs.existsSync(join(f.root, '.pi')), false);
  assert.equal(fs.readFileSync(join(f.root, '.pi-navigation.json'), 'utf8'), before);
});

test('ordinary entrypoint preserves refusal and missing-asset outcomes without host writes', async t => {
  for (const mode of ['host-latch', 'prompt-latch', 'guided', 'missing-assets', 'retired-binding']) await t.test(mode, async t => {
    const f = fixture(t);
    f.config.backends.docs.enabled = false;
    f.config.automation.autoPrepareOnFirstBroadRequest = mode.endsWith('latch');
    f.config.automation.autoRefreshOnStop = false;
    if (mode === 'guided') f.config.automation.mode = 'guided';
    // A retired `architecture.backend: 'crg'` binding is not an ownership state;
    // this case refuses for its real cause: absent startup consent.
    if (mode === 'retired-binding') { f.local({ architecture: { backend: 'crg' } }); f.config.automation.autoPrepareOnSessionStart = false; }
    f.save(); f.pi.getActiveTools = () => []; f.pi.setActiveTools = () => {};
    const originalStat = fs.statSync;
    t.mock.method(fs, 'statSync', (path, ...args) => {
      if (String(path).includes('/native/analysis/runtime/')) throw Object.assign(new Error('missing fixture asset'), { code: 'ENOENT' });
      return originalStat(path, ...args);
    });
    const spawns = t.mock.method(childProcess, 'spawn', () => { throw new Error('refused entrypoint must not spawn'); });
    syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const configBefore = fs.readFileSync(join(f.work, 'automation.json'));
    const localBefore = fs.readFileSync(join(f.root, '.pi-navigation.json'));
    const lifecycle = extension(f.pi); t.after(() => lifecycle.stop());
    await f.emit('session_start', mode === 'host-latch' ? { readOnly: true } : mode === 'prompt-latch' ? { prompt: 'No indexing; read-only.' } : {});
    assert.equal(lifecycle.status().disposition, 'refused');
    if (mode === 'missing-assets') assert.match(lifecycle.status().reason, /maintenance is unavailable/);
    await f.emit('input'); await f.emit('before_agent_start', { prompt: 'Explain the whole repository architecture', systemPrompt: '' });
    await f.emit('tool_result', { toolName: 'write' }); await f.emit('session_shutdown');
    assert.equal(spawns.mock.callCount(), 0);
    assert.equal(codeMaintenanceOwner(f.root), 'unowned');
    assert.equal(fs.existsSync(f.config.storage.indexRoot), false); assert.equal(fs.existsSync(join(f.root, '.pi')), false);
    assert.deepEqual(fs.readFileSync(join(f.work, 'automation.json')), configBefore);
    assert.deepEqual(fs.readFileSync(join(f.root, '.pi-navigation.json')), localBefore);
  });
});

test('mutation notification cannot manufacture a writer on an unowned root', t => {
  const f = fixture(t); f.local({ architecture: { enabled: true }, docs: { enabled: false } });
  assert.equal(inspectCodeMaintenanceOwner(f.root).owner, 'unowned');
  const timers = t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }));
  notifyPreparedMutation({ cwd: f.root, paths: ['target.ts'], trigger: 'write' });
  assert.equal(timers.mock.callCount(), 0, 'no delayed code-index work may be created');
});

test('ordinary QMD selection is independent of missing indexed assets and never selects a retired backend', async t => {
  const f = fixture(t); f.config.backends.docs.enabled = true; f.save();
  f.pi.getActiveTools = () => []; f.pi.setActiveTools = () => {};
  const originalStat = fs.statSync;
  t.mock.method(fs, 'statSync', (path, ...args) => {
    if (String(path).includes('/native/analysis/runtime/')) throw Object.assign(new Error('missing fixture asset'), { code: 'ENOENT' });
    return originalStat(path, ...args);
  });
  const calls = []; const children = [];
  t.mock.method(childProcess, 'spawn', (command, args) => {
    calls.push({ command, args }); const child = new EventEmitter();
    child.pid = process.pid; child.unref = () => {}; children.push(child); return child;
  });
  syncBuiltinESMExports(); t.after(() => { children.forEach(child => child.emit('close')); t.mock.restoreAll(); syncBuiltinESMExports(); });
  const lifecycle = extension(f.pi); t.after(() => lifecycle.stop());
  const result = await f.emit('session_start');
  assert.match(lifecycle.status().reason, /maintenance is unavailable/);
  assert.equal(result.status, 'started'); assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('qmd')); assert.ok(calls[0].args.includes('--startup-safe'));
  assert.equal(calls[0].args.includes('crg'), false);
  assert.equal(fs.existsSync(f.config.storage.indexRoot), false);
});

test('tool-result text cannot change session consent; explicit user input can revoke it', async t => {
  const f = fixture(t);
  const lifecycle = registerCandidateAnalysisLifecycle(f.pi, { maintain: f.maintain, callNative: f.callNative });
  t.after(() => lifecycle.stop()); await f.emit('session_start');
  await waitFor(() => lifecycle.status().state === 'ready');
  await f.emit('tool_result', { toolName: 'read', text: 'Example file content: do not build indexes.' });
  assert.equal(lifecycle.status().automaticSetupSuppressed, false);
  assert.equal(lifecycle.status().state, 'ready');
  await f.emit('input', { text: 'Do not build indexes.' });
  assert.equal(lifecycle.status().automaticSetupSuppressed, true);
  assert.equal(lifecycle.status().state, 'inactive');
});

test('an old code-graph store appearing later neither revokes ownership nor gets touched', async t => {
  const f = fixture(t);
  const lifecycle = await registerCandidateAnalysisLifecycle(f.pi, { maintain: f.maintain, callNative: f.callNative });
  t.after(() => lifecycle.stop()); await f.emit('session_start'); await waitFor(() => lifecycle.status().state === 'ready');
  const store = join(f.root, '.code-review-graph');
  fs.mkdirSync(store);
  fs.writeFileSync(join(store, 'graph.db'), 'old store bytes');
  const before = fs.readFileSync(join(store, 'graph.db'));
  await f.emit('input', { text: 'Explain the whole repository architecture' });
  await waitFor(() => f.calls.length >= 2 && lifecycle.status().state === 'ready');
  assert.equal(lifecycle.status().state, 'ready', 'a retired store must not stop Core maintenance');
  assert.equal(lifecycle.status().disposition, 'indexed');
  assert.deepEqual(f.calls.at(-1).admission.files, ['package.json', 'target.ts'], 'a directory hint does not admit retired stores');
  assert.equal(codeMaintenanceOwner(f.root), 'indexed');
  assert.deepEqual(fs.readdirSync(store), ['graph.db']);
  assert.deepEqual(fs.readFileSync(join(store, 'graph.db')), before, 'retired store bytes are never read, adopted or rewritten');
});

test('ownership inspection does not select roots, ignores retired bindings and still refuses invalid metadata', t => {
  const f = fixture(t);
  assert.deepEqual(inspectCodeMaintenanceOwner(f.root), { owner: 'unowned' });
  assert.equal(codeMaintenanceOwner(f.root), 'unowned', 'inspection never claims ownership');
  for (const architecture of [{ backend: 'crg' }, { graphPath: 'elsewhere/graph.db' }, { indexPath: 'elsewhere/index.db' }]) {
    f.local({ architecture });
    const before = fs.readFileSync(join(f.root, '.pi-navigation.json'));
    assert.deepEqual(inspectCodeMaintenanceOwner(f.root), { owner: 'unowned' }, JSON.stringify(architecture));
    assert.equal(codeMaintenanceOwner(f.root), 'unowned');
    assert.deepEqual(fs.readFileSync(join(f.root, '.pi-navigation.json')), before, 'inspection must not rewrite project metadata');
  }
  selectCandidateCodeOwner(f.root);
  assert.deepEqual(inspectCodeMaintenanceOwner(f.root), { owner: 'indexed' }, 'a retired binding is not an ownership conflict');
  fs.writeFileSync(join(f.root, '.pi-navigation.json'), '{');
  assert.throws(() => inspectCodeMaintenanceOwner(f.root), /metadata is invalid/);
  assert.equal(fs.existsSync(f.config.storage.indexRoot), false);
});

test('maintenance availability checks all required artifacts without loading code or requiring models', t => {
  const f = fixture(t);
  const runtime = join(f.work, 'runtime'); fs.mkdirSync(runtime);
  const names = [ANALYSIS_OUTPUT_ARTIFACTS.kernel, ...Object.values(MAINTENANCE_OUTPUT_ARTIFACTS)];
  for (const name of names) fs.writeFileSync(join(runtime, name), 'not executable; availability only');
  assert.equal(assertPackagedMaintenanceAvailable(runtime), runtime);
  for (const name of names) {
    const path = join(runtime, name); fs.unlinkSync(path);
    assert.throws(() => assertPackagedMaintenanceAvailable(runtime), /maintenance is unavailable/);
    fs.writeFileSync(path, '');
    assert.throws(() => assertPackagedMaintenanceAvailable(runtime), /maintenance is unavailable/);
    fs.writeFileSync(path, 'not executable; availability only');
  }
  assert.equal(fs.existsSync(f.config.storage.indexRoot), false);
});

test('missing packaged maintenance refuses before owner selection, census, allocation or child launch', async t => {
  const f = fixture(t);
  const originalStat = fs.statSync;
  t.mock.method(fs, 'statSync', (path, ...args) => {
    if (String(path).includes('/native/analysis/runtime/')) throw Object.assign(new Error('fixture missing artifact'), { code: 'ENOENT' });
    return originalStat(path, ...args);
  });
  const spawns = t.mock.method(childProcess, 'spawn', () => { throw new Error('must refuse before child launch'); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const lifecycle = await registerCandidateAnalysisLifecycle(f.pi, { callNative: f.callNative });
  t.after(() => lifecycle.stop()); await f.emit('session_start');
  assert.match(lifecycle.status().reason, /maintenance is unavailable/);
  assert.equal(codeMaintenanceOwner(f.root), 'unowned');
  assert.equal(f.censuses.length, 0); assert.equal(spawns.mock.callCount(), 0);
  assert.equal(fs.existsSync(f.config.storage.indexRoot), false);
});

test('stale loaded source refuses candidate ownership and maintenance before admission', async t => {
  const f = fixture(t);
  const loaded = join(f.work, 'loaded-extension'); fs.mkdirSync(loaded);
  fs.writeFileSync(join(loaded, 'package.json'), '{}');
  fs.writeFileSync(join(loaded, 'index.ts'), '// initial');
  setLoadedExtensionRootForTests(loaded); t.after(() => setLoadedExtensionRootForTests());
  fs.writeFileSync(join(loaded, 'index.ts'), '// replaced after load');
  const lifecycle = await registerCandidateAnalysisLifecycle(f.pi, { maintain: f.maintain, callNative: f.callNative });
  t.after(() => lifecycle.stop()); await f.emit('session_start');
  assert.match(lifecycle.status().reason, /stale|restart/i);
  assert.equal(lifecycle.status().disposition, 'refused');
  assert.equal(codeMaintenanceOwner(f.root), 'unowned');
  assert.equal(f.calls.length, 0); assert.equal(f.censuses.length, 0);
  assert.equal(fs.existsSync(f.config.storage.indexRoot), false);
});

test('automatic indexed work refuses absent policy permission before census or allocation', async t => {
  const cases = [
    ['disabled', f => { f.config.automation.mode = 'disabled'; }],
    ['guided', f => { f.config.automation.mode = 'guided'; }],
    ['auto-local', f => { f.config.automation.mode = 'auto-local'; }],
    ['detect-only', f => { f.config.automation.autoPrepareOnSessionStart = 'detect-only'; }],
    ['startup disabled', f => { f.config.automation.autoPrepareOnSessionStart = false; }],
    ['project disabled', f => f.local({ automation: { allowAutoPrepare: false } })],
    ['architecture disabled', f => f.local({ architecture: { enabled: false } })],
    ['backend prepare disabled', f => f.local({ architecture: { autoPrepare: false } })],
    ['global backend disabled', f => { f.config.backends.architecture.enabled = false; }],
    ['retired backend disabled', f => { f.config.backends.crg = { enabled: false }; }],
    ['narrow scope', f => f.local({ scope: { include: ['src'] } })],
    ['host env', () => { process.env.PI_NAV_NO_AUTO_SETUP = '1'; }],
    ['read-only wins over setup zero', () => { process.env.PI_NAV_NO_AUTO_SETUP = '0'; process.env.PI_NAV_READ_ONLY = '1'; }],
    ['setup prohibition wins over read-only zero', () => { process.env.PI_NAV_NO_AUTO_SETUP = 'yes'; process.env.PI_NAV_READ_ONLY = '0'; }],
    ['host event', () => {}, { readOnly: true }],
    ['prompt', () => {}, { prompt: 'read-only, no indexing' }],
  ];
  for (const [name, change, event] of cases) await t.test(name, async t => {
    const f = fixture(t); change(f); f.save();
    const lifecycle = await registerCandidateAnalysisLifecycle(f.pi, { maintain: f.maintain, callNative: f.callNative });
    t.after(() => lifecycle.stop());
    await f.emit('session_start', event);
    assert.ok(lifecycle.status().reason, JSON.stringify(lifecycle.status()));
    assert.equal(lifecycle.status().disposition, 'refused');
    assert.equal(f.calls.length, 0); assert.equal(f.censuses.length, 0);
    assert.equal(fs.existsSync(f.config.storage.indexRoot), false);
    assert.equal(codeMaintenanceOwner(f.root), 'unowned', 'initial denial must not claim an unowned root');
  });
});

test('host and prompt refusal stay latched when later events omit those fields', async t => {
  for (const [name, event] of [['host', { readOnly: true }], ['prompt', { prompt: 'read-only, no indexing' }]]) {
    await t.test(name, async t => {
      const f = fixture(t);
      const lifecycle = registerCandidateAnalysisLifecycle(f.pi, { maintain: f.maintain, callNative: f.callNative });
      t.after(() => lifecycle.stop());
      await f.emit('session_start', event);
      await f.emit('input'); await f.emit('tool_result', { toolName: 'write' });
      assert.equal(lifecycle.status().automaticSetupSuppressed, true);
      assert.equal(lifecycle.status().disposition, 'refused');
      assert.equal(codeMaintenanceOwner(f.root), 'unowned');
      assert.equal(f.calls.length, 0); assert.equal(f.censuses.length, 0);
      assert.equal(fs.existsSync(f.config.storage.indexRoot), false);
    });
  }
});

test('benign docs migration is not missing code consent, but malformed config refuses before ownership', async t => {
  await t.test('in-memory migration notice', async t => {
    const f = fixture(t); f.config.backends.docs.mode = 'richDocs'; f.save();
    const before = fs.readFileSync(join(f.work, 'automation.json'));
    const lifecycle = await registerCandidateAnalysisLifecycle(f.pi, { maintain: f.maintain, callNative: f.callNative });
    t.after(() => lifecycle.stop()); await f.emit('session_start');
    await waitFor(() => lifecycle.status().state === 'ready');
    assert.equal(lifecycle.status().disposition, 'indexed'); assert.equal(f.calls.length, 1);
    assert.deepEqual(fs.readFileSync(join(f.work, 'automation.json')), before, 'notice must not rewrite configuration');
  });
  await t.test('malformed machine configuration', async t => {
    const f = fixture(t); fs.writeFileSync(join(f.work, 'automation.json'), '{');
    const lifecycle = await registerCandidateAnalysisLifecycle(f.pi, { maintain: f.maintain, callNative: f.callNative });
    t.after(() => lifecycle.stop()); await f.emit('session_start');
    assert.equal(lifecycle.status().disposition, 'refused');
    assert.match(lifecycle.status().reason, /readable machine automation configuration/);
    assert.equal(codeMaintenanceOwner(f.root), 'unowned'); assert.equal(f.calls.length, 0); assert.equal(f.censuses.length, 0);
    assert.equal(fs.existsSync(f.config.storage.indexRoot), false);
  });
});

test('ambiguous monorepo scope refuses automatic writes', async t => {
  const f = fixture(t);
  fs.mkdirSync(join(f.root, 'packages', 'one'), { recursive: true });
  fs.mkdirSync(join(f.root, 'packages', 'two'), { recursive: true });
  for (const name of ['one', 'two']) fs.writeFileSync(join(f.root, 'packages', name, 'package.json'), '{}');
  fs.writeFileSync(join(f.root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  const lifecycle = await registerCandidateAnalysisLifecycle(f.pi, { maintain: f.maintain, callNative: f.callNative });
  t.after(() => lifecycle.stop()); await f.emit('session_start');
  await waitFor(() => lifecycle.status().state === 'failed');
  assert.match(lifecycle.status().error, /scope|monorepo/);
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.config.storage.indexRoot), false);
  // Once reserved, a later admission failure must not reactivate the predecessor.
  assert.equal(lifecycle.status().disposition, 'indexed');
  assert.equal(codeMaintenanceOwner(f.root), 'indexed');
});

test('candidate busy stays unavailable, and permission revocation aborts and awaits its child', async t => {
  await t.test('busy', async t => {
    const f = fixture(t);
    const lifecycle = await registerCandidateAnalysisLifecycle(f.pi, { callNative: f.callNative,
      maintain: async request => ({ status: 'busy', root: f.root, directory: request.directory }) });
    t.after(() => lifecycle.stop()); await f.emit('session_start');
    await waitFor(() => lifecycle.status().state === 'unavailable');
    assert.match(lifecycle.status().error, /busy/);
    assert.equal(lifecycle.status().watching, 1, 'contention does not disable admitted change hints');
  });
  await t.test('stop', async t => {
    const f = fixture(t); let started = false; let aborted = false; let closed = false;
    const lifecycle = await registerCandidateAnalysisLifecycle(f.pi, { callNative: f.callNative,
      maintain: async (_request, signal) => {
        started = true;
        await new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; setTimeout(() => { closed = true; resolve(); }, 20); }, { once: true }));
        signal.throwIfAborted();
      } });
    t.after(() => lifecycle.stop()); await f.emit('session_start'); await waitFor(() => started);
    await f.emit('input', { text: 'No indexing; read-only now.' });
    assert.equal(aborted, true); assert.equal(closed, true); assert.equal(lifecycle.status().state, 'inactive');
    await f.emit('before_agent_start'); assert.match(lifecycle.status().reason, /forbids/);
    await f.emit('session_shutdown'); assert.equal(codeMaintenanceOwner(f.root), 'indexed');
  });
});

test('selection reserves ownership without scheduling work and preserves Graphify marking', async t => {
  const f = fixture(t); f.local({ architecture: { enabled: true, backend: 'crg' } });
  fs.mkdirSync(join(f.root, '.pi', 'navigation'), { recursive: true });
  const state = join(f.root, '.pi', 'navigation', 'state.json');
  fs.writeFileSync(state, JSON.stringify({ indexes: { graph: { refreshStatus: 'ready' } } }));
  const timers = t.mock.method(globalThis, 'setTimeout');
  notifyPreparedMutation({ cwd: f.root, paths: ['target.ts'], trigger: 'edit' });
  assert.equal(timers.mock.callCount(), 0, 'a mutation hook schedules no delayed code-index work');
  let graph = JSON.parse(fs.readFileSync(state)).indexes.graph;
  assert.equal(graph.sourceFreshnessStatus, 'refresh_pending'); assert.equal(graph.dirtyTrigger, 'edit');
  assert.equal(codeMaintenanceOwner(f.root), 'unowned');
  selectCandidateCodeOwner(f.root);
  assert.equal(codeMaintenanceOwner(f.root), 'indexed');
  assert.equal(selectCandidateCodeOwner(f.root), undefined, 'selecting an indexed root twice is idempotent');
  notifyPreparedMutation({ cwd: f.root, paths: ['target.ts'], trigger: 'write' });
  assert.equal(timers.mock.callCount(), 0, 'a selected root schedules no work either');
  graph = JSON.parse(fs.readFileSync(state)).indexes.graph;
  assert.equal(graph.sourceFreshnessStatus, 'refresh_pending'); assert.equal(graph.dirtyTrigger, 'write');
  assert.deepEqual(graph.dirtyPaths, ['target.ts']);
});

test('central background launcher refuses an empty backend list and never selects a retired backend', async t => {
  const f = fixture(t); selectCandidateCodeOwner(f.root);
  const calls = []; const children = [];
  t.mock.method(childProcess, 'spawn', (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter(); child.pid = process.pid; child.unref = () => {};
    children.push(child); return child;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const empty = startBackgroundPrepare(f.root, { config: f.config }, { trigger: 'session_start', backends: [] });
  assert.equal(empty.status, 'suppressed'); assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(join(f.root, '.pi')), false, 'empty selection must not allocate logs or locks');
  for (const backends of [undefined, ['qmd'], ['graphify']]) {
    startBackgroundPrepare(f.root, { config: f.config }, { trigger: 'session_start', backends });
    const flags = calls.at(-1).args;
    assert.equal(flags.includes('crg'), false); assert.ok(flags.includes('--backend'));
    children.at(-1).emit('close');
  }
  assert.equal(calls.length, 3);
  const fresh = join(f.work, 'fresh'); fs.mkdirSync(fresh);
  assert.equal(codeMaintenanceOwner(fresh), 'unowned', 'a root is unowned before selection');
  startBackgroundPrepare(fresh, { config: f.config }, { trigger: 'session_start', backends: ['qmd'] });
  assert.equal(codeMaintenanceOwner(fresh), 'unowned', 'launching prepare never claims code ownership');
  children.at(-1).emit('close');
  selectCandidateCodeOwner(fresh);
  assert.equal(codeMaintenanceOwner(fresh), 'indexed', 'only an eligible root is claimed, with no writer admission to release');
});

test('retired stores and bindings neither block indexed ownership nor get modified', async t => {
  for (const conflict of ['store', 'binding', 'architecture-state']) await t.test(conflict, async t => {
    const f = fixture(t);
    const artifacts = [];
    if (conflict === 'store') {
      fs.mkdirSync(join(f.root, '.code-review-graph'));
      fs.writeFileSync(join(f.root, '.code-review-graph', 'graph.db'), 'retired graph bytes');
      artifacts.push(join(f.root, '.code-review-graph', 'graph.db'));
    }
    if (conflict === 'binding') {
      f.local({ architecture: { enabled: true, backend: 'crg', indexPath: 'elsewhere/retired.db' } });
      artifacts.push(join(f.root, '.pi-navigation.json'));
    }
    if (conflict === 'architecture-state') {
      fs.mkdirSync(join(f.root, '.pi', 'navigation'), { recursive: true });
      fs.writeFileSync(join(f.root, '.pi', 'navigation', 'state.json'), JSON.stringify({ indexes: { architecture: { indexedCommit: 'deadbeef', indexPath: '.pi/crg/graph.db' } } }));
      artifacts.push(join(f.root, '.pi', 'navigation', 'state.json'));
    }
    const before = artifacts.map(path => ({ path, bytes: fs.readFileSync(path) }));
    const lifecycle = await registerCandidateAnalysisLifecycle(f.pi, { maintain: f.maintain, callNative: f.callNative });
    t.after(() => lifecycle.stop()); await f.emit('session_start');
    await waitFor(() => lifecycle.status().state === 'ready');
    assert.equal(lifecycle.status().disposition, 'indexed', conflict);
    assert.equal(f.calls.length, 1, conflict);
    assert.equal(codeMaintenanceOwner(f.root), 'indexed', conflict);
    for (const entry of before) assert.deepEqual(fs.readFileSync(entry.path), entry.bytes, `${conflict}: ${entry.path} must be untouched`);
    assert.equal(fs.statSync(join(f.config.storage.indexRoot, 'codegraph')).mode & 0o777, 0o700, 'the prepared store is the derived private Core namespace');
  });
});

test('candidate metadata aliases and oversized files are refused before any target-content read', async t => {
  for (const name of ['.pi-navigation.json', '.pi/navigation/state.json']) {
    for (const mode of ['alias', 'hardlink', 'oversize', ...(name.includes('/') ? ['ancestor-alias'] : [])]) {
      await t.test(`${name}: ${mode}`, async t => {
        const f = fixture(t);
        const metadata = join(f.root, name);
        fs.rmSync(metadata, { force: true });
        const outside = join(f.work, 'outside'); fs.mkdirSync(outside);
        const target = mode === 'oversize' ? metadata : join(outside, 'state.json');
        if (name.includes('/') && mode !== 'ancestor-alias') fs.mkdirSync(join(f.root, '.pi', 'navigation'), { recursive: true });
        fs.writeFileSync(target, mode === 'oversize' ? ' '.repeat(1_048_577) : '{}');
        if (mode === 'alias') fs.symlinkSync(target, metadata);
        if (mode === 'hardlink') fs.linkSync(target, metadata);
        if (mode === 'ancestor-alias') {
          fs.mkdirSync(join(f.root, '.pi')); fs.symlinkSync(outside, join(f.root, '.pi', 'navigation'));
        }
        const identity = fs.statSync(target);
        const readFile = fs.readFileSync; const read = fs.readSync;
        let targetReads = 0;
        const observe = input => {
          try {
            const stat = typeof input === 'number' ? fs.fstatSync(input) : fs.statSync(input);
            if (stat.dev === identity.dev && stat.ino === identity.ino) targetReads++;
          } catch {}
        };
        t.mock.method(fs, 'readFileSync', (...args) => { observe(args[0]); return readFile(...args); });
        t.mock.method(fs, 'readSync', (...args) => { observe(args[0]); return read(...args); });
        syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
        assert.throws(() => selectCandidateCodeOwner(f.root), /Candidate metadata/);
        assert.equal(targetReads, 0, 'later refusal must not conceal an earlier aliased/oversized read');
        assert.equal(codeMaintenanceOwner(f.root), 'unowned');
        const lifecycle = await registerCandidateAnalysisLifecycle(f.pi, { maintain: f.maintain, callNative: f.callNative });
        t.after(() => lifecycle.stop()); await f.emit('session_start');
        assert.match(lifecycle.status().reason, /Candidate metadata/);
        assert.equal(targetReads, 0); assert.equal(f.calls.length, 0);
        assert.equal(fs.existsSync(f.config.storage.indexRoot), false);
      });
    }
  }
});

test('candidate metadata read tripwire observes valid reads and malformed objects fail closed', async t => {
  const f = fixture(t);
  const metadata = join(f.root, '.pi-navigation.json');
  const identity = fs.statSync(metadata); const read = fs.readSync;
  let reads = 0;
  t.mock.method(fs, 'readSync', (...args) => {
    const stat = fs.fstatSync(args[0]);
    if (stat.dev === identity.dev && stat.ino === identity.ino) reads++;
    return read(...args);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  selectCandidateCodeOwner(f.root);
  assert.ok(reads > 0, 'negative-control tripwire must observe the real descriptor reader');
  for (const text of ['null', '[]', 'true', '{"private-marker"']) {
    fs.writeFileSync(metadata, text);
    assert.throws(() => selectCandidateCodeOwner(f.root), error => /Candidate metadata/.test(error.message) && !error.message.includes('private-marker'));
  }
});

test('private parent allocation rejects in-source paths, aliases and unsafe existing parents without repair', async t => {
  const f = fixture(t);
  assert.throws(() => ensureAnalysisProjectParent(deriveAnalysisProject(f.root, join(f.root, 'indexes'))), /outside source/);
  assert.equal(fs.existsSync(join(f.root, 'indexes')), false);
  const unsafe = join(f.work, 'unsafe'); fs.mkdirSync(unsafe, { mode: 0o755 }); fs.chmodSync(unsafe, 0o755);
  assert.throws(() => ensureAnalysisProjectParent(deriveAnalysisProject(f.root, unsafe)), /private/);
  assert.equal(fs.existsSync(join(unsafe, 'codegraph')), false); assert.equal(fs.statSync(unsafe).mode & 0o777, 0o755);
  const alias = join(f.work, 'alias'); fs.symlinkSync(unsafe, alias);
  assert.throws(() => ensureAnalysisProjectParent(deriveAnalysisProject(f.root, join(alias, 'indexes'))), /canonical|aliases/);
  assert.equal(fs.existsSync(join(unsafe, 'indexes')), false);
});

test('failed or interrupted status and foreign files are never automatically reset', async t => {
  for (const state of ['building', 'failed', 'foreign']) await t.test(state, async t => {
    const f = fixture(t); const project = f.project(); ensureAnalysisProjectParent(project);
    const store = analysisProjectPaths(project, true);
    if (state === 'foreign') fs.writeFileSync(store.database, 'foreign bytes', { mode: 0o600 });
    else writeMaintenanceStatus(store, { format: 'codeweave-pi.maintenance.1', kernelVersion: '0.1.0-codeweave-pi.5', state,
      runId: '11111111-1111-4111-8111-111111111111', ...maintenanceStatusIdentity(store), databaseDev: null, databaseIno: null,
      policyDigest: 'a'.repeat(64), corpusDigest: 'b'.repeat(64), counts: {} });
    const names = fs.readdirSync(store.directory); const bytes = names.map(name => fs.readFileSync(join(store.directory, name)));
    const lifecycle = await registerCandidateAnalysisLifecycle(f.pi, { maintain: f.maintain, callNative: f.callNative });
    t.after(() => lifecycle.stop()); await f.emit('session_start'); await waitFor(() => lifecycle.status().state === 'failed');
    assert.match(lifecycle.status().error, /Building or interrupted\/failed|adoption/); assert.equal(f.calls.length, 0);
    assert.deepEqual(fs.readdirSync(store.directory), names);
    assert.deepEqual(names.map(name => fs.readFileSync(join(store.directory, name))), bytes);
  });
});
