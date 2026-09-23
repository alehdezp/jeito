---
title: "Third-party notices for jeito Shell"
description: "Attribution and license boundary for jeito Shell's pinned LeanCTX binary and shell-only integration adapted from pi-lean-ctx."
tags: [jeito-shell, lean-ctx, pi-lean-ctx, apache-2.0, third-party]
created: 2026-07-26
updated: 2026-07-26
status: active
owns: "LeanCTX Apache 2.0 attribution and shell-only integration boundary"
audience: contributor
related: [README.md, ../../THIRD_PARTY_NOTICES.md]
---

# Third-party notices for jeito Shell

## LeanCTX 3.9.12

This extension downloads and executes an unmodified LeanCTX 3.9.12 binary from the official [`yvgude/lean-ctx`](https://github.com/yvgude/lean-ctx/tree/v3.9.12) release. Each supported release archive is pinned by SHA-256 in [`lean-ctx-runtime.mjs`](./lean-ctx-runtime.mjs). The binary is stored inside the installed extension and is invoked only for this extension's `bash` commands.

The shell-only integration adapts these ideas from [`packages/pi-lean-ctx/extensions/index.ts`](https://github.com/yvgude/lean-ctx/blob/v3.9.12/packages/pi-lean-ctx/extensions/index.ts):

- invoke `lean-ctx -c <command>` for compressed shell execution;
- set `LEAN_CTX_COMPRESS=1` and `LEAN_CTX_SAVINGS_FOOTER=always`; and
- provide an explicit raw-output bypass.

The integration deliberately omits LeanCTX onboarding, setup, shell hooks, MCP, memory, proxying, read/search tools, native-tool suppression, and global installation.

LeanCTX is Copyright 2026 Yves Gugger and licensed under the Apache License 2.0. The complete license and upstream attribution notice are included at [`LICENSES/LeanCTX-Apache-2.0.txt`](./LICENSES/LeanCTX-Apache-2.0.txt) and [`LICENSES/LeanCTX-NOTICE.txt`](./LICENSES/LeanCTX-NOTICE.txt).
