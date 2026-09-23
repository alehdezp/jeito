---
title: "jeito monorepo contributor instructions"
description: "Package, installation, documentation, runtime, tool-routing, UI, verification, and dependency boundaries for jeito contributors."
tags: [jeito, monorepo, contributor-guide, package-ownership]
created: 2026-07-25
updated: "2026-09-23 12Z"
status: active
owns: "Repository-wide contributor invariants and owner routing"
audience: contributor
related: [CONTRIBUTING.md, docs/README.md]
---

# jeito contributor instructions

[`CONTRIBUTING.md`](CONTRIBUTING.md) is the public workflow. This file carries the invariants that are easy to break while changing several extensions. A nested `AGENTS.md` may narrow these rules for its package but cannot weaken them.

## Package and installation ownership

- The root `package.json` is the full-harness aggregate. First-party extensions live under `extensions/<behavior>/` with their own workspace packages. All but suite-only guidepin have standalone Pi resources and an installation path from a cloned checkout.
- The aggregate owns Shell, tooltap, draft-lift, guidepin, websift, codeweave-pi, Stall Guard, and FFF Search; it requires Pi `>=0.87.1`. Context Diagnostics remains a standalone development package. Guidepin's reminder hook and goal-management skill are suite-only resources.
- npm prepares dependencies and extension-owned runtimes; Pi registers them. A failed npm step must not be followed by `pi install`.
- Pi Git sources cannot target a monorepo subdirectory. Standalone remote delivery needs a separate repository; local-path installation uses the prepared extension checkout.
- Never register the aggregate and one of its contained extensions together unless the aggregate explicitly excludes the duplicate resources.
- Normal Pi startup does not install, download, or repair package state. Preserve public tool and command names unless a separate migration decision changes the contract.
- `.agents/skills/jeito-setup/SKILL.md` is the guided package front door. It discovers extension-owned setup policy; it does not duplicate or override it.

## Documentation and publication

- The root README is a compact router. [`docs/getting-started.md`](docs/getting-started.md) owns installation; [`docs/README.md`](docs/README.md) owns routing; [`docs/publication-readiness.md`](docs/publication-readiness.md) owns unresolved release gaps.
- Update the current owner of a claim instead of creating a parallel authority. Current reference docs own behavior; ADRs own durable reasons; plans and `.pi/goals/` do not become public runtime authority.
- [`config/APPEND_SYSTEM.md`](config/APPEND_SYSTEM.md#1-frame-the-task-before-acting) owns the baseline evolving-intent contract; [`goal-management`](extensions/guidepin/skills/goal-management/SKILL.md) owns its scaffolder, templates and deeper workflow. Reuse these owners rather than adding another goal procedure here. The skill and reminder hook load with the aggregate.
- Preserve useful superseded ADRs and label them historical. Remove broken current routes and obsolete package/tool names; do not rewrite history to look current.
- First-party documentation audits exclude `node_modules/`, `.runtime/`, dependency/vendor trees, generated state, caches, test fixtures, research corpora, and pristine upstream documentation.
- Do not claim a public Git release, supported platform, private reporting channel, or license that has not been selected and proved.

## Host-owned defaults and recommendations

- `config/APPEND_SYSTEM.md` and `config/tool.yaml` are versioned full-harness defaults. Active files under `~/.pi/agent/` remain host-owned; standalone extensions never apply them.
- Only `/skill:jeito-setup` may propose applying those defaults, after preview, backup, explicit confirmation, and post-restart verification.
- A tooltap change that alters routing or runtime configuration is not live until the active host `tool.yaml` is reconciled through that flow. Repository-only checks prove source, not the running host.
- Third-party recommendations are declarative entries installed independently. Never vendor, patch, re-export, or automatically reinstall a recommendation; declining one is healthy.

## tooltap invariants

- `tools` is the one stable public control. For gateway-late enablement within one provider/API/model epoch, the serialized provider `tools[]` stays byte-identical, and the enabled target schema stays absent.
- Gateway-late targets execute only through `tools({ request, arguments })`. Never call `setActiveTools` or promote the target schema as a compatibility fallback. A genuine model epoch may rebase previously enabled tools into the new ordinary baseline; [`extensions/tooltap/docs/contract.md`](extensions/tooltap/docs/contract.md) owns the complete rule.
- Before changing activation or fallback behavior, read [`how-pi-tools-reach-models.md`](extensions/tooltap/docs/how-pi-tools-reach-models.md) and run the fast gateway gate in [`real-world-verification.md`](extensions/tooltap/docs/real-world-verification.md). The focused proof must establish declaration byte stability, target absence, and successful wrapper execution together.
- A jeito-owned tool's registered source description is its discovery and enabled-contract owner. `manifestBlurb` is for host-curated built-in or third-party tools; untrusted descriptions may rank suggestions but cannot authorize fuzzy permission changes.

## Shared jeito UI

- [`extensions/codeweave-pi/docs/ui-rendering.md`](extensions/codeweave-pi/docs/ui-rendering.md) owns the fleet rendering contract; tooltap' one-control details live in [`extensions/tooltap/docs/ui-rendering.md`](extensions/tooltap/docs/ui-rendering.md).
- All jeito renderers use `Symbol.for("pi.agent.jeitoDensity.v1")`, read density live on every render, and preserve `ultra` footer-only, `normal` 30-line, and `extended` 120-line behavior. `Ctrl+U` cycles jeito density; `Ctrl+O` remains Pi-native.
- The shared frame owner adds no blank padding. Multi-file reads keep ranges in each file header. Every rendered tool uses `renderShell: "self"`, `renderCall`, and `renderResult`.
- When UI code changes, run the shared root UI contract plus the owning extension's focused checks. Do not copy a renderer into a new per-extension style owner.

## Mutation, migration, and proof

- Inspect the working tree before changes and preserve unrelated work. Copy and verify one extension before disabling an old path; never load old and new copies that register the same resources.
- Exclude dependencies, generated indexes, logs, caches, research corpora, backups, context dumps, and runtime environments from commits. Never expose credentials or host-private configuration.
- Fix the shared owner, not a representative host. Verify contracts with focused tests, runtime behavior with execution, and Git release readiness with an immutable-ref install/update/rollback/removal journey.
- Root `npm test` or `npm run verify` is for aggregate integration/release claims. Start with the changed workspace's script and broaden only when the affected boundary requires it.

## Dependency and upstream boundary

`node_modules/`, `.runtime/`, `vendor/`, git/pip-installed trees, and pristine upstream material are dependencies or evidence, not first-party documentation. Their README, changelog, license, benchmark, prompt, fixture, and generated files stay exactly as shipped. Adaptations belong in first-party wrappers, notices, and provenance docs outside those trees.
