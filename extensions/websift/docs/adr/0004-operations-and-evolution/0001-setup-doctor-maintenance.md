---
title: "ADR 4.1 — Setup, doctor, and maintenance ownership"
description: "Records /web-setup masked inline and shell credential persistence, presence-only diagnosis, explicit liveness and usage checks, official account links, the guided websift-setup skill, read-only web-doctor, and maintenance ownership."
tags: [jeito-websift, adr, setup, doctor, maintenance, skills]
created: 2026-07-28
updated: "2026-09-23 11Z"
status: active
adr_id: ADR-004.001
adr_type: child
decision_status: accepted
confidence: confirmed
evidence_grade: verified
implementation_status: validated
decision_owner: alehdezp
owns: "websift-setup, web-doctor, and websift-maintain contracts"
audience: mixed
parent: docs/adr/0004-operations-and-evolution/README.md
code: [src/provider-control.ts::registerWebSetup, src/provider-control.ts::scanShellEnvPresence, src/provider-control.ts::runLivenessProbe, skills/websift-setup/SKILL.md, skills/websift-maintain/SKILL.md, src/doctor.ts::buildDoctorReport]
related: [docs/adr/0002-internal-architecture/0004-config-and-credentials.md, docs/adr/0004-operations-and-evolution/0002-provenance-and-upkeep.md]
---

# ADR 4.1 — Setup, doctor, and maintenance ownership


## ADR parent and current state

This micro-decision inherits its objective and settled constraints from [ADR-004 — the folder master ADR](README.md). It does not inherit confidence or evidence from sibling ADRs.

`alehdezp` owns the decision. Current metadata: `decision_status: accepted`, `confidence: confirmed`, `evidence_grade: verified`, and `implementation_status: validated`. The metadata—not optimistic prose—governs whether dependent work may treat the decision as proved.

Two manually invoked skills (`disable-model-invocation: true`) and two commands follow the jeito setup contract: preview before mutating, confirm, never expose secret values, and remain idempotent. `/web-setup` is the only extension surface that may receive a key through masked local input. It may write exactly one inline `web.yaml` key or one exported assignment in its command-owned shell secret file. `jeito-setup` hands provider and credential choices to these extension-owned surfaces.

## `/web-setup` (user-invoked local command)

The user-invoked `/web-setup` command (`src/provider-control.ts::registerWebSetup`) is the local control center for credential presence, official account/API-key/billing/docs links, masked persistence, shell diagnosis, explicit liveness, and grounded usage visibility. It is not a model tool; the model cannot invoke it.

**Secret boundary — the only exception.** A value may enter only through the command's masked TUI, where the user types or pastes it directly. The masked entry composes pi-tui `Input`, renders bullets instead of content, rejects pasted line breaks, and never returns the value to the model, guided skill, conversation/editor, session entries, logs, notifications, errors, snapshots, or tests. Previews use `[redacted]`. Environment inheritance remains the recommended runtime boundary; inline `web.yaml` and command-owned shell files are explicit plaintext conveniences.

**Inline write contract.** Writing `providers.<id>.apiKey` to `web.yaml`
requires, in order: a pre-input recommendation to use an environment variable,
the plaintext-risk warning, the exact `web.yaml` path, and the
inline-over-environment precedence note; an explicit replacement confirmation
when a key already exists; the masked entry; rejection of blank or line-break
input; the fixed redacted preview; a final plaintext-storage confirmation; and
an atomic update that mutates exactly `providers.<id>.apiKey`, refuses a
malformed/symlink/non-regular target, creates its temp exclusively at mode
`0600` (a missing parent at `0700`), and writes no backup. An inline change
reloads immediately on `web.yaml` mtime; only environment-variable changes need
a Pi restart. A write failure reports a generic secret-free message; a
post-rename permission failure warns that the target may have changed and its
mode needs inspection rather than claiming nothing was written.

**Shell diagnosis and persistence.** When Pi lacks a recognized variable, the command may inspect a bounded Fish/Zsh/Bash startup-file set locally for exported assignment names. It reports only names and source paths; it never returns values, sources/evaluates content, or imports assignments into the running process. Masked persistence writes one assignment to a command-owned `0600` secret file, creates new private directories at `0700`, refuses symlink/non-regular targets, writes no secret backup, and preserves existing rc-file permissions. Fish uses `conf.d`; Zsh/Bash receive one shell-quoted guarded loader. A loader failure after the secret file lands is reported as partial success with manual recovery.

**Local status, no network on open.** Opening `/web-setup` performs no network calls and reports local credential status. Its explicit shell diagnostic reports assignment-name presence separately—inline, inherited environment, assignment found but not inherited, required missing, optional anonymous, and local/no-account remain distinguishable states. Missing providers remain healthy and independent. Provider pages are official navigation destinations, never API-health proof; SkillsMP exposes no account/billing surface, so none is guessed.

**Explicit one-provider liveness.** After showing provider, representative operation, one-dispatch ceiling, and cost/egress warning, `/web-setup` may call one selected adapter directly. There is no routing, fallback, retry, persistence, content display, or sibling call. Output is limited to provider, operation, success/failure class, and elapsed time. This checks current credential/transport/response compatibility for one operation; it does not measure provider quality or prove every operation.

**Explicit native usage — Tavily + Linkup only.** The optional "Check usage"
action is explicit, never automatic, and never persisted. A provider-scoped
check calls exactly one account endpoint; the top-level refresh runs the
grounded Linkup `linkupGetBalance` reuse and Tavily's official `GET /usage`
concurrently, and one provider's failure or absence never suppresses the other.
Usage is limited to these two because no other provider has a compatible
grounded balance endpoint: Exa needs key-ID/team semantics, xAI a separate
management key, SkillsMP exposes only operation rate headers, Serper and
Context7 have no compatible grounded balance endpoint, and the local providers
have no account. `/web-doctor` remains read-only and network-free and never
spends credits; `/skill:websift-setup` is the guided/headless fallback.

## `/skill:websift-setup` (guided / headless fallback)

The skill is model-visible guidance but secret-blind. It may inspect `web.yaml` policy and current-process variable-name presence, interpret `/web-setup` presence-only reports, explain provider contract capabilities and account links, and preview non-secret policy. It never opens raw private shell files with model tools, handles a value, writes a secret, runs an unapproved network check, or converts credential presence into a provider recommendation.

1. **Review:** report config parse/permission state, current policy, credential names present/missing, operation coverage, shell assignment status supplied by the command, and restart needs.
2. **Guide:** direct interactive users to `/web-setup` for masked inline or shell persistence. In headless/RPC mode, show exact local structure but let the user enter values outside conversation.
3. **Configure:** preview/confirm only non-secret `web.yaml` policy changes. Do not create a file merely because defaults are active.
4. **Separate proof classes:** local readiness, one-provider live compatibility, Tavily/Linkup usage visibility, and accepted comparative quality are distinct. Provider quality remains owned by focused comparative evidence plus interactive owner acceptance.

Idempotent throughout; safe to re-run; never overwrites or exposes unrelated secrets.

## `/web-doctor` (read-only)

A local, non-networked capability and credential-presence report: enabled providers, inherited or inline credential presence, operation coverage, config health, inline-key permissions, and restart requirements. Shell-file inspection, masked persistence, live provider calls, usage, and browser navigation remain in `/web-setup`; `/web-doctor` never spends credits.

## `/skill:websift-maintain` (debug / update / issues)

The skill responsible when something breaks — a closed loop with loud failures
([`0004`](../0002-internal-architecture/0002-routing-and-failover.md)) and provenance docs
([`0009`](0002-provenance-and-upkeep.md)):

**On a failure or misbehavior:**
1. Read the loud `failureClass` from the failing result's `attempts[]`.
2. Open the provider's [`../upstreams/<provider>.md`](../../upstreams/README.md).
3. Compare our adapter against the installed upstream source
   (`~/.pi/agent/npm/node_modules/<package>`) or its repo.
4. Diagnose; guide a **targeted re-port of only the affected module**.
5. Run the owning test.
6. Update the provenance doc (last-reviewed, divergence) and the governing ADR
   ([`0007`](../0003-engineering-stewardship/0001-documentation-and-code-links.md) update discipline).

**Periodic check (the lightweight model):**
- Walk `docs/upstreams/`; for each source, check the current version
  (`npm view <package> version` / repo ref).
- Report changed/added/removed among the *mapped* files only, and point each to
  the affected local adapter/test.
- Recommend port-or-skip. **Never auto-merge**; always preview + confirm; never
  touch secrets. Version drift is a prompt to look, not proof to import.

## What would change these skills

- If a provider's drift becomes frequent and painful, the periodic check may grow
  a mapped-path diff (still human-reviewed); it never becomes auto-merge.
- If repeated use shows one-provider liveness is too costly or coarse, revise its probe per provider while preserving explicit confirmation and one-dispatch accounting.

## Alternatives and decisive trade-off

Automatic startup installation or repair would mutate package and credential state invisibly. One setup skill alone would mix guided mutation with diagnosis. Separate interactive setup, read-only doctor, and focused maintenance surfaces keep normal startup pure and recovery explicit.

## Evidence and verification

`src/provider-control.ts::registerWebSetup`, `scanShellEnvPresence`, `updateSecretFile`, and `runLivenessProbe`; `skills/websift-setup/SKILL.md`; `src/doctor.ts::buildDoctorReport`; and `tests/provider-control.test.mjs` own masked input, selective writes, shell assignment projection, permission/symlink/partial-state safety, one-dispatch liveness, official navigation, and usage orchestration. The shared no-secret gate covers adapter output. No live provider call is implied by mocked conformance proof.

## History

- 2026-07-31: owner expanded `/web-setup` to bounded presence-only Fish/Zsh/Bash diagnosis, masked command-owned shell persistence, and explicit one-provider liveness. Setup reports readiness/compatibility/usage, while comparative quality remains apprenticeship-owned.
- 2026-07-30: added the user-invoked `/web-setup` command as the single local
  masked-key write surface and the explicit Tavily `/usage` + Linkup balance
  usage check (Phase 5F, Tavily+Linkup only); `/skill:websift-setup` becomes the
  guided/headless fallback; this ADR is the decision authority for the
  reconciled secret boundary.
- 2026-07-27: three skills settled; `websift-maintain` defined as the debug/update
  owner; periodic check chosen over tarball-diffing automation.
