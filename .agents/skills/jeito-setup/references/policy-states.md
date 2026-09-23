---
title: "jeito machine-policy states"
description: "The six observed codeweave-pi policy states (fresh, current, legacy, conflict, malformed, package-blocked) and how to explain each one."
tags: [jeito-setup, policy-states, codeweave-pi]
created: 2026-08-03
updated: 2026-08-03
status: active
---

# Machine-policy states

Read this reference after the snapshot identifies the codeweave-pi policy state; the root owns the active-versus-available principle, this file owns the per-state behavior. Existing configuration receives the same explanation as a fresh one; always render the active-versus-available delta explicitly.

- **Fresh:** say codeweave-pi is not configured. Credentials or downloaded models are available ingredients, not active choices. Show every viable coherent profile, highlight strongest quality and easy/free OpenRouter, then ask which direction to preview or explain.
- **Current:** explain what the active setup gives the user today. Compare it with every coherent viable profile; recommend keeping it when it remains compatible and fits the user’s likely needs, otherwise explain one concrete improvement. Never turn “already configured” into a terse no-action receipt.
- **Legacy:** explain that an older policy remains active and may contain choices the friendly format cannot represent. Preserve it and offer a field-by-field migration review while retaining the profile comparison and capability inventory.
- **Conflict:** explain that two policies disagree and preserve both. Offer **review the differences**, **use the current policy**, **use the older policy**, or **explain the conflict**; do not offer a generic unchanged state that leaves intended ownership unresolved.
- **Malformed:** explain that codeweave-pi cannot safely interpret the policy, leave automation disabled, and offer to inspect and preview a repair without overwriting it.
- **Package-blocked:** explain the package problem in ordinary language, give the smallest supported recovery, and pause downstream configuration while preserving the overview of unaffected components.
