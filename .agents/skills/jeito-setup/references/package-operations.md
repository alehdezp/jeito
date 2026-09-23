---
title: "jeito package operations and safety"
description: "Exact lifecycle mechanics and safety invariants for explicit jeito package install, update, removal, rollback, and defect-evidence requests."
tags: [jeito-setup, package-operations, lifecycle, safety]
created: 2026-08-03
updated: 2026-08-03
status: active
---

# Package operations and safety

Read this reference when the user makes an explicit package install, update, removal, rollback, registration, duplicate-owner, loaded-source, or defect-evidence request. The root owns the trigger; this file owns the mechanics.

For such a request, run `pi list` once and resolve only the selected owner. Use the returned result directly; do not rerun it because display output was abbreviated and do not copy it through a temporary file. Then inspect only the manifest and lifecycle check needed for that package decision.

- Prepare dependencies before Pi registration; failed preparation is never followed by registration.
- Never register the aggregate and an individual contained extension when they expose duplicate resources.
- Do not rebuild, update, or remove code loaded by the current Pi process. Give one stopped-Pi terminal transaction and an exact resume step.
- Preserve machine policy, predecessor policy, project configs/indexes, last-good artifacts, models, unrelated packages, and foreign workers through update, rollback, or removal.
- Host-owned prompt/tool defaults and shell startup files change only after exact preview, backup, and approval by their owning workflow.
- Shared defects receive bounded redacted evidence and an offered draft; never submit an issue automatically.

The root guide owns the standing secret rule (never request, read, print, copy, store, or write an API key or private SSH key) and the receipt-versus-choice output rule; this reference assumes both.
