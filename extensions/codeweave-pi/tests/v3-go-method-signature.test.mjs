import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';

const extension = fileURLToPath(new URL('../', import.meta.url));
const wasm = process.env.PI_NAV_TEST_GO_WASM ?? join(extension, '.tmp/analysis-candidate/native/analysis/runtime/wasm/tree-sitter-go.wasm');
const skip = !existsSync(wasm) && 'requires an already-staged Go grammar; tests never acquire assets';
let temporary;
let loaded;
async function fixture() {
  if (loaded) return loaded;
  mkdirSync(join(extension, '.tmp'), { recursive: true });
  temporary = mkdtempSync(join(extension, '.tmp/go-signature-test-'));
  const bundle = join(temporary, 'test.cjs');
  await build({ stdin: { contents: [
    'export { synthesizeCallbackEdges } from "./native/analysis/src/resolution/callback-synthesizer.ts";',
    'export { goMethodSignatureKey } from "./native/analysis/src/resolution/go-method-signature.ts";',
    'export { loadGrammarsForLanguages, getParser } from "./native/analysis/src/extraction/grammars.ts";',
  ].join('\n'), resolveDir: extension }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external' });
  loaded = createRequire(import.meta.url)(bundle);
  assert.equal(loaded.goMethodSignatureKey('(int)'), undefined, 'unavailable grammar is not compatible evidence');
  await loaded.loadGrammarsForLanguages(['go'], { go: readFileSync(wasm) });
  return loaded;
}
after(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

test('Go signatures ignore parameter names and formatting, not types, arity, variadics or tags', { skip }, async () => {
  const { goMethodSignatureKey: key } = await fixture();
  for (const [left, right] of [
    ['(int)', '(value int)'],
    ['(x, y int) int', '(a int, b int) (out int)'],
    ['(f func(a int) (b string))', '(g func(int) string)'],
    ['(v map[string][]int) error', '(other map [ string ] [] int) (err error)'],
    ['(value /* comment */ int)', '(int)'],
  ]) {
    assert.ok(key(left), left);
    assert.equal(key(left), key(right), `${left} == ${right}`);
  }
  for (const [left, right] of [
    ['(int)', '(string)'], ['(int)', '(int, int)'],
    ['(...string)', '([]string)'], ['() int', '() string'],
    ['(struct { X string `json:"a b"` })', '(struct { X string `json:"ab"` })'],
  ]) {
    assert.ok(key(left), left); assert.ok(key(right), right);
    assert.notEqual(key(left), key(right), `${left} != ${right}`);
  }
  for (const invalid of ['', '(broken', '(); Extra(int)']) assert.equal(key(invalid), undefined);
});

test('Go synthesis rejects contradictory or absent signatures while preserving matching cross-file methods', { skip }, async () => {
  const { synthesizeCallbackEdges } = await fixture();
  const node = (id, kind, name, filePath, signature, qualifiedName = name) =>
    ({ id, kind, name, filePath, signature, qualifiedName, language: 'go', startLine: 1, endLine: 1 });
  const nodes = [
    node('I', 'interface', 'IntFlusher', 'sample/types.go'),
    node('I.Flush', 'method', 'Flush', 'sample/types.go', '(int)', 'IntFlusher::Flush'),
    ...['Good', 'Bad', 'Unknown'].flatMap((name, index) => [
      node(name, 'struct', name, 'sample/types.go'),
      node(`${name}.Flush`, 'method', 'Flush', 'sample/methods.go', ['(value int)', '(value string)', undefined][index], `${name}::Flush`),
    ]),
  ];
  const edges = [{ source: 'I', target: 'I.Flush', kind: 'contains' }];
  const byId = new Map(nodes.map(value => [value.id, value]));
  const queries = {
    getDistinctFileLanguages: () => new Set(['go']),
    *iterateNodesByKind(kind) { yield* nodes.filter(value => value.kind === kind); },
    getNodeById: id => byId.get(id), getNodesByName: name => nodes.filter(value => value.name === name),
    getIncomingEdges: (id, kinds) => edges.filter(edge => edge.target === id && kinds.includes(edge.kind)),
    getOutgoingEdges: (id, kinds) => edges.filter(edge => edge.source === id && kinds.includes(edge.kind)),
    insertEdges: additions => edges.push(...additions),
    getNodeAndEdgeCount: () => ({ nodes: nodes.length, edges: edges.length }),
  };
  let unrelatedPasses = 0;
  await synthesizeCallbackEdges(queries, {}, undefined, { async runSynthPass() { unrelatedPasses++; return { edges: [], ms: 0 }; } });
  assert.ok(unrelatedPasses > 0, 'the actual ordered Go prepasses run; unrelated passes are stubbed');
  assert.deepEqual(edges.filter(edge => edge.kind === 'implements').map(edge => [edge.source, edge.target]), [['Good', 'I']]);
  for (const name of ['Good', 'Bad', 'Unknown']) assert.ok(edges.some(edge => edge.kind === 'contains' && edge.source === name && edge.target === `${name}.Flush`));
});
