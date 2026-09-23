import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import stow from '../extensions/tooltap/extensions/index.ts';

// Exercise patched production SDK code, not a mock activation API. Only a
// disposable first-party test copy is modified; the installed package is read-only.
const sourceRoot = process.env.PI_TEST_RUNTIME ?? dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))));
const temporaryRoot = resolve('.tmp');
mkdirSync(temporaryRoot, { recursive: true });
const fixtureRoot = mkdtempSync(join(temporaryRoot, 'stow-native-runtime-'));
const patch = fileURLToPath(new URL('../extensions/tooltap/patches/ensure-pi-registered-tool-api.mjs', import.meta.url));

await test('normal Pi prompt: native/gateway activation, refresh and same-model restore preserve the prefix', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Runtime regression tests must not make network requests'); };
  try {
    cpSync(join(sourceRoot, 'dist'), join(fixtureRoot, 'dist'), { recursive: true });
    cpSync(join(sourceRoot, 'package.json'), join(fixtureRoot, 'package.json'));
    symlinkSync(join(sourceRoot, 'node_modules'), join(fixtureRoot, 'node_modules'), 'dir');
    execFileSync(process.execPath, [patch, '--pi', fixtureRoot], { encoding: 'utf8' });
    execFileSync(process.execPath, [patch, '--pi', fixtureRoot, '--check'], { encoding: 'utf8' });
    const sdk = await import(pathToFileURL(join(fixtureRoot, 'dist/index.js')).href);
    const model = { id: 'gpt-5.6-luna', name: 'Luna fixture', provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://invalid.example', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsAdditionalTools: true } };
    const modelRuntime = await sdk.ModelRuntime.create({ allowModelNetwork: false });
    for (const route of ['native', 'proxy']) {
      const cwd = join(fixtureRoot, route);
      mkdirSync(cwd);
      const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false } });
      const sessionManager = sdk.SessionManager.inMemory(cwd);
      let api;
      const openSession = async () => {
        const loader = new sdk.DefaultResourceLoader({
          cwd, agentDir: cwd, settingsManager,
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          // Deliberately NO systemPrompt override: Pi's generated prompt is the regression boundary.
          extensionFactories: [pi => {
            api = pi;
            for (const name of ['baseline_probe', 'late_probe', 'second_probe']) {
              pi.registerTool({ name, label: name, description: `Return a harmless ${name} result.`,
                promptSnippet: `${name} SNIPPET`, promptGuidelines: [`${name} GUIDELINE`],
                parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
                execute: async (_id, args) => ({ content: [{ type: 'text', text: `observed:${args.value}` }] }),
              });
            }
            stow(pi, { userConfigOverride: { policy: { core: ['baseline_probe'] }, routing: { [route]: ['gpt-^'] }, notifyOnSessionStart: false, logPayloads: false } });
          }],
        });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        const { session } = await sdk.createAgentSession({ cwd, agentDir: cwd, model, modelRuntime, resourceLoader: loader, settingsManager, sessionManager, noTools: 'builtin' });
        await session.bindExtensions({ onError: error => { throw new Error(error.message); } });
        return session;
      };
      let session = await openSession();
      try {
        assert.equal(typeof api.setActiveToolsWithDeferred, 'function', 'real extension API was not patched');
        const initial = session.agent.state.systemPrompt;
        // Negative control: the old native call really does rewrite Pi's
        // generated instructions, even with stable provider-deferred schemas.
        const baselineNames = session.getActiveToolNames();
        api.setActiveTools([...baselineNames, 'late_probe']);
        assert.notEqual(session.agent.state.systemPrompt, initial);
        assert.ok(session.agent.state.systemPrompt.includes('late_probe SNIPPET'));
        api.setActiveToolsWithDeferred(baselineNames, []);
        assert.equal(session.agent.state.systemPrompt, initial);
        // A failing prompt rebuild must not leave a newly executable tool
        // behind without its successful activation/deferral result.
        const rebuild = session._rebuildSystemPrompt;
        const deferredBefore = session._deferredToolNames;
        session._rebuildSystemPrompt = () => { throw new Error('fixture rebuild failure'); };
        try {
          assert.throws(() => api.setActiveToolsWithDeferred([...baselineNames, 'late_probe'], ['late_probe']), /fixture rebuild failure/);
          assert.deepEqual(session.getActiveToolNames(), baselineNames, 'failed activation leaked executable state');
          assert.equal(session.agent.state.systemPrompt, initial);
          assert.equal(session._deferredToolNames, deferredBefore);
        } finally {
          session._rebuildSystemPrompt = rebuild;
        }
        assert.ok(initial.includes('baseline_probe SNIPPET') && initial.includes('baseline_probe GUIDELINE'));
        assert.ok(!initial.includes('late_probe SNIPPET') && !initial.includes('late_probe GUIDELINE'));
        const ctx = { model, ui: { notify() {}, setStatus() {} } };
        for (const name of ['late_probe', 'second_probe']) {
          const result = await api.getRegisteredTool('tools').execute(`enable-${name}`, { request: name }, undefined, undefined, ctx);
          assert.equal(result.details.strategy, route, 'native assertion must not silently pass through gateway fallback');
          assert.ok(result.content[0].text.includes(`${name} SNIPPET`) && result.content[0].text.includes(`${name} GUIDELINE`), 'guidance was lost instead of moved to the activation result');
          assert.equal(session.agent.state.systemPrompt, initial, `${route} changed the generated system prefix`);
          for (const value of ['first', 'second']) {
            const execution = route === 'native'
              ? await session.agent.state.tools.find(tool => tool.name === name).execute(`exec-${name}`, { value }, undefined, undefined)
              : await api.getRegisteredTool('tools').execute(`exec-${name}`, { request: name, arguments: { value } }, undefined, undefined, ctx);
            assert.equal(execution.content[0].text, `observed:${value}`);
            assert.equal(session.agent.state.systemPrompt, initial);
          }
        }
        // Internal registry refreshes still call the ordinary setter; they
        // must not accidentally reinsert deferred instructions on the next turn.
        session._refreshToolRegistry({ activeToolNames: session.getActiveToolNames() });
        assert.equal(session.agent.state.systemPrompt, initial, 'registry refresh reinserted late guidance');
        session.dispose();
        session = await openSession();
        assert.equal(session.agent.state.systemPrompt, initial, 'same-model restoration reinserted late guidance');
        assert.equal(session.getActiveToolNames().includes('late_probe'), route === 'native');
      } finally {
        session.dispose();
      }
    }
    console.log(`Verified generated prompts using Pi ${JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8')).version}`);
    if (process.env.STOW_KEEP_RUNTIME_FIXTURE) console.log(`Retained patched test runtime: ${fixtureRoot}`);
  } finally {
    globalThis.fetch = originalFetch;
    if (!process.env.STOW_KEEP_RUNTIME_FIXTURE) rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
