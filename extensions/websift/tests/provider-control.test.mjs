// Decision protected: provider setup and diagnostics preserve zero-call startup, masked secrets, safe files, isolated usage failures, and one-call liveness.
import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { createContext7Adapter } from "../src/adapters/context7.ts";
import { createExaAdapter } from "../src/adapters/exa.ts";
import { createLinkupAdapter } from "../src/adapters/linkup.ts";
import { createWebclawAdapter } from "../src/adapters/webclaw.ts";
import { createPiPackagesAdapter } from "../src/adapters/pi-packages.ts";
import { createSerperAdapter } from "../src/adapters/serper.ts";
import { createSkillsMpAdapter } from "../src/adapters/skillsmp.ts";
import { createTavilyAdapter } from "../src/adapters/tavily.ts";
import { createXSearchAdapter } from "../src/adapters/xsearch.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { AdapterRegistry } from "../src/registry.ts";
import {
  buildLoaderLine, buildStatusLines, detectShell, ensureLoaderLine, gatherUsage, LIVENESS_PROBES, LOADER_MARKER,
  maskedSecretInput, PROVIDER_PAGES, quoteForShell, registerWebSetup, resolveOpenCommand, runLivenessProbe,
  scanShellEnvPresence, shellDescriptor, updateSecretFile, writeConfigAtomic,
} from "../src/provider-control.ts";

const ENV_NAMES = ["SERPER_API_KEY", "EXA_API_KEY", "TAVILY_API_KEY", "LINKUP_API_KEY", "XAI_API_KEY", "CONTEXT7_API_KEY", "SKILLSMP_API_KEY"];

// Runs fn with the provider env vars cleared (then optionally set per `set`), restoring after.
function withCleanEnv(set, fn) {
  const saved = {};
  for (const name of ENV_NAMES) { saved[name] = process.env[name]; delete process.env[name]; }
  for (const [key, value] of Object.entries(set)) process.env[key] = value;
  try { return fn(); } finally {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  }
}

function makeRegistry() {
  return new AdapterRegistry([
    createSerperAdapter(), createExaAdapter(), createTavilyAdapter(), createLinkupAdapter(), createXSearchAdapter(),
    createWebclawAdapter({ responseBytes: 5_000_000 }), createContext7Adapter(), createSkillsMpAdapter(), createPiPackagesAdapter(),
  ]);
}

function setupCommand(piOverrides = {}, registry = makeRegistry()) {
  const commands = new Map();
  const tools = [];
  registerWebSetup({ registerCommand: (name, command) => commands.set(name, command), registerTool: (tool) => tools.push(tool), ...piOverrides }, registry);
  return { commands, tools };
}

// Mock command context. `selects`/`confirms` entries may be values or functions receiving the
// presented options/title. ctx.ui.input throws: secrets must never flow through it. Confirm
// titles AND messages are recorded so redacted previews shown in dialogs can be asserted.
function makeCtx({ mode = "tui", selects = [], confirms = [], custom } = {}) {
  const notifications = [];
  const confirmRecords = [];
  let selectIndex = 0;
  let confirmIndex = 0;
  const ctx = {
    mode,
    signal: undefined,
    ui: {
      notify: (text, type) => notifications.push({ text, type: type ?? "info" }),
      select: async (title, options) => {
        const next = selects[selectIndex++];
        return typeof next === "function" ? next(options) : next;
      },
      confirm: async (title, message) => {
        confirmRecords.push({ title, message });
        const next = confirms[confirmIndex++];
        return typeof next === "function" ? next(title, message) : Boolean(next);
      },
      input: async () => { throw new Error("ctx.ui.input must never be used for secret entry"); },
      custom: custom ?? (() => { throw new Error("ctx.ui.custom not configured for this test"); }),
    },
  };
  return { ctx, notifications, confirmRecords };
}

// Drives the real pi-tui Input through the masked component: types/pastes `secret`, submits.
function secretCustom(secret) {
  return (factory) => new Promise((resolve) => {
    const component = factory({ requestRender() {} }, { fg: (_color, text) => text }, {}, resolve);
    component.handleInput(secret);
    component.handleInput("\n");
  });
}

function tempAgentDir() {
  const dir = mkdtempSync(join(tmpdir(), "websift-setup-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

// Registration shape is owned by tests/registration.test.mjs; this file owns provider setup behavior.

test("opening /web-setup makes zero network calls and reports local credential status", async () => {
  tempAgentDir();
  let fetchCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalls++; throw new Error("network is forbidden on open"); };
  try {
    const { commands } = setupCommand();
    const { ctx, notifications } = makeCtx({ selects: [undefined] });
    await commands.get("web-setup").handler("", ctx);
    assert.equal(fetchCalls, 0);
    assert.match(notifications[0].text, /jeito websift — provider setup/);
    assert.match(notifications[0].text, /not a reachability check/);
    assert.match(notifications[0].text, /- webclaw: enabled · local, no account or key required/);
    // Local status classification under a clean env: no provider reports a credential present.
    withCleanEnv({}, () => {
      const lines = buildStatusLines(makeRegistry(), structuredClone(DEFAULT_CONFIG));
      assert.equal(lines.length, 9);
      assert.ok(lines.every((line) => /credential missing|works anonymously|local, no account/.test(line)));
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the catalog exposes exact grounded routes, local no-account providers, and only applicable actions", async () => {
  const urls = Object.fromEntries(PROVIDER_PAGES.flatMap((entry) => entry.pages.map((page) => [`${entry.id}:${page.label}`, page.url])));
  assert.equal(urls["serper:Dashboard"], "https://serper.dev/dashboard");
  assert.equal(urls["serper:API keys"], "https://serper.dev/api-keys");
  assert.equal(urls["serper:Billing"], "https://serper.dev/billing");
  assert.equal(urls["serper:Docs"], "https://serper.dev/");
  assert.equal(urls["exa:Dashboard"], "https://dashboard.exa.ai/");
  assert.equal(urls["exa:API keys"], "https://dashboard.exa.ai/api-keys");
  assert.equal(urls["exa:Billing"], "https://dashboard.exa.ai/billing");
  assert.equal(urls["exa:Docs"], "https://exa.ai/docs");
  assert.equal(urls["tavily:Dashboard"], "https://app.tavily.com/");
  assert.equal(urls["tavily:Billing"], "https://app.tavily.com/billing");
  assert.equal(urls["tavily:Docs"], "https://docs.tavily.com/");
  assert.equal(urls["linkup:Billing"], "https://app.linkup.so/organization/billing");
  assert.equal(urls["linkup:Docs"], "https://docs.linkup.so/pages/documentation/platform/authentication");
  assert.equal(urls["xsearch:Console"], "https://console.x.ai/");
  assert.equal(urls["xsearch:Billing"], "https://console.x.ai/team/default/billing");
  assert.equal(urls["xsearch:Usage"], "https://console.x.ai/team/default/usage");
  assert.equal(urls["xsearch:Docs"], "https://docs.x.ai/");
  assert.equal(urls["context7:Dashboard"], "https://context7.com/dashboard");
  assert.equal(urls["context7:Key docs"], "https://context7.com/docs/howto/api-keys");
  assert.equal(urls["context7:API docs"], "https://context7.com/docs/api-guide");
  assert.equal(urls["skillsmp:Home"], "https://skillsmp.com/");
  assert.equal(urls["skillsmp:Docs"], "https://skillsmp.com/docs/api");
  assert.equal(urls["skillsmp:Billing"], undefined); // no account/billing surface; never guessed

  // Local providers are no-account with no pages; selecting one offers only a notice and Back.
  const webclaw = PROVIDER_PAGES.find((entry) => entry.id === "webclaw");
  const packages = PROVIDER_PAGES.find((entry) => entry.id === "pi-packages");
  assert.equal(webclaw.local, true);
  assert.deepEqual(webclaw.pages, []);
  assert.equal(packages.local, true);
  assert.deepEqual(packages.pages, []);
  tempAgentDir();
  const { commands } = setupCommand();
  let localOptions;
  const { ctx, notifications } = makeCtx({ selects: ["Webclaw (local)", (all) => { localOptions = all; return "Back"; }, "Exit"] });
  await commands.get("web-setup").handler("", ctx);
  assert.deepEqual(localOptions, ["Back"]);
  assert.ok(notifications.some((note) => /Webclaw .* is local: no account, API key, or usage/.test(note.text)));

  // Action menus offer only applicable actions, and an existing inline key switches Set to Replace/Remove.
  const seen = {};
  const { ctx: menuCtx } = makeCtx({ selects: [
    "Tavily", (options) => { seen.tavily = options; return "Back"; },
    "Serper", (options) => { seen.serper = options; return "Back"; },
    "Exit",
  ] });
  await commands.get("web-setup").handler("", menuCtx);
  assert.ok(seen.tavily.some((option) => option.startsWith("Open") && option.includes("Docs")));
  assert.ok(seen.tavily.includes("Set an API key (masked)"));
  assert.ok(seen.tavily.includes("Check usage"));
  assert.ok(!seen.tavily.some((option) => option.includes("Remove") || option.includes("Replace")));
  assert.ok(seen.serper.includes("Set an API key (masked)"));
  assert.ok(!seen.serper.includes("Check usage"));
});

test("shell persistence is not offered for an unsafe custom environment name", async () => {
  const savedShell = process.env.SHELL;
  const dir = tempAgentDir();
  process.env.SHELL = "/bin/zsh";
  writeFileSync(join(dir, "web.yaml"), "providers:\n  exa:\n    env: 'EXA_API_KEY; touch /tmp/nope'\n");
  try {
    let options;
    const { commands } = setupCommand();
    const { ctx } = makeCtx({ selects: ["Exa", (all) => { options = all; return "Back"; }, "Exit"] });
    await commands.get("web-setup").handler("", ctx);
    assert.ok(options.includes("Set an API key (masked)"));
    assert.ok(!options.some((option) => option.startsWith("Persist ")));
  } finally {
    if (savedShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = savedShell;
  }
});

test("masked input renders only bullets and rejects a pasted line break without exposing content", async () => {
  let component;
  const renderCtx = {
    mode: "tui",
    ui: { custom: (factory) => {
      component = factory({ requestRender() {} }, { fg: (_color, text) => text }, {}, () => {});
      return new Promise(() => {}); // never settles; we only inspect rendering
    } },
  };
  maskedSecretInput(renderCtx, "Tavily API key").catch(() => {});
  const typed = "xyzzy";
  const sentinel = "super-secret-pasted-value";
  component.handleInput(typed);
  component.handleInput(`\x1b[200~${sentinel}\x1b[201~`); // bracketed paste

  const rendered = component.render(80).join("\n");
  assert.ok(!rendered.includes(sentinel), "pasted secret must never be rendered");
  assert.ok(!rendered.includes(typed), "typed secret must never be rendered");
  assert.ok(rendered.includes("•".repeat(typed.length + sentinel.length)), "one bullet per entered character");
  assert.ok(rendered.includes(CURSOR_MARKER), "emits Pi CURSOR_MARKER for the cursor");
  const narrow = component.render(4)[1];
  assert.equal((narrow.match(/•/g) ?? []).length, 4); // narrow render stays masked and does not crash
  component.dispose();
  assert.ok(!component.render(80).join("\n").includes(sentinel));

  // A plain submit returns the exact value; a pasted line break (even split across chunks) is flagged, not exposed.
  const plain = await maskedSecretInput({
    mode: "tui",
    ui: { custom: (factory) => new Promise((resolve) => {
      const c = factory({ requestRender() {} }, { fg: (_color, text) => text }, {}, resolve);
      c.handleInput(" exact-payload ");
      c.handleInput("\n"); // submission Enter must not count as a pasted break
    }) },
  }, "Key");
  assert.equal(plain.value, " exact-payload ");
  assert.equal(plain.containedLineBreak, false);
  const pasted = await maskedSecretInput({
    mode: "tui",
    ui: { custom: (factory) => new Promise((resolve) => {
      const c = factory({ requestRender() {} }, { fg: (_color, text) => text }, {}, resolve);
      c.handleInput("\x1b[200~part1");    // paste starts, no line break yet
      c.handleInput("\npart2\x1b[201~");  // line break arrives in a later chunk
      c.handleInput("\n");                // submission Enter, outside the paste
    }) },
  }, "Key");
  assert.equal(pasted.containedLineBreak, true);
  assert.ok(!JSON.stringify(pasted).includes("part1\npart2"), "the raw pasted content is never retained");
});

test("set/replace/remove write a 0600 inline key, preserve unrelated YAML, redact every surface, and leak nothing", async () => {
  const dir = tempAgentDir();
  const secret = "s3cret-exact-value";
  writeFileSync(join(dir, "web.yaml"), "# keep comment\nproviders:\n  exa:\n    apiKey: stay\n");
  const { commands } = setupCommand();

  // Set: masked entry, redacted confirmation, 0600 write, selective preservation, no secret in any output.
  const confirmTitles = [];
  const { ctx, notifications, confirmRecords } = makeCtx({
    selects: ["Serper", (options) => options.find((option) => option.includes("Set an API key")), "Back", "Exit"],
    confirms: [(title) => { confirmTitles.push(title); return true; }, (title) => { confirmTitles.push(title); return true; }],
    custom: secretCustom(secret),
  });
  await commands.get("web-setup").handler("", ctx);
  const target = join(dir, "web.yaml");
  const afterSet = parse(readFileSync(target, "utf8"));
  assert.equal(afterSet.providers.serper.apiKey, secret);
  assert.equal(afterSet.providers.exa.apiKey, "stay"); // unrelated key preserved
  assert.match(readFileSync(target, "utf8"), /# keep comment/); // comment preserved
  assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(confirmTitles, ["Enter a masked API key?", "Store API key in plaintext?"]);
  const finalConfirm = confirmRecords[confirmRecords.length - 1];
  assert.match(finalConfirm.message, /providers\.serper\.apiKey: \[redacted\]/);
  const allText = notifications.map((note) => note.text).join("\n") + finalConfirm.message;
  assert.ok(!allText.includes(secret), "secret must never appear in any notification or confirm preview");
  assert.match(allText, /takes precedence over any environment variable/);

  // Replace: requires the explicit replace confirmation and overwrites only the selected key.
  const replaceTitles = [];
  const { ctx: replaceCtx } = makeCtx({
    selects: ["Serper", (options) => options.find((option) => option.includes("Replace the inline")), "Back", "Exit"],
    confirms: [(title) => { replaceTitles.push(title); return true; }, () => true],
    custom: secretCustom("brand-new-key"),
  });
  await commands.get("web-setup").handler("", replaceCtx);
  assert.equal(replaceTitles[0], "Replace the existing inline key?");
  const afterReplace = parse(readFileSync(target, "utf8"));
  assert.equal(afterReplace.providers.serper.apiKey, "brand-new-key");
  assert.equal(afterReplace.providers.exa.apiKey, "stay");

  // Remove: deletes only the selected inline key and keeps comments and siblings.
  const { ctx: removeCtx } = makeCtx({ selects: ["Serper", "Remove the inline API key", "Back", "Exit"], confirms: [true] });
  await commands.get("web-setup").handler("", removeCtx);
  const raw = readFileSync(target, "utf8");
  assert.match(raw, /# keep comment/);
  const afterRemove = parse(raw);
  assert.equal(afterRemove.providers.serper?.apiKey, undefined);
  assert.equal(afterRemove.providers.exa.apiKey, "stay");
});

test("an unsafe existing config is never overwritten and the secret is never surfaced", async () => {
  const secret = "wont-be-written";
  const drive = async (dir) => {
    const { commands } = setupCommand();
    const { ctx, notifications } = makeCtx({
      selects: ["Serper", (options) => options.find((option) => option.includes("Set an API key")), "Back", "Exit"],
      confirms: [true],
      custom: secretCustom(secret),
    });
    await commands.get("web-setup").handler("", ctx);
    return notifications;
  };

  // Malformed YAML: left byte-for-byte unchanged with a generic secret-safe error.
  const malformedDir = tempAgentDir();
  const malformed = "providers: [unclosed";
  writeFileSync(join(malformedDir, "web.yaml"), malformed);
  let notes = await drive(malformedDir);
  assert.equal(readFileSync(join(malformedDir, "web.yaml"), "utf8"), malformed);
  assert.ok(notes.some((note) => note.type === "error" && /not valid YAML/.test(note.text)));
  assert.ok(!notes.map((n) => n.text).join("\n").includes(secret));

  // Unreadable target (a directory, non-ENOENT read failure): untouched, generic error, no secret.
  const unreadableDir = tempAgentDir();
  mkdirSync(join(unreadableDir, "web.yaml"));
  notes = await drive(unreadableDir);
  assert.ok(statSync(join(unreadableDir, "web.yaml")).isDirectory(), "existing target must remain untouched");
  assert.ok(notes.some((note) => note.type === "error" && /Could not read/.test(note.text)));
  assert.ok(!notes.map((n) => n.text).join("\n").includes(secret));

  // Symlink and non-regular targets are refused at the atomic-write boundary, left untouched.
  const linkDir = mkdtempSync(join(tmpdir(), "web-atomic-"));
  const real = join(linkDir, "real.yaml");
  writeFileSync(real, "original: true\n");
  const link = join(linkDir, "web.yaml");
  symlinkSync(real, link);
  assert.throws(() => writeConfigAtomic(link, "evil: true\n"));
  assert.equal(readFileSync(real, "utf8"), "original: true\n");
  const dirTarget = join(linkDir, "dir.yaml");
  mkdirSync(dirTarget);
  assert.throws(() => writeConfigAtomic(dirTarget, "evil: true\n"));
  assert.ok(statSync(dirTarget).isDirectory());

  // A regular write lands at 0600 with no leftover temp or backup.
  const okDir = mkdtempSync(join(tmpdir(), "web-atomic-"));
  writeConfigAtomic(join(okDir, "web.yaml"), "providers: {}\n");
  assert.equal(statSync(join(okDir, "web.yaml")).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(okDir), ["web.yaml"]);
});

test("browser open uses fixed platform arguments and a failed open reports only the public URL", async () => {
  assert.deepEqual(resolveOpenCommand("darwin", "https://x.dev"), { command: "open", args: ["https://x.dev"] });
  assert.deepEqual(resolveOpenCommand("linux", "https://x.dev"), { command: "xdg-open", args: ["https://x.dev"] });
  assert.deepEqual(resolveOpenCommand("win32", "https://x.dev"), { command: "cmd", args: ["/c", "start", "", "https://x.dev"] });

  // A throwing exec and a nonzero exit are both a failed open: the URL is reported, internal output never is.
  tempAgentDir();
  const execs = [];
  const { commands } = setupCommand({
    exec: async (command, args) => { execs.push({ command, args }); return { code: 1, killed: false, stdout: "internal-out", stderr: "internal-err" }; },
  });
  const { ctx, notifications } = makeCtx({ selects: [
    "Serper",
    (options) => options.find((option) => option.startsWith("Open") && option.includes("Docs")),
    "Back",
    "Exit",
  ] });
  await commands.get("web-setup").handler("", ctx);
  assert.equal(execs.length, 1);
  assert.deepEqual(execs[0].args, ["https://serper.dev/"]); // fixed args unchanged
  const allText = notifications.map((note) => note.text).join("\n");
  assert.match(allText, /Could not open https:\/\/serper\.dev\/ automatically/);
  assert.ok(!allText.includes("internal-out"), "stdout must not be surfaced");
  assert.ok(!allText.includes("internal-err"), "stderr must not be surfaced");
  assert.ok(!notifications.some((note) => note.type === "info" && /Opened /.test(note.text)));
});

test("gatherUsage dispatches configured providers concurrently, isolates failures, and honors a provider filter", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.providers.tavily = { enabled: true, apiKey: "tvly-inline" };
  config.providers.linkup = { enabled: true, apiKey: "lk-inline" };

  // Concurrent: both providers are dispatched before either resolves.
  const dispatched = [];
  const deferred = new Map();
  const deferredFetch = (url) => {
    dispatched.push(String(url));
    return new Promise((resolve) => { deferred.set(String(url), resolve); });
  };
  const pending = gatherUsage(config, undefined, deferredFetch);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(dispatched.some((url) => url.includes("api.tavily.com/usage")));
  assert.ok(dispatched.some((url) => url.includes("api.linkup.so/v1/credits/balance")));
  deferred.get([...deferred.keys()].find((url) => url.includes("tavily")))(new Response(JSON.stringify({ key: { usage: 5, limit: 100 } })));
  deferred.get([...deferred.keys()].find((url) => url.includes("linkup")))(new Response(JSON.stringify({ balance: 77 })));
  assert.deepEqual(await pending, ["- tavily: key 5/100 credits", "- linkup: 77 credits remaining"]);

  // Partial failure: one provider's error is reported without suppressing the other.
  const flakyFetch = async (url) => (String(url).includes("tavily")
    ? new Response("{}", { status: 500 })
    : new Response(JSON.stringify({ balance: 3 })));
  assert.deepEqual(await gatherUsage(config, undefined, flakyFetch), [
    "- tavily: usage unavailable (network)",
    "- linkup: 3 credits remaining",
  ]);

  // Provider filter: exactly one account call for the selected provider.
  const linkupUrls = [];
  const linkupLines = await gatherUsage(config, undefined, async (url) => {
    linkupUrls.push(String(url));
    return new Response(JSON.stringify({ balance: 9 }));
  }, "linkup");
  assert.equal(linkupUrls.length, 1);
  assert.match(linkupUrls[0], /api\.linkup\.so\/v1\/credits\/balance/);
  assert.deepEqual(linkupLines, ["- linkup: 9 credits remaining"]);
});

test("detectShell infers only from $SHELL basename, never executes; presence scan reports names/paths but never values", () => {
  assert.equal(detectShell({ SHELL: "/opt/homebrew/bin/fish" }), "fish");
  assert.equal(detectShell({ SHELL: "/bin/zsh" }), "zsh");
  assert.equal(detectShell({ SHELL: "/usr/bin/bash" }), "bash");
  assert.equal(detectShell({ SHELL: "/usr/bin/tcsh" }), undefined);
  assert.equal(detectShell({}), undefined);

  const root = mkdtempSync(join(tmpdir(), "shell-presence-"));
  mkdirSync(join(root, "fish"), { recursive: true });
  writeFileSync(join(root, "fish", "config.fish"), "set -gx EXA_API_KEY supersecretvalue123\nset -g -x SERPER_API_KEY othervalue456\nset -q TAVILY_API_KEY\n# LINKUP_API_KEY=commented\n");
  const descriptor = shellDescriptor("fish", { XDG_CONFIG_HOME: root });
  const presence = scanShellEnvPresence(descriptor, ["EXA_API_KEY", "SERPER_API_KEY", "TAVILY_API_KEY", "LINKUP_API_KEY"]);
  assert.equal(presence.find((p) => p.envName === "EXA_API_KEY").file, join(root, "fish", "config.fish"));
  assert.equal(presence.find((p) => p.envName === "SERPER_API_KEY").file, join(root, "fish", "config.fish"));
  assert.equal(presence.find((p) => p.envName === "TAVILY_API_KEY").file, undefined);
  assert.equal(presence.find((p) => p.envName === "LINKUP_API_KEY").file, undefined);
  const output = JSON.stringify(presence);
  assert.ok(!output.includes("supersecretvalue123"), "presence output must never contain values");
  assert.ok(!output.includes("othervalue456"));
});

test("quoteForShell quotes shell metacharacters and rejects CR/LF/NUL", () => {
  assert.equal(quoteForShell("plain-key_123"), "'plain-key_123'");
  assert.equal(quoteForShell("a'b"), "'a'\\''b'");
  assert.equal(quoteForShell("a$b`c\\d"), "'a$b`c\\d'");
  assert.equal(quoteForShell("a b*c?~%"), "'a b*c?~%'");
  assert.equal(quoteForShell("a&b;c|d"), "'a&b;c|d'");
  assert.equal(quoteForShell("a(b){c}[d]"), "'a(b){c}[d]'");
  assert.equal(quoteForShell("aéb✓"), "'aéb✓'");
  assert.equal(quoteForShell("a\nb"), undefined);
  assert.equal(quoteForShell("a\rb"), undefined);
  assert.equal(quoteForShell("a\0b"), undefined);
});

test("updateSecretFile replaces/appends exactly one assignment, preserves others, and loader is idempotent", () => {
  const fresh = updateSecretFile("", "fish", "EXA_API_KEY", "'v1'");
  assert.match(fresh, /managed by \/web-setup/);
  assert.match(fresh, /^set -gx EXA_API_KEY 'v1'$/m);

  const existing = "# keep me\nset -gx OTHER 'x'\nset -gx EXA_API_KEY 'old'\n";
  const updated = updateSecretFile(existing, "fish", "EXA_API_KEY", "'new'");
  assert.match(updated, /# keep me/);
  assert.match(updated, /set -gx OTHER 'x'/);
  assert.match(updated, /set -gx EXA_API_KEY 'new'/);
  assert.ok(!updated.includes("'old'"));
  assert.equal((updated.match(/EXA_API_KEY/g) || []).length, 1);

  const posix = updateSecretFile("", "zsh", "EXA_API_KEY", "'v'");
  assert.match(posix, /^export EXA_API_KEY='v'$/m);

  const loader = buildLoaderLine("/h/.config/jeito/secrets.zsh");
  assert.match(loader, new RegExp(LOADER_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(loader, /\[ -f '\/h\/\.config\/jeito\/secrets\.zsh' \] && \. '\/h\/\.config\/jeito\/secrets\.zsh'/);
  const once = ensureLoaderLine("# user rc\nexport A=1\n", loader);
  assert.match(once, /export A=1/);
  const markerRe = new RegExp(LOADER_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  assert.equal((once.match(markerRe) || []).length, 1);
  assert.equal(ensureLoaderLine(once, loader), once);
});

test("fish: masked env-key write persists to conf.d at 0600/0700, auto-loads, replaces, and leaks nothing", async () => {
  const secret = "fish-exact-value-42";
  const second = "fish-second-value";
  const root = mkdtempSync(join(tmpdir(), "web-shell-home-"));
  const config = join(root, ".config");
  const saved = { SHELL: process.env.SHELL, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.SHELL = "/opt/homebrew/bin/fish";
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = config;
  process.env.PI_CODING_AGENT_DIR = join(root, ".pi");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  for (const name of ENV_NAMES) delete process.env[name];

  try {
    const drive = async (value) => {
      const { commands } = setupCommand();
      const { ctx, notifications, confirmRecords } = makeCtx({
        selects: ["Exa", (options) => options.find((option) => option.startsWith("Persist ")), "Back", "Exit"],
        confirms: [true, true],
        custom: secretCustom(value),
      });
      await commands.get("web-setup").handler("", ctx);
      return { notifications, confirmRecords };
    };

    const { notifications, confirmRecords } = await drive(secret);
    const secretFile = join(config, "fish", "conf.d", "90-jeito-secrets.fish");
    const confd = join(config, "fish", "conf.d");
    assert.equal(statSync(secretFile).mode & 0o777, 0o600);
    assert.equal(statSync(confd).mode & 0o777, 0o700);
    assert.match(readFileSync(secretFile, "utf8"), new RegExp(`set -gx EXA_API_KEY '${secret}'`));
    assert.equal(existsSync(join(root, ".zshrc")), false);
    assert.equal(existsSync(join(root, ".bashrc")), false);
    const allText = notifications.map((n) => n.text).join("\n") + confirmRecords.map((c) => c.message).join("\n");
    assert.ok(!allText.includes(secret), "secret must never appear in any output");
    assert.match(allText, /\[redacted\]/);

    await drive(second);
    const raw = readFileSync(secretFile, "utf8");
    assert.match(raw, new RegExp(`set -gx EXA_API_KEY '${second}'`));
    assert.ok(!raw.includes(secret));
    assert.equal((raw.match(/EXA_API_KEY/g) || []).length, 1);
    assert.equal(statSync(secretFile).mode & 0o777, 0o600);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("zsh: loader-backed write creates 0600 secret + 0700 dir, adds guarded idempotent loader, preserves rc, refuses symlinks, leaks nothing", async () => {
  const secret = "zsh-exact-value-99";
  const second = "zsh-second";
  const root = mkdtempSync(join(tmpdir(), "web-shell-home-"));
  const config = join(root, ".config");
  const saved = { SHELL: process.env.SHELL, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.SHELL = "/bin/zsh";
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = config;
  process.env.PI_CODING_AGENT_DIR = join(root, ".pi");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  for (const name of ENV_NAMES) delete process.env[name];

  try {
    const secretFile = join(config, "jeito", "secrets.zsh");
    const jeitoDir = join(config, "jeito");
    const zshrc = join(root, ".zshrc");
    writeFileSync(zshrc, "# user zshrc\nexport OTHER=keep\n");
    chmodSync(zshrc, 0o640);

    const drive = async (value) => {
      const { commands } = setupCommand();
      const { ctx, notifications, confirmRecords } = makeCtx({
        selects: ["Exa", (options) => options.find((option) => option.startsWith("Persist ")), "Back", "Exit"],
        confirms: [true, true],
        custom: secretCustom(value),
      });
      await commands.get("web-setup").handler("", ctx);
      return { notifications, confirmRecords };
    };

    const { notifications, confirmRecords } = await drive(secret);
    assert.equal(statSync(secretFile).mode & 0o777, 0o600);
    assert.equal(statSync(jeitoDir).mode & 0o777, 0o700);
    assert.match(readFileSync(secretFile, "utf8"), new RegExp(`export EXA_API_KEY='${secret}'`));
    const rc = readFileSync(zshrc, "utf8");
    assert.match(rc, /export OTHER=keep/);
    const markerRe = new RegExp(LOADER_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    assert.match(rc, markerRe);
    const escapedPath = secretFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(rc, new RegExp(`\\[ -f '${escapedPath}' \\] && \\. '${escapedPath}'`));
    assert.equal(statSync(zshrc).mode & 0o777, 0o640, "existing rc mode must be preserved");
    const allText = notifications.map((n) => n.text).join("\n") + confirmRecords.map((c) => c.message).join("\n");
    assert.ok(!allText.includes(secret));
    assert.match(allText, /\[ -f /);

    await drive(second);
    const rc2 = readFileSync(zshrc, "utf8");
    const markerReG = new RegExp(LOADER_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    assert.equal((rc2.match(markerReG) || []).length, 1);
    const raw = readFileSync(secretFile, "utf8");
    assert.match(raw, new RegExp(`export EXA_API_KEY='${second}'`));
    assert.ok(!raw.includes(secret));
    assert.equal((raw.match(/EXA_API_KEY/g) || []).length, 1);

    // Partial state is honest: if the rc loader is unsafe, the already-written key remains and
    // the command gives manual recovery instead of falsely claiming nothing changed.
    const partialRoot = mkdtempSync(join(tmpdir(), "web-shell-loader-symlink-"));
    const partialConfig = join(partialRoot, ".config");
    process.env.HOME = partialRoot;
    process.env.XDG_CONFIG_HOME = partialConfig;
    process.env.PI_CODING_AGENT_DIR = join(partialRoot, ".pi");
    mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    const realRc = join(partialRoot, "real-zshrc");
    writeFileSync(realRc, "# managed elsewhere\n");
    symlinkSync(realRc, join(partialRoot, ".zshrc"));
    const partialSecret = "stored-despite-loader-failure";
    const { notifications: partialNotes } = await drive(partialSecret);
    const partialSecretFile = join(partialConfig, "jeito", "secrets.zsh");
    assert.match(readFileSync(partialSecretFile, "utf8"), new RegExp(`export EXA_API_KEY='${partialSecret}'`));
    assert.equal(readFileSync(realRc, "utf8"), "# managed elsewhere\n");
    const partialText = partialNotes.map((n) => n.text).join("\n");
    assert.match(partialText, /key remains stored/i);
    assert.doesNotMatch(partialText, /Nothing was written/i);
    assert.ok(!partialText.includes(partialSecret));

    // Symlink refusal: real file untouched, secret-free warning, no leak.
    const linkRoot = mkdtempSync(join(tmpdir(), "web-shell-symlink-"));
    const linkConfig = join(linkRoot, ".config");
    process.env.HOME = linkRoot;
    process.env.XDG_CONFIG_HOME = linkConfig;
    process.env.PI_CODING_AGENT_DIR = join(linkRoot, ".pi");
    mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    mkdirSync(join(linkConfig, "jeito"), { recursive: true });
    const real = join(linkConfig, "jeito", "real.txt");
    writeFileSync(real, "original\n");
    const link = join(linkConfig, "jeito", "secrets.zsh");
    symlinkSync(real, link);
    const linkSecret = "wont-be-written-zsh";
    const { commands } = setupCommand();
    const { ctx, notifications: linkNotes } = makeCtx({
      selects: ["Exa", (options) => options.find((option) => option.startsWith("Persist ")), "Back", "Exit"],
      confirms: [true, true],
      custom: secretCustom(linkSecret),
    });
    await commands.get("web-setup").handler("", ctx);
    assert.equal(readFileSync(real, "utf8"), "original\n");
    assert.ok(lstatSync(link).isSymbolicLink(), "symlink must remain intact");
    const text = linkNotes.map((n) => n.text).join("\n");
    assert.ok(!text.includes(linkSecret));
    assert.ok(linkNotes.some((n) => n.type === "error" || n.type === "warning"));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("liveness: one direct call, classified failure, missing credential, cancellation, no automatic dispatch", async () => {
  // Probe table: exactly one per provider, search count=1, native fetch, lookups limit=1.
  assert.equal(Object.keys(LIVENESS_PROBES).length, 9);
  for (const [provider, probe] of Object.entries(LIVENESS_PROBES)) {
    assert.ok(["search", "fetch", "lookup"].includes(probe.operation), `${provider} operation`);
    if (probe.operation === "search") assert.equal(probe.intent.count, 1, `${provider} search count`);
    if (probe.operation === "lookup") assert.equal(probe.intent.limit, 1, `${provider} lookup limit`);
  }
  assert.equal(LIVENESS_PROBES.context7.intent.context7.mode, "resolve");
  assert.equal(LIVENESS_PROBES.context7.intent.library, "react");

  const config = structuredClone(DEFAULT_CONFIG);
  config.providers.serper.apiKey = "test-serper-key";
  let fetchCalls = 0;
  const mockFetch = async () => {
    fetchCalls++;
    return new Response(JSON.stringify({ organic: [{ title: "t", link: "https://example.com" }] }));
  };
  const registry = new AdapterRegistry([createSerperAdapter(mockFetch)]);

  // Success: one call, ok:true, no credential or result content in output.
  const success = await runLivenessProbe("serper", registry, config);
  assert.equal(success.ok, true);
  assert.equal(success.operation, "search");
  assert.ok(success.durationMs >= 0);
  assert.equal(fetchCalls, 1);
  const successJson = JSON.stringify(success);
  assert.ok(!successJson.includes("test-serper-key"));
  assert.ok(!successJson.includes("example.com"));

  // Classified failure: 500 → network, one call.
  fetchCalls = 0;
  const failFetch = async () => { fetchCalls++; return new Response("boom", { status: 500 }); };
  const failRegistry = new AdapterRegistry([createSerperAdapter(failFetch)]);
  const failure = await runLivenessProbe("serper", failRegistry, config);
  assert.equal(failure.ok, false);
  assert.equal(failure.failureClass, "network");
  assert.equal(fetchCalls, 1);

  // Missing credential: no network call.
  fetchCalls = 0;
  const noKeyConfig = structuredClone(DEFAULT_CONFIG);
  delete noKeyConfig.providers.serper.apiKey;
  const missing = await runLivenessProbe("serper", new AdapterRegistry([createSerperAdapter(mockFetch)]), noKeyConfig);
  assert.equal(missing.ok, false);
  assert.equal(missing.failureClass, "missing_credential");
  assert.equal(fetchCalls, 0);

  // Cancellation: aborted signal → aborted, zero calls.
  fetchCalls = 0;
  const aborted = await runLivenessProbe("serper", new AdapterRegistry([createSerperAdapter(mockFetch)]), config, AbortSignal.abort());
  assert.equal(aborted.ok, false);
  assert.equal(aborted.failureClass, "aborted");
  assert.equal(fetchCalls, 0);

  // Command-level: liveness requires explicit confirmation; declining makes zero calls.
  const dir = tempAgentDir();
  writeFileSync(join(dir, "web.yaml"), "providers:\n  serper:\n    apiKey: cmd-test-key\n");
  const cmdRegistry = new AdapterRegistry([createSerperAdapter(mockFetch)]);
  fetchCalls = 0;
  const { commands } = setupCommand({}, cmdRegistry);
  const { ctx, notifications } = makeCtx({
    selects: ["Run a liveness check (one provider)", (options) => options.find((o) => o.startsWith("serper")), "Exit"],
    confirms: [false],
  });
  await commands.get("web-setup").handler("", ctx);
  assert.equal(fetchCalls, 0);
  assert.ok(notifications.some((n) => n.text.includes("Cancelled")));

  // Command-level: confirming dispatches exactly one call and reports success without credential/result content.
  fetchCalls = 0;
  const { ctx: okCtx, notifications: okNotes } = makeCtx({
    selects: ["Run a liveness check (one provider)", (options) => options.find((o) => o.startsWith("serper")), "Exit"],
    confirms: [true],
  });
  await commands.get("web-setup").handler("", okCtx);
  assert.equal(fetchCalls, 1);
  assert.ok(okNotes.some((n) => n.text.includes("Liveness: serper") && n.text.includes("ok")));
  const okText = okNotes.map((n) => n.text).join("\n");
  assert.ok(!okText.includes("cmd-test-key"));
  assert.ok(!okText.includes("example.com"));
});
