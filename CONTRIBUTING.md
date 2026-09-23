---
title: "Contribute to jeito"
description: "Public contribution workflow, package boundaries, focused verification, documentation ownership, and privacy expectations."
tags: [jeito, contributing, development, testing]
created: 2026-08-28
updated: 2026-08-28
status: active
owns: "The public contribution entrypoint"
audience: contributor
related: [AGENTS.md, docs/README.md, SECURITY.md]
---

# Contribute to jeito

jeito is a pre-release monorepo. Small, evidence-backed changes are welcome; broad redesigns should begin with an issue or design discussion because several extensions carry provider, runtime, privacy, and migration constraints that are not visible from one file.

## Before changing code

1. Read the target extension's `README.md` and nearest `AGENTS.md`.
2. Inspect the working tree and preserve unrelated work.
3. Find the current owner of the behavior or documentation claim; do not create a second authority.
4. Keep public tool and command names stable unless the change explicitly includes a migration decision.
5. Never edit `node_modules/`, `.runtime/`, dependency/vendor trees, generated navigation state, caches, or pristine upstream documentation.

[`AGENTS.md`](AGENTS.md) owns the repository-wide engineering invariants. Nested contributor files narrow those rules for their package.

## Prepare the checkout

```bash
npm install
```

Some workspaces install extension-owned runtimes during npm lifecycle scripts. If preparation fails, stop before Pi registration.

## Verify the changed owner

Prefer the smallest check that proves the changed behavior:

```bash
npm run test:installation       # aggregate package/resource lifecycle
npm run test:ui                 # shared jeito renderer contract
npm run verify --workspace <package-name>
# or the exact test/check script listed by that extension
```

Root `npm test` and `npm run verify` are release/integration checks, not mandatory first steps for an isolated documentation or package change. Report what each check proved and any platform or provider behavior it did not exercise.

## Documentation changes

- The root README is a router; detailed installation belongs in [`docs/getting-started.md`](docs/getting-started.md).
- [`docs/README.md`](docs/README.md) routes questions to one current owner.
- Preserve historical ADRs, but label superseded decisions and never route current usage through them.
- Exclude dependency, runtime, vendor, test-fixture, generated, cache, research-corpus, and archived upstream Markdown from first-party documentation audits.

## Pull requests

Keep changes scoped to one coherent reason. Include:

- the user or contributor problem;
- why the chosen owner is the right place to fix it;
- the focused proof and its limits;
- any migration, compatibility, privacy, credential, or platform consequence.

Do not include credentials, prompt/context dumps, provider payloads, generated indexes, local absolute-path state, or real user conversations. Report suspected vulnerabilities through [`SECURITY.md`](SECURITY.md), not a public issue.
