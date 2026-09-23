import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager, convertToLlm } from '@earendil-works/pi-coding-agent';
import { convertResponsesMessages, convertResponsesTools } from '@earendil-works/pi-ai/api/openai-responses-shared';
import stow from '../extensions/tooltap/extensions/index.ts';
import promptRuntime from '../extensions/guidepin/index.ts';

// Use the installed adapter's actual placement logic without depending on a
// global Pi path. This is a serializer integration test, not a provider call.
const { splitDeferredTools } = await import(new URL('./utils/deferred-tools.js', import.meta.resolve('@earendil-works/pi-ai')));

for (const route of ['proxy', 'native']) {
  test(`${route}: fixed-system Pi persistence/serialization preserves reminder and history prefixes`, async () => {
    const session = SessionManager.inMemory();
    const handlers = new Map();
    const registry = new Map();
    let active = [];
    let tokens = 1000;
    const pi = {
      on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
      registerTool: definition => registry.set(definition.name, definition),
      getAllTools: () => [...registry.values()],
      getRegisteredTool: name => registry.get(name),
      getActiveTools: () => active,
      setActiveTools: names => { active = [...names]; },
      setActiveToolsWithDeferred: names => { active = [...names]; },
      setToolPromptOverrides() {}, registerCommand() {}, registerEntryRenderer() {},
      appendEntry: (name, data) => session.appendCustomEntry(name, data),
    };
    pi.registerTool({ name: 'prefix_probe', description: 'Return a harmless fixture value.', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => ({ content: [{ type: 'text', text: 'fixture-result' }], details: {} }) });
    const model = { provider: 'openai-codex', api: 'openai-codex-responses', id: 'gpt-5.6-luna', input: ['text'], reasoning: true, compat: { supportsAdditionalTools: true } };
    const ctx = { model, sessionManager: session, getContextUsage: () => ({ tokens }), ui: { setStatus() {}, notify() {} } };
    stow(pi, { userConfigOverride: { policy: { core: [] }, routing: { [route]: ['gpt-^'] }, logPayloads: false, notifyOnSessionStart: false } });
    const stowStartHandlers = handlers.get('before_agent_start') ?? [];
    promptRuntime(pi);
    for (const handler of handlers.get('session_start')) await handler({}, ctx);
    const instructions = 'fixed system instructions';
    async function turn(prompt) {
      session.appendMessage({ role: 'user', content: prompt, timestamp: 1 });
      for (const handler of handlers.get('before_agent_start')) {
        const result = await handler({ prompt, systemPrompt: instructions, systemPromptOptions: { appendSystemPrompt: 'fixture' } }, ctx);
        assert.equal(result?.systemPrompt, undefined);
        if (result?.message) {
          const m = result.message;
          session.appendCustomMessageEntry(m.customType, m.content, m.display, m.details);
        }
      }
    }
    async function request() {
      let messages = session.buildSessionContext().messages;
      for (const handler of handlers.get('context') ?? []) messages = (await handler({ messages }, ctx))?.messages ?? messages;
      const context = { systemPrompt: instructions, tools: active.map(n => registry.get(n)), messages: convertToLlm(messages) };
      const placement = splitDeferredTools(context, true);
      let payload = {
        instructions, prompt_cache_key: 'stable-fixture-session',
        tools: convertResponsesTools(placement.immediate, { strict: null }),
        input: convertResponsesMessages(model, context, new Set(['openai-codex']), { includeSystemPrompt: false, deferredTools: placement.deferred, deferredToolsMode: 'additional-tools', toolOptions: { strict: null } }),
      };
      for (const handler of handlers.get('before_provider_request') ?? []) payload = (await handler({ payload }, ctx)) ?? payload;
      return structuredClone(payload);
    }
    let sequence = 0;
    async function invoke(name, args) {
      const id = `call_${++sequence}`;
      const before = [...active];
      const result = await registry.get(name).execute(id, args, undefined, undefined, ctx);
      session.appendMessage({ role: 'assistant', provider: model.provider, api: model.api, model: model.id, timestamp: 1, stopReason: 'toolUse', content: [{ type: 'toolCall', id, name, arguments: args }] });
      // Pi's registered-tool wrapper attaches newly active names to results.
      const addedToolNames = active.filter(n => !before.includes(n));
      session.appendMessage({ role: 'toolResult', toolName: name, toolCallId: id, timestamp: 1, isError: false, ...result, ...(addedToolNames.length ? { addedToolNames } : {}) });
    }
    await turn('first user request');
    let previous = await request();
    const first = structuredClone(previous);
    async function unchanged() {
      const next = await request();
      assert.equal(next.instructions, previous.instructions);
      assert.equal(next.prompt_cache_key, previous.prompt_cache_key);
      assert.deepEqual(next.tools, previous.tools);
      assert.deepEqual(next.input.slice(0, previous.input.length), previous.input);
      assert.ok(!next.tools.some(t => t.name === 'prefix_probe'));
      previous = next;
    }
    await invoke('tools', { request: 'prefix_probe' }); await unchanged();
    for (let i = 0; i < 3; i++) {
      await invoke(route === 'proxy' ? 'tools' : 'prefix_probe', route === 'proxy' ? { request: 'prefix_probe', arguments: {} } : {});
      await unchanged();
    }
    session.appendCustomMessageEntry('subagent_result', 'asynchronous result', false);
    await unchanged();
    tokens = 100_000;
    await turn('new user request at refresh threshold'); await unchanged();
    assert.match(JSON.stringify(previous.input), /append-salience-refresh/);
    await turn('next user request in the same bucket'); await unchanged();
    // Restart the reminder extension against the SAME persisted session.
    handlers.set('before_agent_start', stowStartHandlers);
    promptRuntime(pi);
    await turn('same-model resumed user request'); await unchanged();
    assert.equal(JSON.stringify(previous.input).split('<append-salience-refresh>').length - 1, 1);
    assert.deepEqual(previous.input.slice(0, first.input.length), first.input);
  });
}
