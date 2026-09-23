---
title: "jeito source snapshot and later distribution work"
description: "What this public source snapshot contains and which installation claims remain unproved."
tags: [jeito, publication, source, pre-release]
created: 2026-09-23
status: pre-release
owns: "The boundary between the public source presentation and a supported distribution"
audience: mixed
related: [README.md, docs/getting-started.md, SECURITY.md, THIRD_PARTY_NOTICES.md]
updated: "2026-09-23 16Z"
---

# jeito source presentation

This repository presents the first-party source as work in progress. The author uses a separate development checkout. This snapshot has one root commit; it carries no earlier goal, plan, cache, or agent-audit history. The private working files stay outside this repository.

The snapshot omits prebuilt pi-nav executables and native modules, locally adapted vendor trees, and private working records. It is not an installable release. The source and documentation show the architecture and current tradeoffs, but a bare clone cannot prepare the complete suite. Package manifests and README installation sections describe the intended interfaces and prerequisites, not a verified public install journey.

## Before claiming supported distribution

- Prepare the matching codeweave-pi Core, model, and native assets for each claimed platform without silently changing host-owned state.
- Resolve the current disagreement between `extensions/codeweave-pi/docs/requirements.md` and its `package.json` postinstall model provisioning.
- Define and verify the Node ABI boundary for native database artifacts; OS and CPU matching alone are insufficient.
- Verify the exact immutable Git ref with Pi install, update, rollback, and removal on each claimed platform. A local source test does not prove that journey.
- Review rights, third-party notices, and the exact proposed artifact. Do not bundle private goals, caches, host configuration, or generated diagnostics.

### 1.5 No immutable-ref installation proof yet

There is no tested public ref or clean-machine full-suite install. See [getting started](getting-started.md) for local-checkout experimentation, with the stated Core limitation.

### 1.8 codeweave-pi Core payload delivery

The source snapshot lacks the prepared production Core payload and prebuilt native artifacts. Publisher-prepared builds and clean-host verification remain future work. Do not mistake a source checkout or isolated backend test for a packaged release.
