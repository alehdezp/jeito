---
title: "ADR-0009: Delegate dynamic tool transport to Pi"
description: "Adopt one ordinary search_tools loader and Pi-owned additive activation; supersede extension-owned provider routes and patches."
tags: [tooltap, adr, dynamic-tool-loading, pi-native]
created: 2026-08-23
updated: 2026-08-28
status: stale
adr_id: ADR-0009
adr_type: child
decision_status: superseded
confidence: confirmed
evidence_grade: verified
implementation_status: validated
decision_owner: alehdezp
owns: "Historical universal Pi-native activation attempt superseded by ADR-0010"
audience: contributor
---

# ADR-0009: Delegate dynamic tool transport to Pi

> **Superseded by ADR-0010:** Pi-native additive activation remains one route, but it is not a cache-safe universal fallback. Configured proxy and dispatch routes are restored where live evidence requires them.

## Decision

tooltap registers one ordinary `search_tools` function on every provider. A successful loader call preserves `getActiveTools()` and additively passes matched registered names to `setActiveTools()`. Pi 0.84.2 or newer owns `addedToolNames`, provider serialization, and normal dispatch.

tooltap may observe `before_provider_request` for diagnostics but must not mutate or replace the payload.

## Why

The prior OpenAI client-executed `tool_search` declaration was only an outbound protocol shape. Pi did not dispatch model-emitted `tool_search_call` items through extension tools, so Codex produced an unmatched call and failed before tooltap could answer. Pi's public dynamic-loading lifecycle already solves the same problem and falls back to ordinary active schemas when a provider lacks native deferral.

A single ordinary name also avoids Meta/Muse gateways that reserve `tool_search`.

## Consequences

- Remove native declaration injection, `_toolSearchOutput`, model/provider routing, skeletons, dispatch-only state, `tool_proxy`, and dependency patching.
- Explicit markers and `/tool` activate through the same active set; because they run outside a loader result, their schemas may appear immediately on the next request.
- Restore current sessions from Pi `addedToolNames`; read legacy stow activation details only for saved-session migration.
- Provider and cache claims require fresh live evidence; local tests prove only extension behavior and payload non-mutation.

## Superseded decisions

This ADR formerly superseded ADR-0001 through ADR-0008. ADR-0010 now supersedes this universal route; the older files remain historical mechanism evidence, while `docs/contract.md`, ADR-0010, and ADR-0011 govern current behavior.
