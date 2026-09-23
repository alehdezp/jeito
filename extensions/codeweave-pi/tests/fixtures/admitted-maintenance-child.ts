import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { createRequire } from 'node:module';
import workerThreads from 'node:worker_threads';
import { createHash } from 'node:crypto';

// Load the actual builder output once: its capture, resolver and store bindings
// must share module state. Never bundle another resolver into this fixture.
const { maintainAdmittedProject, getKernel } = createRequire(import.meta.url)(process.argv[3]!);

const options = JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8'));
const attempts: string[] = [];
const driftChecks: boolean[] = [];
// Canned projection/encoding isolate maintenance invalidation from model quality.
const semanticOwners: string[] = [];
if (options.semanticProbe) {
  const info = { recipe: 'a'.repeat(64), dimensions: 256 };
  const vector = Array(256).fill(0); vector[0] = 1;
  options.semantics = { runId: options.semanticProbe, info, remaining: () => 10_000,
    project: async (args: any) => {
      semanticOwners.push(...args.owners.map((owner: any) => `${args.path}:${owner.id}`));
      return { text: '', structured: { data: { basis: 'supplied', path: args.path,
        suppliedSourceHash: createHash('sha256').update(args.capturedSource.text).digest('hex'), ...info,
        representation: 'codeweave-pi-code-input-v1', complete: true,
        owners: args.owners.map((owner: any) => ({ id: owner.id, status: 'ok', coverage: 'tsjs-source-owned',
          syntax: { startByte: 0, endByte: Buffer.byteLength(args.capturedSource.text), kind: 'function_declaration' },
          input: JSON.stringify(['codeweave-pi-code-input-v1', args.path, owner.id, owner.kind, '', '', args.capturedSource.text]) })) } } };
    }, encode: async (texts: string[]) => ({ ...info, vectors: texts.map(() => vector) }) };
}
const originalOpen = fs.openSync;
const workerMessages: { script: string; type: string }[] = [];
const OriginalWorker = workerThreads.Worker;
workerThreads.Worker = class extends OriginalWorker {
  constructor(filename: string | URL, options?: ConstructorParameters<typeof OriginalWorker>[1]) {
    super(filename, options);
    (this as any).on('message', (message: { type: string }) => workerMessages.push({ script: path.basename(String(filename)), type: message.type }));
  }
};
let drift = false;
const originalExec = childProcess.execFileSync;
let gitAttempts = 0;
childProcess.execFileSync = ((command: string, ...args: any[]) => {
  if (command === 'git') { gitAttempts++; throw new Error('Git enumeration must not run under supplied admission'); }
  return (originalExec as any)(command, ...args);
}) as typeof childProcess.execFileSync;
fs.openSync = ((file: fs.PathLike, ...args: any[]) => {
  if (typeof file === 'string' && file.startsWith(options.root + path.sep)) attempts.push(path.relative(options.root, file));
  return (originalOpen as any)(file, ...args);
}) as typeof fs.openSync;
(async () => {
  try {
    if (!getKernel()) throw new Error('isolated compiled kernel is required');
    const output = await maintainAdmittedProject({ ...options, onProgress(progress: any, graph: any) {
      if (!options.drift || drift || progress.phase !== 'resolving') return;
      drift = true;
      // Warm and probe the resolver owned by the running CodeGraph instance.
      const resolver = graph.resolver;
      resolver.warmCaches();
      resolver.readFileCached('target.ts');
      resolver.context.getFileLines('target.ts');
      const policy = options.admission.policyFiles[0].path;
      fs.writeFileSync(policy, '{"scope":{"exclude":["target.ts"]}}');
      for (const probe of [() => resolver.readFileCached('target.ts'), () => resolver.context.fileExists('target.ts'), () => resolver.context.getFileLines('target.ts')]) {
        try { probe(); driftChecks.push(false); } catch { driftChecks.push(true); }
      }
      // Deliberately catch the failures and restore bytes. Completion must still
      // refuse because the source boundary has latched the invalidated run.
      fs.writeFileSync(policy, '{}');
    } });
    console.log('MAINTENANCE_PROBE ' + JSON.stringify({ output, attempts, driftChecks, gitAttempts, workerMessages, semanticOwners }));
  } catch (error) {
    console.log('MAINTENANCE_PROBE ' + JSON.stringify({ error: String(error), attempts, driftChecks, gitAttempts, workerMessages }));
    process.exitCode = 1;
  } finally { fs.openSync = originalOpen; childProcess.execFileSync = originalExec; workerThreads.Worker = OriginalWorker; }
})();
