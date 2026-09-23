---
title: "Install jeito from Git or a checkout"
description: "Supported aggregate and selected-extension installation paths, preparation order, updates, overlap safety, and codeweave-pi's specialized installer."
tags: [jeito, installation, git, pi, setup]
created: 2026-08-28
updated: "2026-09-23 13Z"
status: pre-release
owns: "jeito installation, update, and registration entry paths"
audience: user
related: [README.md, .agents/skills/jeito-setup/SKILL.md, extensions/codeweave-pi/docs/setup.md]
---

# Install jeito from Git or a checkout

jeito is distributed as a Git repository, not through npm. npm prepares dependencies and extension-owned runtimes; Pi registers the prepared package. A failed preparation must never be followed by registration.

## Requirements

- Node.js 22.19 or newer
- npm
- Pi compatible with the root peer dependency in [`package.json`](../package.json)
- Git
- Additional platform or credential requirements named by the selected extension README

codeweave-pi currently supports only Darwin ARM64 and Linux ARM64 and has a larger first-install runtime/model footprint; read its [package entrypoint](../extensions/codeweave-pi/README.md) before selecting it.

## Install the complete suite from an immutable Git ref

Use this only after the repository identity and a release ref are published:

```bash
pi install git:github.com/<owner>/<repository>@<immutable-tag-or-commit>
```

Pi owns the managed clone and npm preparation for a Git source. Restart Pi after installation, then run `/skill:jeito-setup` for optional host-owned defaults and extension-specific onboarding.

## Install the complete suite from an editable checkout

**Not a first-run path today:** a bare clone lacks codeweave-pi's production Core payload, so root npm preparation can fail. To experiment without it, use the single-extension example below. Keep this full-suite command for a publisher-prepared checkout once the [Core delivery gap](publication-readiness.md#18-codeweave-pi-core-payload-delivery) is closed.

```bash
git clone git@github.com:alehdezp/jeito.git jeito
cd jeito
npm install --omit=dev
pi install "$PWD"
```

Keep the checkout at the registered path. After changing refs or pulling source, rerun npm preparation and restart Pi.

### Try one extension without preparing codeweave-pi

With access to `git@github.com:alehdezp/jeito.git`, you can clone the suite and prepare only websift. This is a local-path registration, not an npm publication or a proven public Git install; do not run the root aggregate installation just to try a web tool. The remote and release ref have not yet been verified from a clean machine.

```bash
git clone git@github.com:alehdezp/jeito.git jeito
cd jeito
npm install --omit=dev --workspace @alehdezp/websift --include-workspace-root=false &&
  pi install "$PWD/extensions/websift"
```

Restart Pi and run `/web-doctor` to see which optional providers and extractors are available; do not paste credentials into chat. The [websift README](../extensions/websift/README.md#installation-and-first-use) explains the prerequisites, possible charges, and `/web-setup`. npm must succeed before Pi registration; installing only this workspace avoids codeweave-pi's model/Core preparation. To try a different extension, follow its own README with its exact workspace name. Do not also register the aggregate.

## Install one extension from a checkout

Pi Git sources cannot target a monorepo subdirectory, so a standalone extension must be installed from a local checkout. guidepin is the exception: its resources load only with the complete jeito suite.

```bash
cd /absolute/path/to/jeito
npm install --omit=dev \
  --workspace <exact-package-name> \
  --include-workspace-root=false
pi install "$PWD/extensions/<directory>"
```

Use the extension README for its exact package name, requirements, and verification command. Do not register the aggregate and a contained extension together: duplicate tool or command names can prevent Pi from loading either copy.

### codeweave-pi's prepared-checkout installer

```bash
cd /absolute/path/to/jeito
npm run install:codeweave-pi
```

This command verifies the publisher-prepared Core assets, prepares QMD dependencies/models, and registers only after success. Only Graphify has optional Python provisioning; CRG is retired. The current development checkout lacks the production Core payload: a bare clone is not yet a proven turnkey installation, and the verifier does not download or build that payload. Continue with [`extensions/codeweave-pi/docs/setup.md`](../extensions/codeweave-pi/docs/setup.md); the unresolved delivery boundary is recorded in the [publication register](publication-readiness.md#18-codeweave-pi-core-payload-delivery).

## Project-local registration

Prepare the package in its trusted checkout first, then register it from the consumer project:

```bash
pi install /absolute/path/to/prepared/package -l --approve
```

This writes the consumer project's `.pi/settings.json`; it does not replace npm preparation.

## Shipped full-harness defaults

[`config/APPEND_SYSTEM.md`](../config/APPEND_SYSTEM.md) and [`config/tool.yaml`](../config/tool.yaml) are versioned, opinionated defaults. Active files under `~/.pi/agent/` remain host-owned. Only `/skill:jeito-setup` may propose applying them, and it must preview, back up, confirm, and report each change. Standalone extensions never apply them.

## Update, remove, or recover

Use an immutable ref for reproducible managed installs. For an editable checkout, fetch and check out the intended ref, rerun npm preparation, and restart Pi. Use `/skill:jeito-setup` for overlap checks, package removal, and recovery; extension-specific setup stays with the extension's own README or setup skill.
