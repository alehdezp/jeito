import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { ANALYSIS_OUTPUT_ARTIFACTS, MAINTENANCE_OUTPUT_ARTIFACTS } from '../native/analysis/identity.mjs';

const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builder = path.join(extension, 'scripts/pi-nav-build.mjs');

test('maintenance grammar input is explicit and refuses invalid inputs before building', t => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'maintenance-build-')));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const grammar = path.join(work, 'grammars');
  fs.mkdirSync(grammar);
  const alias = path.join(work, 'alias');
  fs.symlinkSync(grammar, alias);
  const output = path.join(work, 'output');
  for (const args of [
    ['--maintenance-grammars'],
    ['--maintenance-grammars', grammar, '--maintenance-grammars', grammar],
    ['--maintenance-grammars', 'relative/path'],
    ['--maintenance-grammars', alias],
    ['--maintenance-grammars', grammar],
  ]) {
    const result = spawnSync(process.execPath, [builder, 'analysis-build', '--output-dir', output, '--json', ...args],
      { encoding: 'utf8', timeout: 10_000, env: { ...process.env, CARGO_NET_OFFLINE: 'true' } });
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.equal(JSON.parse(result.stderr.trim().split('\n').at(-1)).ok, false);
    assert.equal(fs.existsSync(output), false, 'refusal precedes staging or Cargo');
  }
  fs.symlinkSync(builder, path.join(grammar, 'tree-sitter-typescript.wasm'));
  const symlink = spawnSync(process.execPath, [builder, 'analysis-build', '--output-dir', output, '--maintenance-grammars', grammar, '--json'],
    { encoding: 'utf8', timeout: 10_000 });
  assert.notEqual(symlink.status, 0);
  assert.match(symlink.stderr, /required regular file/);
  assert.equal(fs.existsSync(output), false);
});

test('actual builder output keeps legacy artifacts and separately stages the supplied maintenance assets', () => {
  const runtime = process.env.DEEPFIELD_MAINTENANCE_RUNTIME;
  const grammars = process.env.DEEPFIELD_MAINTENANCE_GRAMMARS;
  assert.ok(runtime && grammars, 'supply the real analysis-build output and its explicit grammar input');
  assert.deepEqual(Object.values(ANALYSIS_OUTPUT_ARTIFACTS), ['core.cjs', 'codegraph-kernel.node', 'schema.sql', 'THIRD-PARTY-NOTICES']);
  assert.equal(MAINTENANCE_OUTPUT_ARTIFACTS.schema, 'maintenance-schema.sql');
  const names = fs.readdirSync(grammars).filter(name => /^tree-sitter-[\w-]+\.wasm$/.test(name)).sort();
  assert.ok(names.length);
  assert.deepEqual(fs.readdirSync(path.join(runtime, 'wasm')).sort(), names);
  for (const name of names) assert.deepEqual(fs.readFileSync(path.join(runtime, 'wasm', name)), fs.readFileSync(path.join(grammars, name)), name);
  assert.deepEqual(fs.readdirSync(runtime).sort(), [...Object.values(ANALYSIS_OUTPUT_ARTIFACTS), ...Object.values(MAINTENANCE_OUTPUT_ARTIFACTS), 'wasm'].sort());
});
