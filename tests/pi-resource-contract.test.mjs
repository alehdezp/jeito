import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, loadSkillsFromDir, SettingsManager } from "@earendil-works/pi-coding-agent";

const SUITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function writeSkill(root, directory, name) {
  const skillRoot = join(root, directory);
  mkdirSync(skillRoot, { recursive: true });
  const path = join(skillRoot, "SKILL.md");
  writeFileSync(path, `---\nname: ${name}\ndescription: Fixture ${name}.\n---\n\n# ${name}\n`);
  return path;
}

function createResourceFixture() {
  const root = mkdtempSync(join(tmpdir(), "jeito-resource-contract-"));
  const extensionRoot = join(root, "extensions", "fixture-extension");
  mkdirSync(extensionRoot, { recursive: true });
  writeFileSync(join(extensionRoot, "index.ts"), "export default function fixtureExtension() {}\n");
  writeFileSync(join(extensionRoot, "package.json"), `${JSON.stringify({
    name: "fixture-extension",
    version: "1.0.0",
    private: true,
    type: "module",
    pi: { extensions: ["./index.ts"], skills: ["./skills"] },
  }, null, 2)}\n`);
  const setupSkill = writeSkill(root, join(".agents", "skills", "jeito-setup"), "jeito-setup");
  const extensionSkill = writeSkill(extensionRoot, join("skills", "fixture-setup"), "fixture-setup");
  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: "fixture-aggregate",
    version: "1.0.0",
    private: true,
    type: "module",
    pi: {
      extensions: ["./extensions/fixture-extension/index.ts"],
      skills: ["./.agents/skills/jeito-setup", "./extensions/*/skills"],
    },
  }, null, 2)}\n`);
  return { root, extensionRoot, setupSkill, extensionSkill };
}

async function resolveResources(packageRoot, cwd) {
  return resolvePackages([packageRoot], cwd);
}

async function resolvePackages(packageRoots, cwd) {
  const settings = SettingsManager.inMemory({ packages: packageRoots }, { projectTrusted: false });
  const manager = new DefaultPackageManager({ cwd, agentDir: join(cwd, ".agent"), settingsManager: settings });
  return manager.resolve();
}

function enabledPaths(resources) {
  return resources.filter(resource => resource.enabled).map(resource => resource.path).sort();
}

function fixturePaths(resources, fixtureRoot) {
  return enabledPaths(resources).filter(path => path.startsWith(`${fixtureRoot}/`));
}

function collectSkillFiles(root) {
  const found = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name === "SKILL.md") found.push(path);
    }
  };
  visit(root);
  return found.sort();
}

test("aggregate manifest exposes one project setup skill and nested extension skills", async () => {
  const fixture = createResourceFixture();
  const consumer = mkdtempSync(join(tmpdir(), "jeito-resource-consumer-"));
  try {
    const resources = await resolveResources(fixture.root, consumer);
    assert.deepEqual(fixturePaths(resources.skills, fixture.root), [fixture.setupSkill, fixture.extensionSkill].sort());
    assert.deepEqual(enabledPaths(resources.extensions), [join(fixture.extensionRoot, "index.ts")]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("standalone extension manifest exposes its owned skills", async () => {
  const fixture = createResourceFixture();
  const consumer = mkdtempSync(join(tmpdir(), "jeito-resource-consumer-"));
  try {
    const resources = await resolveResources(fixture.extensionRoot, consumer);
    assert.deepEqual(fixturePaths(resources.skills, fixture.root), [fixture.extensionSkill]);
    assert.deepEqual(enabledPaths(resources.extensions), [join(fixture.extensionRoot, "index.ts")]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("trusted checkout discovers the canonical setup skill from .agents", async () => {
  const fixture = createResourceFixture();
  try {
    const settings = SettingsManager.inMemory({}, { projectTrusted: true });
    const manager = new DefaultPackageManager({ cwd: fixture.root, agentDir: join(fixture.root, ".agent"), settingsManager: settings });
    const resources = await manager.resolve();
    assert.deepEqual(fixturePaths(resources.skills, fixture.root), [fixture.setupSkill]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("current aggregate and standalone manifests expose every owned skill", async () => {
  const consumer = mkdtempSync(join(tmpdir(), "jeito-resource-consumer-"));
  const codeweavePiRoot = join(SUITE_ROOT, "extensions", "codeweave-pi");
  const websiftRoot = join(SUITE_ROOT, "extensions", "websift");
  const promptRuntimeRoot = join(SUITE_ROOT, "extensions", "guidepin");
  try {
    const aggregate = await resolveResources(SUITE_ROOT, consumer);
    const expectedAggregateSkills = [
      join(SUITE_ROOT, ".agents", "skills", "jeito-setup", "SKILL.md"),
      join(SUITE_ROOT, ".agents", "skills", "subagent-mastery", "SKILL.md"),
      ...collectSkillFiles(join(codeweavePiRoot, "skills")),
      ...collectSkillFiles(join(websiftRoot, "skills")),
      ...collectSkillFiles(join(promptRuntimeRoot, "skills")),
    ].sort();
    assert.deepEqual(fixturePaths(aggregate.skills, SUITE_ROOT), expectedAggregateSkills);
    const expectedAggregateExtensions = [
      "shell/index.ts",
      "tooltap/extensions/index.ts",
      "draft-lift/index.ts",
      "guidepin/index.ts",
      "websift/index.ts",
      "codeweave-pi/index.ts",
      "fff-search/index.ts",
      "stall-guard/index.ts",
    ].map(path => join(SUITE_ROOT, "extensions", path)).sort();
    const manifest = JSON.parse(readFileSync(join(SUITE_ROOT, "package.json"), "utf8"));
    assert.deepEqual(manifest.pi.extensions.map(path => join(SUITE_ROOT, path)).sort(), expectedAggregateExtensions);
    assert.deepEqual(fixturePaths(aggregate.extensions, SUITE_ROOT), expectedAggregateExtensions, "all eight suite extensions resolve, without retired or standalone packages");

    const standaloneCodeweavePi = await resolveResources(codeweavePiRoot, consumer);
    assert.deepEqual(fixturePaths(standaloneCodeweavePi.skills, codeweavePiRoot), collectSkillFiles(join(codeweavePiRoot, "skills")));

    const standaloneWebsift = await resolveResources(websiftRoot, consumer);
    assert.deepEqual(fixturePaths(standaloneWebsift.skills, websiftRoot), collectSkillFiles(join(websiftRoot, "skills")));

    const standalonePromptRuntime = await resolveResources(promptRuntimeRoot, consumer);
    assert.deepEqual(fixturePaths(standalonePromptRuntime.extensions, promptRuntimeRoot), [], "direct registration must not activate suite-only reminders");
    assert.deepEqual(fixturePaths(standalonePromptRuntime.skills, promptRuntimeRoot), [], "direct registration must not expose the suite-only skill");
    const goalSkills = loadSkillsFromDir({ dir: join(promptRuntimeRoot, "skills"), source: "guidepin-test" });
    assert.deepEqual(goalSkills.diagnostics, []);
    assert.deepEqual(goalSkills.skills.map(skill => skill.name), ["goal-management"]);
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("host skill allowlist can hide suite-only goal guidance while reminder hooks remain enabled", async () => {
  const consumer = mkdtempSync(join(tmpdir(), "jeito-filtered-resource-"));
  const goal = join(SUITE_ROOT, "extensions", "guidepin", "skills", "goal-management", "SKILL.md");
  const hook = join(SUITE_ROOT, "extensions", "guidepin", "index.ts");
  try {
    for (const [skills, expected] of [
      [["jeito-setup"], false],
      [["jeito-setup", "goal-management"], true],
    ]) {
      const settings = SettingsManager.inMemory({ packages: [{ source: SUITE_ROOT, skills }] }, { projectTrusted: false });
      const resources = await new DefaultPackageManager({ cwd: consumer, agentDir: join(consumer, ".agent"), settingsManager: settings }).resolve();
      assert.ok(enabledPaths(resources.extensions).includes(hook), "the aggregate still activates the reminder hook");
      assert.equal(enabledPaths(resources.skills).includes(goal), expected, "host filter determines whether goal guidance reaches Pi");
    }
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("same-checkout aggregate and individual registrations deduplicate by resource path", async () => {
  const fixture = createResourceFixture();
  const consumer = mkdtempSync(join(tmpdir(), "jeito-resource-consumer-"));
  try {
    const resources = await resolvePackages([fixture.root, fixture.extensionRoot], consumer);
    const extensionPath = join(fixture.extensionRoot, "index.ts");
    assert.equal(resources.extensions.filter(resource => resource.path === extensionPath).length, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("aggregate and a separate individual checkout remain distinct resource owners", async () => {
  const aggregate = createResourceFixture();
  const individual = createResourceFixture();
  const consumer = mkdtempSync(join(tmpdir(), "jeito-resource-consumer-"));
  try {
    const resources = await resolvePackages([aggregate.root, individual.extensionRoot], consumer);
    const ownedFixtureExtensions = enabledPaths(resources.extensions).filter(path => path.startsWith(`${aggregate.root}/`) || path.startsWith(`${individual.root}/`));
    assert.deepEqual(ownedFixtureExtensions, [join(aggregate.extensionRoot, "index.ts"), join(individual.extensionRoot, "index.ts")].sort());
  } finally {
    rmSync(aggregate.root, { recursive: true, force: true });
    rmSync(individual.root, { recursive: true, force: true });
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("jeito setup preserves orchestration boundaries and discovers evolving extension contracts", () => {
  const loaded = loadSkillsFromDir({ dir: join(SUITE_ROOT, ".agents", "skills"), source: "jeito-test" });
  assert.deepEqual(loaded.diagnostics, []);
  assert.ok(loaded.skills.some(candidate => candidate.name === "jeito-setup"));
  const skill = readFileSync(join(SUITE_ROOT, ".agents", "skills", "jeito-setup", "SKILL.md"), "utf8");
  assert.match(skill, /host `skills` allowlist can enable the reminder hook while excluding the skill/i);
  assert.match(skill, /Prepare and verify the checkout first/);
  assert.match(skill, /failed preparation must not be followed by Pi registration/i);
  assert.match(skill, /In-session versus external-terminal boundary/);
  assert.match(skill, /npm install --omit=dev/);
  assert.match(skill, /pi install \/absolute\/path\/to\/prepared\/package -l --approve/);
  assert.match(skill, /ssh-keygen -t ed25519/);
  assert.match(skill, /Never request, read, print, copy, or write a private SSH key/);
  assert.doesNotMatch(skill, /cat\s+~\/\.ssh\/id_ed25519(?:\s|$)/m);
  assert.match(skill, /integration adapter over evolving extension contracts/);
  assert.match(skill, /Never infer a skill name from an earlier jeito release/);
  assert.match(skill, /settings\.json[\s\S]*resolve relative local package entries/i);
  assert.match(skill, /pi list.*does not mark missing local paths/is);
  assert.match(skill, /prepare path B[\s\S]*pi install[\s\S]*pi remove[\s\S]*before restarting Pi/i);
  assert.match(skill, /Never search the filesystem for a replacement checkout/i);
  assert.match(skill, /Never remove an unrelated missing registration/i);
  assert.doesNotMatch(skill, /deep-navigation-onboard|navigation-setup/);
});
