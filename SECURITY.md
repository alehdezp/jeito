---
title: "jeito security policy"
description: "How to report vulnerabilities and which jeito surfaces require special care before public disclosure."
tags: [jeito, security, vulnerability-reporting, privacy]
created: 2026-08-28
updated: 2026-08-28
status: pre-release
owns: "Vulnerability reporting and public-disclosure guidance"
audience: mixed
related: [README.md, CONTRIBUTING.md, extensions/context-diagnostics/README.md, extensions/websift/README.md]
---

# jeito security policy

jeito is pre-release and does not yet have a published security contact or GitHub private-vulnerability-reporting URL. **Do not publish a suspected vulnerability, credential, prompt dump, provider payload, or private repository content in a public issue.** Until the repository owner publishes a private channel, retain the report locally and request that channel without including sensitive details.

A useful private report should include the affected extension and ref, impact, minimal reproduction, observed and expected behavior, and whether credentials or private content may have been exposed. Redact values; credential names and provider identities are usually sufficient.

## High-risk surfaces

- [`context-diagnostics`](extensions/context-diagnostics/README.md) can write complete prompts, tool schemas, and messages. Dumps are private debugging artifacts and should be deleted after use.
- [`websift`](extensions/websift/README.md) handles credentials, remote content, redirects, local caches, and network-boundary checks.
- [`shell`](extensions/shell/README.md) executes commands and manages descendant process groups and logs.
- [`codeweave-pi`](extensions/codeweave-pi/README.md) reads and mutates local repositories and manages project-local indexes.
- [`tooltap`](extensions/tooltap/README.md) controls tool callability across provider routes.

Never commit real secrets, host configuration, context dumps, generated navigation state, or session logs. If a secret reaches Git history, rotation is the first response; deleting the current file is not sufficient.

## Supported versions

No public release is currently supported. Security fixes apply to the current pre-release branch until the repository publishes an immutable release policy.
