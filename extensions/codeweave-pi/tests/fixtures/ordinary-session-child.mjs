// One ordinary registered codeweave-pi session, used by tests/v3-ordinary-two-session.test.mjs.
//
// Protocol: one JSON input file (argv[2]); newline commands on stdin; exactly one
// `SESSION_PROBE <json>` line per command on stdout. The session emits only
// `session_start` (and `session_shutdown` never — `stop` calls the lifecycle
// directly) so a query observation cannot be confused with a lifecycle event.
// No seam is injected: the default extension export from the candidate root runs
// its real admission, census, supervised maintenance child and registered tools.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { root, candidateRoot, configPath, home } = input;
for (const key of ['root', 'candidateRoot', 'configPath', 'home']) {
  if (typeof input[key] !== 'string' || !path.isAbsolute(input[key])) throw new Error(`ordinary-session input requires an absolute ${key}`);
}
// Machine policy and home are process state: set them before the extension loads.
process.env.PI_NAV_AUTOMATION_CONFIG = configPath;
process.env.HOME = home;
delete process.env.PI_NAV_NO_AUTO_SETUP;
delete process.env.PI_NAV_READ_ONLY;

const emit = payload => process.stdout.write(`SESSION_PROBE ${JSON.stringify(payload)}\n`);
function fail(command, error) {
  emit({ command, error: String(error?.message ?? error), stack: String(error?.stack ?? '').split('\n').slice(0, 6) });
  process.exit(1);
}
process.on('uncaughtException', error => fail('uncaught', error));
process.on('unhandledRejection', error => fail('unhandled', error));

const handlers = new Map();
const tools = new Map();
const commands = new Map();
const pi = {
  on: (name, handler) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
  registerTool: tool => tools.set(tool.name, tool),
  registerCommand: (name, command) => commands.set(name, command),
  registerShortcut() {},
  getActiveTools: () => [...tools.keys()],
  setActiveTools: () => {},
};
async function dispatch(name, event = {}) {
  let result;
  for (const handler of handlers.get(name) ?? []) result = await handler(event, { cwd: root, ui: { notify() {} } });
  return result;
}

const extension = (await import(pathToFileURL(path.join(candidateRoot, 'index.ts')).href)).default;
const lifecycle = extension(pi);
process.once('SIGTERM', async () => { await lifecycle.stop(); process.exit(0); });

async function waitFor(predicate, deadlineMs, label) {
  const deadline = Date.now() + deadlineMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
async function call(name, id, params) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool ${name} is not registered`);
  return tool.execute(id, params, undefined, undefined, { cwd: root });
}
const textOf = result => (result?.content ?? []).map(part => part.type === 'text' ? part.text : '').join('\n');
const analysisOf = result => result?.details?.native?.data?.analysis ?? null;

async function handle(line) {
  const [verb] = line.trim().split(/\s+/);
  if (verb === 'start') {
    await dispatch('session_start');
    // Settle rather than only wait for success, so the driver can report the
    // refusal or busy reason instead of a bare timeout.
    await waitFor(() => ['ready', 'failed', 'unavailable'].includes(lifecycle.status().state) || Boolean(lifecycle.status().reason), 150_000, 'a settled lifecycle state');
    return { command: verb, ...lifecycle.status() };
  }
  if (verb === 'status') return { command: verb, ...lifecycle.status() };
  if (verb === 'query') {
    const grepRanked = await call('grep', 'ordinary-grep-ranked', { target: 'target.ts::Wanted' });
    const grepMatches = await call('grep', 'ordinary-grep-matches', { pattern: 'Wanted', paths: root, output: 'matches' });
    const grepBeta = await call('grep', 'ordinary-grep-beta', { target: 'beta.ts::Beta' });
    return {
      command: verb,
      grepRanked: { text: textOf(grepRanked).slice(0, 8000), status: grepRanked?.details?.envelope?.status ?? null, analysis: analysisOf(grepRanked) },
      grepMatches: { text: textOf(grepMatches).slice(0, 8000), status: grepMatches?.details?.envelope?.status ?? null },
      grepBeta: { text: textOf(grepBeta).slice(0, 8000), status: grepBeta?.details?.envelope?.status ?? null, analysis: analysisOf(grepBeta) },
    };
  }
  if (verb === 'stop') {
    await lifecycle.stop();
    return { command: verb, state: lifecycle.status().state };
  }
  throw new Error(`unknown command: ${verb}`);
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  try {
    const receipt = await handle(line);
    emit(receipt);
    if (receipt.command === 'stop') process.exit(0);
  } catch (error) {
    fail(line.trim().split(/\s+/)[0], error);
  }
}
