---
name: websift-setup
description: "Review and configure jeito websift with minimal user work. Inventory web.yaml, presence-only credential and shell-assignment status, operation coverage, provider account links, usage visibility, and restart needs. Guide the local /web-setup command for masked inline or Fish/Zsh/Bash persistence and explicit liveness checks; never receive a secret value in model context. Comparative provider quality remains apprenticeship-owned."
disable-model-invocation: true
updated: "2026-09-22 13Z"
---

# jeito websift review and setup

With no arguments, perform a bounded read-only review before asking questions or proposing a write. Work whether websift extension code is loaded or disabled; return missing package/registration/runtime ownership to `/skill:jeito-setup`. Secret-bearing writes and network checks belong to the local `/web-setup` command, not this skill.

Implementation authority: [`src/config.ts::DEFAULT_CONFIG`](../../src/config.ts), [`config and credentials`](../../docs/adr/0002-internal-architecture/0004-config-and-credentials.md), and [`setup/doctor ownership`](../../docs/adr/0004-operations-and-evolution/0001-setup-doctor-maintenance.md).

## Safety

- Never ask for, read, print, copy, or write a secret value. Never open raw private shell files or `auth.json` with model-visible tools.
- Preview and separately approve non-secret policy changes. Missing optional credentials are healthy.
- No network call during review. A `/web-setup` liveness check may consume credits and requires explicit provider/operation/egress approval.
- `/web-setup` writes no secret backup. Inline keys and command-owned shell secret files use mode `0600`; new private directories use `0700`.
- Credential presence proves availability only—not provider quality, correctness, or comparative value.

## Zero-argument review

Build a bounded, non-secret websift capability review:
When `/skill:jeito-setup` supplies a `schemaVersion: 1` machine snapshot containing all recognized websift credential, config, and shell checks, reuse it; do not repeat shell commands or filesystem discovery. The snapshot proves only bounded machine facts. Installed `loadConfig`/`DEFAULT_CONFIG` still own parse fallback and effective routing, and `PROVIDER_PAGES` still owns official URLs.

1. inspect `web.yaml` presence/parse state and read installed `DEFAULT_CONFIG` plus `DEFAULT_ENV`;
2. check every recognized websift credential name and configured custom name by presence only;
3. obtain current shell and bounded assignment-name/loader status from `/web-setup` without reading values or private-file content;
4. **check the webclaw binary** (the local extraction engine): run `webclaw --version` (or read `/web-doctor`'s report). Missing binary = a fetch-lane blocker with a clear fix; offer installation with confirmation — macOS: `brew install 0xmassi/webclaw/webclaw`; Linux/Windows: the GitHub-release/cargo path in the project README (`https://github.com/0xMassi/webclaw#install`). A version outside `0.6.16 <= v < 0.7.0` is likewise a fetch-lane blocker (`/web-doctor` warns `webclaw_version_mismatch`): offer `brew upgrade 0xmassi/webclaw/webclaw` (macOS) or a build from `https://github.com/0xMassi/webclaw/releases`. Never install silently at runtime; the tool itself returns the same exact command in its error message;
5. map enabled providers to search, fetch, answer, social, and lookup operations, effective priority/fallback, limits, account links, and available usage checks;
6. distinguish local readiness from live API compatibility and measured comparative quality.
An absent `web.yaml` means the installed package’s defaults are the active policy. Explain that behavior rather than calling websift simply “ready”: which adapters are enabled (webclaw + tavily own fetch under the defaults), which operation uses each priority chain, which present credentials make an adapter locally available, and which calls remain untested.

For an unfamiliar or infrequent user, explain: **“websift is jeito’s online-research system. It routes search, page reading, sourced answers, social discussion, and library lookup to different providers because no single service owns every kind of evidence.”** Then report:

- **Current behavior:** effective operation routes, present/absent credential names, anonymous/local fallbacks, retry/compare defaults, and whether shell persistence appears configured.
- **Why no change may be recommended:** built-in defaults provide broad coverage and package updates maintain them without another policy file.
- **What keeping defaults costs:** provider ordering is generic rather than user-optimized; remote services receive queries/content; free plans, quotas, and rate limits vary; default routing may evolve with package upgrades; presence has not proven live access.
- **When explicit `web.yaml` helps:** provider enable/disable, preferred order, budget/fan-out, locale, privacy, limits, custom credential names, or stable overrides.
- **Official actions:** account/key, billing/usage, and documentation links from `PROVIDER_PAGES` for the recommended or missing high-value adapters. Never invent balances or URLs.

Recommend no websift policy change only after explaining why current defaults fit, comparing the strongest operation-specific routing available from every observed credential against installed defaults. An unfamiliar user is ambitious by default: expose capable adapters, priority improvements, privacy/cost/locale controls, and unverified health rather than hiding them behind “defaults are good.” Keep defaults when they remain the strongest coherent general-research policy, and say why; customize only for a concrete gain. Offer one-provider liveness checks with explicit operation, egress, possible cost, and one-attempt bound before claiming that an API works.

## Shell credential assistance

`/web-setup` infers the current supported shell from `$SHELL` and owns local secret handling:

| Shell | Command-owned private file | Loader behavior |
|---|---|---|
| fish | `${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/90-jeito-secrets.fish` | Fish `conf.d` auto-loads. |
| zsh | `${XDG_CONFIG_HOME:-$HOME/.config}/jeito/secrets.zsh` | One guarded, idempotent source line in `~/.zshrc`. |
| bash | `${XDG_CONFIG_HOME:-$HOME/.config}/jeito/secrets.bash` | One guarded, idempotent source line in `~/.bashrc`. |

The command may scan a bounded startup-file set for recognized assignment **names** and paths; it never sources files, evaluates assignments, imports discovered values, or returns values. Masked persistence stores plaintext locally after warning and confirmation, rejects unsafe targets, writes no secret backup, preserves an existing rc file's mode, and reports partial state honestly if the key file lands but the loader cannot.

This skill interprets the presence-only report and tells the user to restart Pi from the configured shell. In headless/RPC mode, provide exact manual structure but let the user enter values locally; never receive them in conversation.

Interactive users may alternatively use `/web-setup` masked inline `web.yaml` entry. Inline values take precedence over environment variables and reload on file modification; environment changes require restart.

## Configure non-secret `web.yaml` policy

Do not create a file merely because it is absent. Propose only provider enablement, custom environment-variable names, priorities, defaults, or limits that differ from installed defaults. Preview the complete non-secret semantic change and obtain confirmation. Never place a key value in the preview or write one from the skill.

```yaml
providers:
  serper: { enabled: true }
  exa: { enabled: true, env: EXA_API_KEY }
priority:
  search: [serper, exa, tavily, linkup]
  fetch: [native, tavily]
  fetch: [webclaw, tavily]
defaults: { depth: standard, strategy: single, maxAttempts: 2 }
limits: { timeoutMs: 20000, concurrency: 3, inlineChars: 12000, siteMapCap: 25 }
```

This is schema shape, not a universal recommendation. `/web-setup` inline mutation changes exactly `providers.<id>.apiKey` and creates no backup.

## Diagnose and verify distinct states

- **Local readiness:** config parses, permissions are safe, a required credential is present, and an operation has an available adapter. No network proof.
- **Live API compatibility:** one explicitly confirmed direct provider probe, maximum one adapter dispatch, no fallback/retry/sibling call, reporting only provider/operation/status/failure class/latency. May consume credits.
- **Usage or balance:** grounded native account checks exist only for Tavily and Linkup; other providers use official account/billing links without fabricated balances.
- **Comparative quality:** not setup. Use accepted focused evidence and interactive owner selection.

`/web-doctor` remains local and network-free. `/web-setup` opens official account/API-key/billing/docs pages and owns the explicit actions above.

The normal response begins with the plain-language websift explanation, then current behavior, benefits, limits, and recommendation. It never begins with package receipts, paths, or internal routing narration, but it does name provider/credential status and effective priorities when those facts explain what works and why.

If the user chooses a change, preview it, obtain approval, apply it through `/web-setup`, verify locally, and request live checks only with explicit egress/cost approval. If no change is recommended, leave the user with official provider controls and the exact conditions that should trigger configuration later.
