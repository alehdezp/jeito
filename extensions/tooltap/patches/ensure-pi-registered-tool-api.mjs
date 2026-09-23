#!/usr/bin/env node
/**
 * Ensure the additive native runtime APIs required by tooltap exist in Pi.
 *
 * The patch is deliberately additive. `getRegisteredTool(name)` exposes the
 * executable definition already held by Pi, while
 * `setActiveToolsWithDeferred(toolNames, deferredNames)` keeps selected tool
 * prompt material out of the epoch base prompt without removing the tools from
 * active dispatch. It supports both Pi's bundled CLI chunk and the modular SDK
 * files used by extensions.
 *
 * Every source shape and generated file is checked before runtime files are
 * written. Explicit invocation updates the selected Pi installation with
 * backups; stop Pi first. No package install or host configuration is performed.
 *
 * Usage:
 *   node ensure-pi-registered-tool-api.mjs [--quiet] [--check] [--pi <root>]
 *
 * `--check` never writes and exits 0 only when every supported surface is
 * patched. `--quiet` suppresses success output; errors still print.
 */

import { execFile, execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const BUNDLE_SPECS = [
  {
    name: "bundle shared runtime registered-tool stub",
    find: "getAllTools:notInitialized,",
    replace: "getAllTools:notInitialized,getRegisteredTool:notInitialized,",
    applied: "getRegisteredTool:notInitialized,",
  },
  {
    name: "bundle shared runtime deferred-tool stub",
    find: "getRegisteredTool:notInitialized,setActiveTools:notInitialized,",
    replace:
      "getRegisteredTool:notInitialized,setActiveToolsWithDeferred:notInitialized,setActiveTools:notInitialized,",
    applied: "setActiveToolsWithDeferred:notInitialized,",
  },
  {
    name: "bundle extension registered-tool API",
    find: "getAllTools(){return assertActive(),runtime.getAllTools()},",
    replace:
      "getAllTools(){return assertActive(),runtime.getAllTools()},getRegisteredTool(name){return assertActive(),runtime.getRegisteredTool(name)},",
    applied: "getRegisteredTool(name){return assertActive(),runtime.getRegisteredTool(name)},",
  },
  {
    name: "bundle extension deferred-tool API",
    find:
      "getRegisteredTool(name){return assertActive(),runtime.getRegisteredTool(name)},setActiveTools(toolNames){",
    replace:
      "getRegisteredTool(name){return assertActive(),runtime.getRegisteredTool(name)},setActiveToolsWithDeferred(toolNames,deferredNames){return assertActive(),runtime.setActiveToolsWithDeferred(toolNames,deferredNames)},setActiveTools(toolNames){",
    applied: "setActiveToolsWithDeferred(toolNames,deferredNames){return assertActive(),runtime.setActiveToolsWithDeferred(toolNames,deferredNames)},",
  },
  {
    name: "bundle runner registered-tool binding",
    find: "this.runtime.getAllTools=actions.getAllTools,",
    replace: "this.runtime.getAllTools=actions.getAllTools,this.runtime.getRegisteredTool=actions.getRegisteredTool,",
    applied: "this.runtime.getRegisteredTool=actions.getRegisteredTool,",
  },
  {
    name: "bundle runner deferred-tool binding",
    find: "this.runtime.getRegisteredTool=actions.getRegisteredTool,this.runtime.setActiveTools=actions.setActiveTools,",
    replace:
      "this.runtime.getRegisteredTool=actions.getRegisteredTool,this.runtime.setActiveToolsWithDeferred=actions.setActiveToolsWithDeferred,this.runtime.setActiveTools=actions.setActiveTools,",
    applied: "this.runtime.setActiveToolsWithDeferred=actions.setActiveToolsWithDeferred,",
  },
  {
    name: "bundle session registered-tool binding",
    find: "getAllTools:()=>this.getAllTools(),",
    replace: "getAllTools:()=>this.getAllTools(),getRegisteredTool:name=>this.getToolDefinition(name),",
    applied: "getRegisteredTool:name=>this.getToolDefinition(name),",
  },
  {
    name: "bundle session deferred-tool binding",
    find: "getRegisteredTool:name=>this.getToolDefinition(name),setActiveTools:toolNames=>this.setActiveToolsByName(toolNames),",
    replace:
      "getRegisteredTool:name=>this.getToolDefinition(name),setActiveToolsWithDeferred:(toolNames,deferredNames)=>this.setActiveToolsWithDeferred(toolNames,deferredNames),setActiveTools:toolNames=>this.setActiveToolsByName(toolNames),",
    applied: "setActiveToolsWithDeferred:(toolNames,deferredNames)=>this.setActiveToolsWithDeferred(toolNames,deferredNames),",
  },
  {
    name: "bundle session deferred activation method",
    find: "setActiveToolsByName(toolNames){",
    replace:
      'setActiveToolsWithDeferred(toolNames,deferredNames){if(!Array.isArray(toolNames)||!Array.isArray(deferredNames)||toolNames.some(name=>typeof name!=="string")||deferredNames.some(name=>typeof name!=="string"))throw new TypeError("toolNames and deferredNames must be arrays of tool names");let toolNameSet=new Set(toolNames);for(let name of deferredNames)if(!toolNameSet.has(name)||!this._toolRegistry.has(name))throw new Error(`Deferred tool "${name}" must be a registered member of toolNames`);let previous={deferred:this._deferredToolNames,tools:this.agent.state.tools,prompt:this.agent.state.systemPrompt,base:this._baseSystemPrompt,options:this._baseSystemPromptOptions};this._deferredToolNames=new Set(deferredNames);try{this.setActiveToolsByName(toolNames)}catch(error){this._deferredToolNames=previous.deferred;this.agent.state.tools=previous.tools;this.agent.state.systemPrompt=previous.prompt;this._baseSystemPrompt=previous.base;this._baseSystemPromptOptions=previous.options;throw error}}setActiveToolsByName(toolNames){',
    applied: "setActiveToolsWithDeferred(toolNames,deferredNames){if(!Array.isArray(toolNames)",
    verifyReplacement: true,
  },
  {
    name: "bundle deferred prompt filtering",
    find: "let validToolNames=toolNames.filter(name=>this._toolRegistry.has(name)),toolSnippets={",
    replace:
      "let validToolNames=toolNames.filter(name=>this._toolRegistry.has(name)&&!this._deferredToolNames?.has(name)),toolSnippets={",
    applied: "this._deferredToolNames?.has(name)",
  },
];

const MODULAR_SPECS = {
  "dist/core/extensions/loader.js": [
    {
      name: "modular loader registered-tool stub",
      find: "        getAllTools: notInitialized,\n        setActiveTools: notInitialized,",
      replace:
        "        getAllTools: notInitialized,\n        getRegisteredTool: notInitialized,\n        setActiveTools: notInitialized,",
      applied: "        getRegisteredTool: notInitialized,",
    },
    {
      name: "modular loader deferred-tool stub",
      find: "        getRegisteredTool: notInitialized,\n        setActiveTools: notInitialized,",
      replace:
        "        getRegisteredTool: notInitialized,\n        setActiveToolsWithDeferred: notInitialized,\n        setActiveTools: notInitialized,",
      applied: "        setActiveToolsWithDeferred: notInitialized,",
    },
    {
      name: "modular loader registered-tool API",
      find: "        getAllTools() {\n            assertActive();\n            return runtime.getAllTools();\n        },\n        setActiveTools(toolNames) {",
      replace:
        "        getAllTools() {\n            assertActive();\n            return runtime.getAllTools();\n        },\n        getRegisteredTool(name) {\n            assertActive();\n            return runtime.getRegisteredTool(name);\n        },\n        setActiveTools(toolNames) {",
      applied: "        getRegisteredTool(name) {",
    },
    {
      name: "modular loader deferred-tool API",
      find:
        "        getRegisteredTool(name) {\n            assertActive();\n            return runtime.getRegisteredTool(name);\n        },\n        setActiveTools(toolNames) {",
      replace:
        "        getRegisteredTool(name) {\n            assertActive();\n            return runtime.getRegisteredTool(name);\n        },\n        setActiveToolsWithDeferred(toolNames, deferredNames) {\n            assertActive();\n            runtime.setActiveToolsWithDeferred(toolNames, deferredNames);\n        },\n        setActiveTools(toolNames) {",
      applied: "        setActiveToolsWithDeferred(toolNames, deferredNames) {",
    },
  ],
  "dist/core/extensions/runner.js": [
    {
      name: "modular runner registered-tool binding",
      find: "        this.runtime.getAllTools = actions.getAllTools;\n        this.runtime.setActiveTools = actions.setActiveTools;",
      replace:
        "        this.runtime.getAllTools = actions.getAllTools;\n        this.runtime.getRegisteredTool = actions.getRegisteredTool;\n        this.runtime.setActiveTools = actions.setActiveTools;",
      applied: "        this.runtime.getRegisteredTool = actions.getRegisteredTool;",
    },
    {
      name: "modular runner deferred-tool binding",
      find: "        this.runtime.getRegisteredTool = actions.getRegisteredTool;\n        this.runtime.setActiveTools = actions.setActiveTools;",
      replace:
        "        this.runtime.getRegisteredTool = actions.getRegisteredTool;\n        this.runtime.setActiveToolsWithDeferred = actions.setActiveToolsWithDeferred;\n        this.runtime.setActiveTools = actions.setActiveTools;",
      applied: "        this.runtime.setActiveToolsWithDeferred = actions.setActiveToolsWithDeferred;",
    },
  ],
  "dist/core/agent-session.js": [
    {
      name: "modular session registered-tool binding",
      find: "            getAllTools: () => this.getAllTools(),\n            setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),",
      replace:
        "            getAllTools: () => this.getAllTools(),\n            getRegisteredTool: (name) => this.getToolDefinition(name),\n            setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),",
      applied: "            getRegisteredTool: (name) => this.getToolDefinition(name),",
    },
    {
      name: "modular session deferred-tool binding",
      find: "            getRegisteredTool: (name) => this.getToolDefinition(name),\n            setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),",
      replace:
        "            getRegisteredTool: (name) => this.getToolDefinition(name),\n            setActiveToolsWithDeferred: (toolNames, deferredNames) => this.setActiveToolsWithDeferred(toolNames, deferredNames),\n            setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),",
      applied: "            setActiveToolsWithDeferred: (toolNames, deferredNames) => this.setActiveToolsWithDeferred(toolNames, deferredNames),",
    },
    {
      name: "modular session deferred activation method",
      find: "    setActiveToolsByName(toolNames) {",
      replace: `    setActiveToolsWithDeferred(toolNames, deferredNames) {
        if (!Array.isArray(toolNames) || !Array.isArray(deferredNames) ||
            toolNames.some((name) => typeof name !== "string") ||
            deferredNames.some((name) => typeof name !== "string")) {
            throw new TypeError("toolNames and deferredNames must be arrays of tool names");
        }
        const toolNameSet = new Set(toolNames);
        for (const name of deferredNames) {
            if (!toolNameSet.has(name) || !this._toolRegistry.has(name)) {
                throw new Error(
                    \`Deferred tool "\${name}" must be a registered member of toolNames\`,
                );
            }
        }
        // A rebuild failure must not grant dispatch without a successful
        // activation result (and its provider-deferred classification).
        const previous = {
            deferred: this._deferredToolNames,
            tools: this.agent.state.tools,
            prompt: this.agent.state.systemPrompt,
            base: this._baseSystemPrompt,
            options: this._baseSystemPromptOptions,
        };
        this._deferredToolNames = new Set(deferredNames);
        try {
            this.setActiveToolsByName(toolNames);
        } catch (error) {
            this._deferredToolNames = previous.deferred;
            this.agent.state.tools = previous.tools;
            this.agent.state.systemPrompt = previous.prompt;
            this._baseSystemPrompt = previous.base;
            this._baseSystemPromptOptions = previous.options;
            throw error;
        }
    }
    setActiveToolsByName(toolNames) {`,
      applied: "    setActiveToolsWithDeferred(toolNames, deferredNames) {",
      verifyReplacement: true,
    },
    {
      name: "modular deferred prompt filtering",
      find: "        const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));",
      replace:
        "        const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name) && !this._deferredToolNames?.has(name));",
      applied: "!this._deferredToolNames?.has(name)",
    },
  ],
};

export function applySourceTransform(source, specs, target = "source") {
  let transformed = source;
  for (const spec of specs) {
    const appliedCount = countOccurrences(transformed, spec.applied);
    if (appliedCount > 1) {
      throw new Error(`ambiguous or mixed state for "${spec.name}" in ${target}`);
    }
    const findCount = countOccurrences(transformed, spec.find);
    if (appliedCount === 1) {
      if (spec.verifyReplacement && !transformed.includes(spec.replace)) {
        throw new Error(`existing implementation differs for "${spec.name}" in ${target}; restore the runtime backup before reapplying`);
      }
      const expectedFindCount = countOccurrences(spec.replace, spec.find);
      if (findCount > expectedFindCount) {
        throw new Error(`ambiguous or mixed state for "${spec.name}" in ${target}`);
      }
      continue;
    }
    if (findCount !== 1) {
      throw new Error(
        `anchor "${spec.name}" matched ${findCount} times in ${target} (expected exactly 1)`,
      );
    }
    transformed = transformed.replace(spec.find, spec.replace);
  }
  for (const spec of specs) {
    if (countOccurrences(transformed, spec.applied) !== 1) {
      throw new Error(`post-patch verification failed for "${spec.name}" in ${target}`);
    }
  }
  return transformed;
}

export function transformBundleChunk(source, target = "bundle chunk") {
  return applySourceTransform(source, BUNDLE_SPECS, target);
}

export function transformModularSource(source, relativePath) {
  const specs = MODULAR_SPECS[relativePath];
  if (!specs) throw new Error(`unsupported modular patch target: ${relativePath}`);
  return applySourceTransform(source, specs, relativePath);
}

export function isBundleTarget(source) {
  return BUNDLE_SPECS.some((spec) => source.includes(spec.find) || source.includes(spec.applied));
}


function countOccurrences(source, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) !== -1) {
    count++;
    offset += needle.length;
  }
  return count;
}

function parsePiFlag(args) {
  const index = args.indexOf("--pi");
  if (index === -1) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--")) {
    throw new Error("--pi requires a package root");
  }
  return args[index + 1];
}

function resolvePiRoot(piRootFlag) {
  if (piRootFlag) return path.resolve(piRootFlag);
  try {
    const bin = execFileSync("/bin/bash", ["-c", "command -v pi"], { encoding: "utf8" }).trim();
    if (!bin) throw new Error("`pi` not found on PATH; pass --pi <package-root>");
    return path.resolve(path.dirname(realpathSync(bin)), "..", "..");
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "could not resolve the active `pi` binary");
  }
}

async function prepareTargets(root) {
  const chunksDir = path.join(root, "dist", "bundle", "chunks");
  if (!existsSync(chunksDir)) {
    throw new Error(`no bundle chunks directory under ${root}; is this a pi-coding-agent install?`);
  }
  const entries = (await readdir(chunksDir)).filter((name) => /^chunk-.*\.js$/.test(name));
  const bundleTargets = [];
  for (const name of entries) {
    const file = path.join(chunksDir, name);
    const source = await readFile(file, "utf8");
    if (isBundleTarget(source)) bundleTargets.push({ file, name, source, specs: BUNDLE_SPECS });
  }
  if (bundleTargets.length === 0) {
    throw new Error(
      `no bundle chunk in ${chunksDir} matches the patch anchors — the installed Pi version changed its bundle shape; refusing to write`,
    );
  }
  if (bundleTargets.length > 1) {
    throw new Error(`patch anchors matched ${bundleTargets.length} bundle chunks; refusing an ambiguous patch`);
  }

  const targets = [...bundleTargets];
  for (const [relativePath, specs] of Object.entries(MODULAR_SPECS)) {
    const file = path.join(root, relativePath);
    if (!existsSync(file)) throw new Error(`missing modular patch target ${file}; refusing to write`);
    targets.push({ file, name: relativePath, source: await readFile(file, "utf8"), specs });
  }
  return targets.map((target) => ({
    ...target,
    patched: applySourceTransform(target.source, target.specs, target.name),
  }));
}

async function validateSyntax(targets) {
  const validationRoot = await mkdtemp(path.join(tmpdir(), "ensure-pi-runtime-api-"));
  try {
    for (const target of targets) {
      // Pi ships ESM. An untyped temporary .js file can be falsely accepted by
      // Node 24's syntax auto-detection even when its ESM grammar is invalid.
      const validationFile = path.join(validationRoot, target.name.replaceAll(path.sep, "-").replaceAll("/", "-") + ".mjs");
      await writeFile(validationFile, target.patched);
      try {
        await execFileAsync(process.execPath, ["--check", validationFile]);
      } catch (error) {
        const detail = error?.stderr?.trim() || error?.message || "unknown syntax error";
        throw new Error(`syntax validation failed for ${target.name}: ${detail}`);
      }
    }
  } finally {
    await rm(validationRoot, { recursive: true, force: true });
  }
}

async function applyTargets(targets, version, quiet) {
  for (const target of targets) {
    if (target.patched === target.source) continue;
    if (await readFile(target.file, "utf8") !== target.source) {
      throw new Error(`runtime changed during validation: ${target.name}; refusing to overwrite it`);
    }
    const backup = `${target.file}.pre-deferred-tools-api-${version}.bak`;
    if (!existsSync(backup)) await copyFile(target.file, backup);
    const temp = `${target.file}.patched-tmp-${process.pid}`;
    await writeFile(temp, target.patched, { mode: statSync(target.file).mode });
    await rename(temp, target.file);
    if (!quiet) console.log(`ensure-pi-registered-tool-api: patched ${target.name}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const quiet = argv.includes("--quiet");
  const checkOnly = argv.includes("--check");
  const root = resolvePiRoot(parsePiFlag(argv));
  const targets = await prepareTargets(root);
  await validateSyntax(targets);
  const allPatched = targets.every((target) => target.patched === target.source);
  if (checkOnly) {
    if (!allPatched) {
      console.error("ensure-pi-registered-tool-api: NOT fully applied (run without --check to patch)");
      process.exitCode = 1;
      return false;
    }
    if (!quiet) console.log("ensure-pi-registered-tool-api: fully applied");
    return true;
  }
  const packageInfo = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  await applyTargets(targets, packageInfo.version ?? "unknown", quiet);
  if (allPatched && !quiet) console.log("ensure-pi-registered-tool-api: already fully applied");
  return true;
}

const runningAsCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (runningAsCli) {
  try {
    await main();
  } catch (error) {
    console.error(`ensure-pi-registered-tool-api: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
