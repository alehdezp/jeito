---
title: "ADR 2.4 — Configuration and credential resolution"
description: "Records web.yaml ownership, credential precedence, host-owned local-network exceptions, masked persistence, permission handling, reload behavior, and secret-safe output."
tags: [jeito-websift, adr, configuration, credentials, yaml, secrets, network-policy]
created: 2026-07-28
updated: 2026-08-11
status: active
adr_id: ADR-002.004
adr_type: child
decision_status: accepted
confidence: confirmed
evidence_grade: verified
implementation_status: validated
decision_owner: alehdezp
owns: "Configuration format, credential precedence, host-owned local-network policy, and secret-safe behavior"
audience: mixed
parent: docs/adr/0002-internal-architecture/README.md
code: [src/config.ts::loadConfig, src/config.ts::credentialStatus, src/config.ts::resolveCredential, src/destination-policy.ts::assertAllowedDestination, src/provider-control.ts::writeConfigAtomic, src/provider-control.ts::scanShellEnvPresence, src/provider-control.ts::updateSecretFile]
related: [docs/adr/0004-operations-and-evolution/0001-setup-doctor-maintenance.md, docs/README.md]
---

# ADR 2.4 — Configuration and credential resolution


## ADR parent and current state

This micro-decision inherits its objective and settled constraints from [ADR-002 — the folder master ADR](README.md). It does not inherit confidence or evidence from sibling ADRs.

`alehdezp` owns the decision. Current metadata: `decision_status: accepted`, `confidence: confirmed`, `evidence_grade: verified`, and `implementation_status: validated`. The metadata—not optimistic prose—governs whether dependent work may treat the decision as proved.

## Decision

Secrets resolve from **environment variables** by default, with an **optional plaintext inline `apiKey`** in `web.yaml`. The user-invoked `/web-setup` command may also persist a masked value to one command-owned Fish/Zsh/Bash secret file and install one guarded loader line for Zsh/Bash. Non-secret policy and optional inline credentials share one **YAML** file (not JSON).

The command may inspect a bounded set of shell startup files locally for recognized environment-variable assignment names when Pi did not inherit them. It reports only variable names and source paths; it never returns values, sources/evaluates files, executes shell content, or imports discovered assignments into `process.env`.

> Owner decision, on record: inline keys and command-owned shell secret files store plaintext on the single-user machine. Environment inheritance is the preferred runtime boundary; both persistence options exist for convenience. Secret values never enter model-visible output.

**Secret-value writers.** Apart from the user's own editor, only the user-invoked `/web-setup` masked TUI may receive and write a value. It may mutate exactly `providers.<id>.apiKey` in `web.yaml` or exactly one recognized exported assignment in the command-owned shell secret file. Agents, the model, `/skill:websift-setup`, conversation, logs, errors, snapshots, and tests never receive the value.

## Format and location

- **Format:** YAML, parsed with the `yaml` dependency. Chosen because the owner
  requires non-JSON and YAML matches the host convention (`tool.yaml`,
  codeweave-pi's `navigation.yaml`).
- **Location:** `getAgentDir()` resolution, grounded in pi-web-access's proven
  `utils.ts`: `PI_CODING_AGENT_DIR` → `$XDG_CONFIG_HOME/pi` → `~/.pi`. File name
  `web.yaml`. Never hardcode `$HOME`.
- **Seeding:** `/skill:websift-setup` may preview and apply non-secret structure only after confirmation; it never writes a key value. `/web-setup` does not replace policy wholesale: masked inline entry atomically mutates exactly `providers.<id>.apiKey`, while masked shell persistence mutates exactly one recognized environment assignment in its dedicated private file.

## Schema

```yaml
providers:
  serper: { enabled: true }                      # env defaults to SERPER_API_KEY
  exa:    { enabled: true, env: EXA_API_KEY }    # explicit env name
  tavily: { enabled: true, apiKey: "tvly-..." }  # OPTIONAL inline key (plaintext)
  linkup: { enabled: true, env: MY_LINKUP_KEY }  # custom env name
priority:                                        # starting policy, unmeasured (ADR-005.001)
  search: [serper, exa, tavily, linkup]
  fetch:  [native, tavily]
  answer: [exa, linkup]
defaults:
  depth: standard
  strategy: single
  extract: readable
  maxAttempts: 2
limits:
  timeoutMs: 20000
  concurrency: 3
  inlineChars: 12000
  siteMapCap: 25
network:
  allowPrivateHosts: []                         # exact hosts only; no wildcards or tool-call bypass
```

`network.allowPrivateHosts` is the only private-network escape. It is host-owned and exact-host only; it permits loopback, RFC1918, or IPv6 ULA destinations for deliberate development. Link-local, reserved, and cloud-metadata destinations remain blocked even when listed. The tool schema exposes no equivalent field.

## Credential resolution (`src/config.ts::resolveCredential`)

For a provider, resolve in this order and stop at the first hit:

1. **Inline `apiKey`** in config, if present and non-empty.
2. **`process.env[env]`** where `env` is the configured `env` name, or the
   default name for that provider (`EXA_API_KEY`, `TAVILY_API_KEY`,
   `LINKUP_API_KEY`, `SERPER_API_KEY`, `SKILLSMP_API_KEY`, `XAI_API_KEY`,
   `CONTEXT7_API_KEY`).
3. Otherwise the provider is **disabled** for this session (no key).

A resolved key is held in memory only; it is never written to output, logs,
errors, or snapshots. `web_lookup` sources that work anonymously (Context7,
pi-package-search) need no key.

## Safe inline writes (`/web-setup`, `src/provider-control.ts`)

Inline precedence means an inline `apiKey` wins over any environment variable;
`/web-setup` warns of this before writing. The command mutates **exactly**
`providers.<id>.apiKey` through a `parseDocument` round-trip that preserves
comments and unrelated fields and **refuses malformed YAML**. A focused reader
treats a missing file (ENOENT) as an empty seed and rethrows every other read
failure, so permission or I/O errors cannot overwrite existing config. The
atomic write refuses a target that is a symlink or not a regular file, creates
a missing parent at mode `0700`, creates its temp **exclusively** in the same
directory at mode `0600`, renames it into place, and re-asserts `0600`; **no
secret backup is ever created**. Inline changes reload immediately when
`web.yaml`'s mtime changes (the `loadConfig` cache); **environment-variable
changes require a Pi restart** because a running process cannot inherit another
shell's new variables.

## Shell assignment detection and persistence

`process.env` remains shell-agnostic once Pi inherits it. When a recognized variable is missing from the running process, `/web-setup` may scan only documented Fish/Zsh/Bash startup/private paths for an exported assignment. The scanner reads bytes locally but projects only variable-name presence and the containing path; Fish `set -q` queries and comments are not assignments.

Masked shell persistence writes plaintext to one command-owned file: Fish `conf.d/90-jeito-secrets.fish`, or `${XDG_CONFIG_HOME:-$HOME/.config}/jeito/secrets.{zsh,bash}`. New secret files are `0600`; new private directories are `0700`; symlink/non-regular targets are refused; values with CR/LF/NUL are rejected; no secret backup is created. Zsh/Bash receive one shell-quoted, guarded, idempotent loader line in their conventional rc file. Existing rc permissions are preserved. If the secret file lands but loader mutation fails, the command reports that partial state and gives the exact non-secret loader recovery—it never claims nothing changed.

The command never sources or evaluates shell files and cannot retrofit the running Pi process. Environment changes require a shell/Pi restart. `/skill:websift-setup` explains these results but never opens private shell files with model-visible tools or handles the value.

## Missing optional credentials

Missing optional providers produce **no startup warnings**. Availability is
reported only by `/web-setup`, `/skill:websift-setup`, and `/web-doctor` (presence,
never values). We also drop pi-tavily's `session_start` key warning for this
reason.

## Why this design

- Env vars are the existing portable boundary; every incumbent uses them.
- Inline `apiKey` covers users who want config-only setup (owner request).
- Custom `env` names cover non-standard variable names without storing values.
- YAML + host-convention location keeps config discoverable and consistent.

## What would change this

- If plaintext inline keys prove risky in practice, demote to env-only: remove
  the inline-first branch from `resolveCredential` and the `/web-setup` key
  write/remove actions (status, pages, and usage checks remain).
- A config schema field is added only when a reproduced need proves it.

## Alternatives and decisive trade-off

Environment-only credentials are safer but reject the owner-approved single-user convenience case. Building a secret manager exceeds this extension. One YAML policy file in which environment variables are the recommended default user practice but an explicitly configured inline key has resolution precedence, with mode hardening and no-secret output, accepts the explicit local-machine trade-off.

## Evidence and verification

`src/config.ts::loadConfig`, `credentialStatus`, and `resolveCredential`; `src/provider-control.ts::readConfigRaw`, `writeConfigAtomic`, `scanShellEnvPresence`, `quoteForShell`, and `updateSecretFile`; plus `tests/provider-control.test.mjs` and the shared no-secret gate validate precedence, bounded name-only projection, safe quoting, selective updates, mode handling, symlink refusal, honest partial-state reporting, and no-secret output. The plaintext options are owner-confirmed local-machine trade-offs, not claims that plaintext is generally safer.

## History

- 2026-07-31: superseded the blanket rejection of shell-file inspection. The owner approved bounded local assignment-name detection and command-owned private shell persistence through `/web-setup`; values remain confined to masked input and local files, and discovered assignments are never sourced, evaluated, returned, or imported.
- 2026-07-30: recorded the safe local inline-write exception — `/web-setup` mutates exactly `providers.<id>.apiKey` atomically at mode `0600`, refuses malformed/symlink/non-regular targets, writes no backup, and reloads on mtime while environment changes need a restart.
- 2026-07-27: settled YAML (non-JSON), environment-first resolution, optional plaintext inline `apiKey`, and custom environment names. The original blanket no-shell-scrape rule is preserved here as superseded by the narrower 2026-07-31 command-only boundary.
