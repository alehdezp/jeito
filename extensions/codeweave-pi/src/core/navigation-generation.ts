import { randomUUID } from "node:crypto";
import { closeSync, cpSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { PreparedLaneName } from "./navigation-desired-state.ts";

export const NAVIGATION_GENERATION_VERSION = 1 as const;

export interface NavigationGenerationPointer {
  version: typeof NAVIGATION_GENERATION_VERSION;
  lane: PreparedLaneName;
  id: string;
  desiredStateHash: string;
  rootIdentity: string;
  backendVersion?: string;
  artifactPath: string;
  publishedAt: string;
  predecessor: string | "absent";
  actorToken: string;
  cleanup?: GenerationCleanupResult;
}

export interface GenerationCleanupResult {
  removed: string[];
  retained: string[];
  warnings: string[];
}

export interface GenerationStage {
  lane: PreparedLaneName;
  id: string;
  token: string;
  laneRoot: string;
  stagingPath: string;
  generationPath: string;
}

export interface PublishGenerationOptions {
  stage: GenerationStage;
  desiredStateHash: string;
  rootIdentity: string;
  backendVersion?: string;
  verify(stagePath: string): Promise<void> | void;
  failpoint?: "before_verify" | "after_verify" | "before_publish" | "after_publish";
}

export function generationLaneRoot(root: string, lane: PreparedLaneName): string {
  if (lane !== "docs" && lane !== "graph") throw new Error("Unknown prepared lane; code navigation uses Core maintenance");
  return join(resolve(root), ".pi", "navigation", laneDirectory(lane));
}

export async function createGenerationStage(root: string, lane: PreparedLaneName, id = generationId()): Promise<GenerationStage> {
  const laneRoot = generationLaneRoot(root, lane);
  const token = randomUUID();
  const stagingPath = join(laneRoot, "staging", token);
  const generationPath = join(laneRoot, "generations", id);
  await mkdir(stagingPath, { recursive: true });
  return { lane, id, token, laneRoot, stagingPath, generationPath };
}

export async function publishGeneration(options: PublishGenerationOptions): Promise<NavigationGenerationPointer> {
  const { stage } = options;
  fail(options.failpoint, "before_verify");
  await options.verify(stage.stagingPath);
  fail(options.failpoint, "after_verify");
  const current = await readGenerationPointer(stage.laneRoot, "current.json");
  const predecessor = current?.id ?? "absent";
  fail(options.failpoint, "before_publish");
  await mkdir(dirname(stage.generationPath), { recursive: true });
  try { await rename(stage.stagingPath, stage.generationPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await stat(stage.generationPath).catch(() => undefined);
    if (!existing?.isDirectory()) throw error;
    await rm(stage.stagingPath, { recursive: true, force: true });
  }
  const pointer: NavigationGenerationPointer = {
    version: NAVIGATION_GENERATION_VERSION,
    lane: stage.lane,
    id: stage.id,
    desiredStateHash: options.desiredStateHash,
    rootIdentity: options.rootIdentity,
    backendVersion: options.backendVersion,
    artifactPath: stage.generationPath,
    publishedAt: new Date().toISOString(),
    predecessor,
    actorToken: stage.token,
  };
  if (current) await atomicJson(join(stage.laneRoot, "last-good.json"), current);
  await atomicJson(join(stage.laneRoot, "current.json"), pointer);
  fail(options.failpoint, "after_publish");
  return pointer;
}

export async function readGenerationPointer(laneRoot: string, file: "current.json" | "last-good.json"): Promise<NavigationGenerationPointer | undefined> {
  try {
    const value = JSON.parse(await readFile(join(laneRoot, file), "utf8"));
    return validPointer(value) ? value : undefined;
  } catch { return undefined; }
}

export function publishExistingArtifactGenerationSync(options: { root: string; lane: PreparedLaneName; sourcePath: string; sourceRelative?: string; desiredStateHash: string; rootIdentity: string; backendVersion?: string; verify?(stagedPath: string): void; id?: string }): NavigationGenerationPointer {
  if (!existsSync(options.sourcePath)) throw new Error(`prepared artifact missing before generation publication: ${options.sourcePath}`);
  const laneRoot = generationLaneRoot(options.root, options.lane);
  const id = options.id ?? generationId();
  const token = randomUUID();
  const stagingPath = join(laneRoot, "staging", token);
  const generationPath = join(laneRoot, "generations", id);
  mkdirSync(stagingPath, { recursive: true });
  const source = statSync(options.sourcePath);
  if (source.isDirectory()) cpSync(options.sourcePath, stagingPath, { recursive: true });
  else {
    const target = join(stagingPath, options.sourceRelative ?? "artifact");
    mkdirSync(dirname(target), { recursive: true });
    cpSync(options.sourcePath, target);
  }
  try {
    options.verify?.(stagingPath);
    mkdirSync(dirname(generationPath), { recursive: true });
    renameSync(stagingPath, generationPath);
    const current = readGenerationPointerSync(laneRoot, "current.json");
    const priorLastGood = readGenerationPointerSync(laneRoot, "last-good.json");
    const pointer: NavigationGenerationPointer = { version: NAVIGATION_GENERATION_VERSION, lane: options.lane, id, desiredStateHash: options.desiredStateHash, rootIdentity: options.rootIdentity, backendVersion: options.backendVersion, artifactPath: generationPath, publishedAt: new Date().toISOString(), predecessor: current?.id ?? "absent", actorToken: token };
    if (current) atomicJsonSync(join(laneRoot, "last-good.json"), current);
    atomicJsonSync(join(laneRoot, "current.json"), pointer);
    pointer.cleanup = pruneSupersededLastGoodSync(laneRoot, priorLastGood, new Set([pointer.id, current?.id].filter((value): value is string => Boolean(value))));
    return pointer;
  } catch (error) {
    rmSync(stagingPath, { recursive: true, force: true });
    throw error;
  }
}


function pruneSupersededLastGoodSync(laneRoot: string, priorLastGood: NavigationGenerationPointer | undefined, protectedIds: Set<string>): GenerationCleanupResult {
  const result: GenerationCleanupResult = { removed: [], retained: [...protectedIds], warnings: [] };
  if (!priorLastGood || protectedIds.has(priorLastGood.id)) return result;
  if (!/^[A-Za-z0-9._-]+$/.test(priorLastGood.id)) {
    result.warnings.push(`refused generation cleanup for unsafe id: ${priorLastGood.id}`);
    return result;
  }
  const expected = resolve(laneRoot, "generations", priorLastGood.id);
  if (resolve(priorLastGood.artifactPath) !== expected) {
    result.warnings.push(`refused generation cleanup outside owned path: ${priorLastGood.id}`);
    return result;
  }
  try {
    rmSync(expected, { recursive: true, force: true });
    result.removed.push(priorLastGood.id);
  } catch (error) {
    result.warnings.push(`generation cleanup failed for ${priorLastGood.id}: ${String((error as Error)?.message ?? error)}`);
  }
  return result;
}

export function readGenerationPointerSync(laneRoot: string, file: "current.json" | "last-good.json"): NavigationGenerationPointer | undefined {
  try {
    const value = JSON.parse(readFileSync(join(laneRoot, file), "utf8"));
    return validPointer(value) ? value : undefined;
  } catch { return undefined; }
}

function atomicJsonSync(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  const fd = openSync(temporary, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}

export async function quarantineGeneration(root: string, lane: PreparedLaneName, id: string, approved: boolean): Promise<string> {
  if (!approved) throw new Error("generation quarantine requires explicit approval");
  const laneRoot = generationLaneRoot(root, lane);
  const source = join(laneRoot, "generations", id);
  const target = join(laneRoot, "quarantine", id);
  await mkdir(dirname(target), { recursive: true });
  await rename(source, target);
  return target;
}

export async function cleanupOwnedStage(stage: GenerationStage): Promise<void> {
  const expected = join(stage.laneRoot, "staging", stage.token);
  if (resolve(expected) !== resolve(stage.stagingPath)) throw new Error("refusing to clean unowned generation stage");
  await rm(stage.stagingPath, { recursive: true, force: true });
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
  try {
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch {}
}

function validPointer(value: any): value is NavigationGenerationPointer {
  return value?.version === NAVIGATION_GENERATION_VERSION && typeof value?.id === "string" && typeof value?.desiredStateHash === "string" && typeof value?.artifactPath === "string";
}

function generationId(): string {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${randomUUID().slice(0, 8)}`;
}

function laneDirectory(lane: PreparedLaneName): string {
  return lane === "docs" ? "qmd" : "graphify";
}

function fail(actual: PublishGenerationOptions["failpoint"], point: NonNullable<PublishGenerationOptions["failpoint"]>): void {
  if (actual === point) throw new Error(`navigation generation failpoint: ${point}`);
}
