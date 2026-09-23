---
name: deep-navigation-onboard
description: First-time machine onboarding for jeito-codeweave-pi. Verify the shipped Core payload and QMD models (non-global, publisher-owned) and guide the user through their global navigation.yaml choices—graph LLM provider/model, docs embedding provider/model default, and provider credentials. Reads the current navigation.yaml (which Pi seeds with max-quality defaults on first startup) and adjusts it only with preview, backup, and confirmation; then hands off to navigation-setup for per-project readiness. For per-project prepare/repair use navigation-setup; for diagnosis use navigation-debug.
disable-model-invocation: true
---

# Deep Navigation Onboard

Use this skill once per machine to establish the user's jeito-codeweave-pi preferences. It is the guided front door: it verifies the shipped Core payload and QMD models, and walks the user through the global configuration choices that are theirs to make—graph LLM provider/model, docs embedding provider/model default, and credentials. It writes only the global `~/.pi/agent/navigation.yaml`, and only with the user's confirmation.

This is a post-install skill. From a cloned jeito checkout, the bootstrap entry point is `npm run install:codeweave-pi`; it performs the codeweave-pi-only npm install, runtime verification, and Pi registration before this skill can be loaded. Never tell an uninstalled user to begin with this skill or with `pi install ./extensions/codeweave-pi` alone.

Scope boundaries, so this skill never duplicates another owner:

- Per-project readiness, repair, and the per-project QMD semantic choice belong to `navigation-setup`.
- Diagnosing a failure belongs to `navigation-debug`.
- Applying the global harness defaults (`APPEND_SYSTEM.md`, `tool.yaml`) belongs to the separate `/skill:jeito-setup` flow, not this skill.
- The detailed operator contract is `docs/setup.md`.

## Non-negotiable boundaries

- Onboarding is guidance plus one confirmed config write, never silent auto-configuration. Every cloud provider/model/credential choice is the user's: recommend from the registry catalog, accept any custom model string, and confirm before writing. The package-owned local QMD model pair is installation state, not a provider-consent question.
- Pi seeds a max-quality `navigation.yaml` on first startup, so the file usually already exists with defaults the user has not explicitly chosen. Read it, show those choices, and let the user keep or change them. Never overwrite without showing the change and receiving explicit confirmation; existing private provider configuration is authoritative.
- Tool installation is local, non-global, and publisher-owned: the Core maintenance runtime, pinned code model, grammars, the owned QMD fork, `node-llama-cpp`, and the required embedding/reranker are package or cache state, not something this skill installs. `npm run nav:provision` only verifies the shipped Core payload and then provisions/verifies the QMD models; a missing Core payload requires a complete prepared package and cannot be manufactured here. The optional Graphify runtime is the only Python piece and is a separate stopped-Pi step (`npm run nav:provision:legacy`, which writes `.runtime/.ready`). Never install a backend globally, add a PATH fallback, or install one Python backend separately.
- No Python install or repair while Pi runs. The optional Graphify runtime is provisioned only with Pi stopped, then Pi restarts; Core and QMD verification need no Python.
- Credentials stay host-owned and the skill never prints, echoes, or otherwise handles a raw API key value. Two supported routes, both delivered to the backends the same way: (a) recommended — the user exports the provider's env var in their own terminal; (b) the user fills the `# api_key:` placeholder under the provider block in their own 0600 `navigation.yaml` (an openai-compatible endpoint takes `base_url` + `api_key` + optional `model`). The skill writes only config structure with commented placeholders. Confirm presence, never value.
- Local QMD semantic inference is installed and is the keyless default. Provider onboarding may optionally configure ZeroEntropy or Voyage; per-project `navigation-setup` may persist a cloud or lexical override without reacquiring local models.
- Query-time navigation tools must never build, index, install, embed, call providers, or download models. Onboarding is a setup-time operation.

## Workflow

### 1. Detect machine state

Without mutating, report:

- Is `~/.pi/agent/navigation.yaml` present, and what providers/models does it currently select? (Absent ⇒ Pi has not seeded it yet; present ⇒ show the current choices.)
- Is the shipped Core payload present and are the QMD models verified? (`npm run pi-nav-build.mjs check-core --json` and `npm run qmd:model-provision -- --verify-only`.) Is the optional Graphify runtime ready? (`extensions/codeweave-pi/.runtime/.ready` exists.)
- Which provider env vars are already present? (Presence only, never values.)

State the detected state before proposing anything. This skill runs whether or not the file exists; it adjusts, never clobbers.

### 2. Verify the shipped Core payload and QMD models (plus the optional Graphify runtime)

The shipped Core payload and QMD models must be present before provider work. Core assets are publisher-prepared and self-contained: they are verified here, never installed, downloaded, compiled or repaired. Stop Pi before any provisioning step, then from the extension root run:

```bash
npm run nav:provision
```

This verifies the complete Core payload (maintenance runtime, grammars, pinned code model) and then provisions or verifies the required QMD embedding/reranker, reusing a valid cache. If Core verification fails, the user needs the complete prepared package — this command cannot manufacture missing assets. `npm run qmd:model-provision -- --verify-only` is the read-only check for the QMD pair and may be run at any time. Do not continue until both pass. Optional Graphify cross-domain maps are never required here: with Pi stopped, `npm run nav:provision:legacy` prepares the Graphify-only `.runtime` venv and writes `.runtime/.ready`. See `docs/setup.md` for prerequisites and recovery.

### 3. Guide the global provider/model choices

The source of truth for providers and their known models is `extensions/codeweave-pi/src/core/provider-registry.ts` (`PROVIDER_REGISTRY`): each record has `id`, `capabilities`, `locality`, `contentLeavesMachine`, `requiredEnv`, and an advisory `models` list whose first entry is the recommended default. Read it; do not recall model names from memory.

Guide, then let the user choose:

- **Graph LLM provider + model** (drives the Graphify lane). Recommend from catalogs—e.g. `openai → gpt-5.6-sol`, `google → gemini-3.6-flash`, `deepseek → deepseek-v4`, `kimi → kimi-k3`, `minimax → MiniMax-M3`. Any custom model string for the chosen provider is valid; the catalog is advisory, never a gate. The model reaches Graphify via `--model`, the single authoritative source.
- **Embedding provider + model default** (drives the docs-lane default). Recommend from catalogs—e.g. `openai → text-embedding-3-small`, `voyage → voyage-4-large` (general docs+code retrieval), `google → gemini-embedding-001`. State locality and whether content leaves the machine. The per-project QMD semantic choice (local models / ZeroEntropy / Voyage / lexical) is made later in `navigation-setup`, not here.

For each chosen provider, state its `requiredEnv` credential and its locality/privacy (cloud vs local; content-leaves-machine).

### 4. Guide credential setup

For each chosen provider, get its credential into the environment the backends read. Recommend route (a); offer route (b) when the user prefers a fixed per-machine config or is wiring an openai-compatible endpoint. Either way the skill never prints, echoes, or handles the raw value — confirm presence, never value.

**(a) Environment variable — recommended.** Most portable; keeps the key out of any config file. For each chosen provider give the exact env var (from `requiredEnv`) and the persist command for the user's shell:

```bash
# bash
echo 'export MINIMAX_API_KEY=<your-key>' >> ~/.bashrc
# zsh
echo 'export MINIMAX_API_KEY=<your-key>' >> ~/.zshrc
# fish
set -Ux MINIMAX_API_KEY <your-key>
```

**(b) API key in `navigation.yaml` — alternative.** The config loader maps `providers.<name>.api_key` to the same env the backends read, so a key may live in the user's 0600 `navigation.yaml` instead of the shell. Any supported provider accepts `api_key` under its block; an openai-compatible endpoint takes `base_url` + `api_key` (+ optional `model`):

```yaml
providers:
  deepseek:
    api_key: <your-key>            # user fills in their own 0600 file
  openai-compatible:
    base_url: https://your-endpoint/v1
    api_key: <your-key>
    model: your-model
```

When writing `navigation.yaml` in step 5, write commented `# api_key:` placeholders (as the seed does) and let the user fill them in; never write a raw key. Trade-off: env keeps the key off disk in config; the config route is convenient for a fixed machine but the key lives in the 0600 file.

After either route, confirm the variable is present (not its value) in the environment Pi will inherit.

### 5. Write navigation.yaml — preview, back up, confirm, report

- Show the full proposed `~/.pi/agent/navigation.yaml`: `profile`, provider `defaults` (llm/embedding), `providers.allowed` (must include every chosen provider), and `backends` choices. The skill writes no raw secret: provider keys are left as commented `# api_key:` placeholders for the user to fill in (route b) or come from env vars (route a).
- If a file exists, back it up to `navigation.yaml.bak.<timestamp>` first.
- Write only after explicit confirmation. File mode 0600.
- This mirrors the `/skill:jeito-setup` discipline (preview, exact backup, confirm, report) applied to the extension-owned navigation config.

### 6. Verify

Read-only checks from the extension root:

```bash
npm run nav:doctor -- --json
```

Confirm the reported lane readiness (QMD docs, plus Graphify when chosen) and that each chosen provider resolves to policy `allowed` (via the registry's `decideProviderPolicy`): it is in `providers.allowed`, the relevant `allow*` gate is on, and its `requiredEnv` is present. Core payload verification belongs to step 2, not to doctor.

### 7. Hand off

Onboarding is global and once-per-machine. For each project the user wants prepared—and for the per-project QMD semantic choice—use `navigation-setup`. Use `navigation-debug` to diagnose a failure.

## Completion report

```text
Core payload verified (package version) and QMD models verified, or the exact blocker:
optional Graphify runtime ready or absent (never required):
current navigation.yaml state (seeded defaults vs user choices):
global providers + models chosen (graph LLM / embedding):
credentials confirmed present (names only, never values):
navigation.yaml written (path + backup) or left untouched:
doctor result and per-provider policy:
handoff noted (navigation-setup per project / navigation-debug on failure):
remaining limitation:
```
