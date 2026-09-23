---
title: "jeito machine snapshot mechanics"
description: "The exact batched owner read and machine-snapshot invocation every jeito-setup run performs before describing readiness or recommending anything."
tags: [jeito-setup, machine-snapshot, presence-check, providers]
created: 2026-08-03
updated: 2026-08-03
status: active
---

# Machine snapshot mechanics

Read this reference before running the snapshot step of `../SKILL.md`; the root guide owns what the snapshot means, this file owns exactly how to run it. Run it once per invocation; never reuse a snapshot from another invocation or infer machine state from the conversation.

## Batched owner read

Never reread, locate, or search for `jeito-setup` itself. Do not run `pi list` or verify package ownership unless a package operation is requested or a specialist/resource is missing. In one batched read from their exact aggregate-package paths, obtain only these exact package-relative authorities:

- `extensions/codeweave-pi/src/core/provider-registry.ts::PROVIDER_REGISTRY` for supported lanes, credential names, locality, advisory models, and evidence;
- `extensions/websift/src/config.ts:DEFAULT_ENV,DEFAULT_CONFIG` for effective routing and credential names;
- `extensions/websift/src/provider-control.ts::PROVIDER_PAGES` for official account, key, billing, usage, and documentation links;
- `extensions/codeweave-pi/scripts/qmd-model-provision.mjs::REQUIRED_QMD_MODELS` and `extensions/codeweave-pi/native/qmd/runtime/llm.js:94-108,126-129` for exact optional local-model filenames and cache root;
- root `package.json:21-32` for the current five-extension aggregate identity;

The aggregate package’s script is `extensions/codeweave-pi/scripts/machine-snapshot.mjs`. Resolve its absolute path from the selected installed aggregate root and invoke it exactly once without changing away from the user’s working folder; pass that original folder as `cwd`. Feed non-secret JSON on stdin and parse one JSON object from stdout. The script is read-only, standard-library-only, and supports Node 22+ on macOS and Linux. A direct contained codeweave-pi invocation may use its package-local copy.

Do not use discovery grep, repeat a failed literal/regex search, reread binding requirements, inspect package manifests, or browse repository documentation during a normal run. If an exact authority is absent, report the resource blocker instead of searching broadly. Read beyond these owners only for a consequential contradiction they expose.

Wait for and inspect this read before constructing the machine check: the returned registry names and model filenames are inputs to that command. Do not parallelize the source read with the presence check.

When Graphify is available or a Graphify recommendation is possible, resolve the installed pinned runtime’s actual Python source path and read its complete `BACKENDS` assignment once. For the shipped Graphify `0.9.23`, the authority is `extensions/codeweave-pi/.runtime/lib/python*/site-packages/graphify/llm.py:100-218`; resolve the wildcard from the runtime interpreter before reading. That table and the native `--model` override own actual backend/default-model support; `PROVIDER_REGISTRY.models` is advisory and may be newer or stale. If the marker reports another version, the table is absent, or the runtime cannot be read, report Graphify unavailable or package-mismatched instead of inventing model support.

## Snapshot invocation

After inspecting the source read, invoke `extensions/codeweave-pi/scripts/machine-snapshot.mjs` from the selected aggregate package exactly once. Pass JSON on stdin with `schemaVersion: 1`, `cwd`, and these non-secret arrays:

- `configs`: current `~/.pi/agent/navigation.yaml` as YAML with the owner’s expected version, predecessor `~/.pi/navigation/config.json` as JSON with its expected version, and `~/.pi/agent/web.yaml` with no invented expected version;
- `credentials`: every exact codeweave-pi and websift credential name returned by the registries;
- `models`: every exact QMD model file plus the Ollama model directory, each with its expected kind;
- `markers`: at minimum `extensions/shell/.runtime/.ready` and `extensions/codeweave-pi/.runtime/.ready`, plus any exact package marker the specialists require;
- `loaderChecks`: only the bounded fish, zsh, or bash private-loader paths and exact non-secret loader lines defined by the specialists.
- `packages`: the aggregate root `package.json` plus every first-party extension `package.json` (`extensions/shell`, `extensions/tooltap`, `extensions/draft-lift`, `extensions/websift`, `extensions/codeweave-pi`), each with a stable id, so installed versions can be compared against declared versions;

## Presence/metadata contract
The script is the one bounded presence/metadata check for this machine: it reports every exact codeweave-pi and websift credential name, the shell and login shell, the ten common macOS/Linux zsh/fish/bash config locations, the effective Pi agent directory and its `settings.json` declared-version status plus navigation/websift/APPEND/tool files, requested config existence/type/mode/declared-version status, installed package versions, top-level config keys, exact QMD model file paths (without listing either directory), exact model/runtime/loader markers, and whether the current directory itself has `.pi-navigation.json`. Missing files and symlinks are reported as facts, not failures. Never enumerate the whole environment, write temporary output, or retry a command merely because its rendered output was abbreviated. An unsupported snapshot schema, invalid input, missing script, or unreadable required check is a package-resource blocker; do not fall back to `find`, `grep`, `pi list`, directory listing, environment enumeration, temporary files, or another shell probe.

## Interpreting the snapshot

Read an existing policy file only after the snapshot identifies its exact path, and only to explain its non-secret choices. The snapshot never interprets policy. Credential presence is availability evidence, not live API proof. Before claiming a provider works, offer a separately approved liveness check naming provider, model/operation, egress, possible cost, attempt bound, and reported fields. websift uses one-provider `/web-setup` controls; codeweave-pi uses the smallest provider-supported metadata/model-access probe. Never send project content or run paid inference without approval. The Pi conversation model is separate from codeweave-pi’s provider/model choices; mention it only when runtime metadata exposes it without reading `auth.json`.

Fast wins come from comparing reported facts, not from new checks: declared version vs installed package version (mismatched or stale install; the settings.json declared version and cross-package consistency are the local baselines, the registry remains the approved-network-only authority), top-level config keys vs the current schema (stale options the friendly loader no longer owns; keys are read for block-style YAML only, so flow-style or multi-document YAML reports best-effort keys — treat them as leads, not proof), predecessor config presence (migration pending), and missing loader lines. Name each as a finding with its consequence; do not turn absence into failure. A registry update check is network egress: never run one inside the snapshot; offer a separately approved check naming the registry, package, and bound.
