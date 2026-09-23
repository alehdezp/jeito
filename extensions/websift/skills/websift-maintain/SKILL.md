---
name: websift-maintain
description: Diagnose jeito websift failures, port targeted upstream fixes, and run periodic version-drift checks across the provenance ledger. Use when a web tool errors, behaves wrongly, or when checking whether ported upstream code has drifted. Never auto-merges; never touches secrets; updates ADRs and provenance docs after any behavior change.
disable-model-invocation: true
---

# jeito websift maintenance

The owner for "something went wrong." Closes the loop between loud failures
([`docs/adr/0002-internal-architecture/0002-routing-and-failover.md`](../../docs/adr/0002-internal-architecture/0002-routing-and-failover.md))
and the provenance ledger
([`docs/adr/0004-operations-and-evolution/0002-provenance-and-upkeep.md`](../../docs/adr/0004-operations-and-evolution/0002-provenance-and-upkeep.md)).

## Boundaries

- Never auto-merge upstream code. Every port is previewed, confirmed, and tested.
- Never read, print, or modify secret values.
- No behavior change without updating the owning test, provenance doc, and [`ADR 3.1`](../../docs/adr/0003-engineering-stewardship/0001-documentation-and-code-links.md) relationship.
- Read [`docs/adr/AGENTS.md`](../../docs/adr/AGENTS.md) before changing a decision. Update `decision_status`, `confidence`, `evidence_grade`, and `implementation_status` from actual evidence; never mark a fix confirmed merely because source was edited.
- Diff only *mapped* upstream files (those listed in the source's provenance doc);
  ignore upstream files we do not port (e.g. pi-web-access curator/UI, security).

## A. Diagnose a failure

1. Read the failing result's `details.attempts[]`; take the `failureClass`.
2. Act on the class:
   - `missing_credential` → hand off to `/skill:websift-setup`.
   - `auth` → the key is bad/expired; provider was disabled for the session. Tell
     the user to rotate the key; do not retry.
   - `rate_limited` / `timeout` / `network` / `unavailable` → transient; confirm
     the bounded fallback ran (check `fallbackOccurred` and the second attempt).
     If it recurs, run a periodic check (B) for that provider.
   - `empty` → structurally unusable response; if new, suspect an upstream shape
     change → go to step 3.
   - `invalid_input` / `aborted` / `policy` → caller-side; not a provider fault.
     Do not port anything.
3. For a suspected shape change: open
   [`docs/upstreams/<provider>.md`](../../docs/upstreams/README.md), then compare
   our adapter against the installed upstream source
   (`~/.pi/agent/npm/node_modules/<package>`) or its repo.
4. Identify the smallest affected module. Re-port **only that module**; run its
   owning test (`tests/adapters/<provider>.test.mjs` or
   `tests/fetch-handlers/<handler>.test.mjs`).
5. Update the provenance doc (last-reviewed, divergence) and the governing ADR.

## B. Periodic drift check

1. Walk [`docs/upstreams/`](../../docs/upstreams/README.md). For each source with
   a `Next comparison` command, run it (e.g. `npm view pi-web-access version`;
   for Tavily also `npm view @tavily/core version`).
2. If a version moved, download/inspect the newer source into ignored temporary
   storage and diff **only the mapped files** recorded in that provenance doc.
3. Report changed/added/removed mapped files and point each to the affected local
   adapter/handler/test.
4. Recommend port-or-skip per change. Version drift is a prompt, not proof —
   every candidate passes ownership, behavior, license, and regression review
   before import. Never mutate production source from this check.

First-pass fixtures the check should detect
([`docs/adr/0004-operations-and-evolution/0002-provenance-and-upkeep.md`](../../docs/adr/0004-operations-and-evolution/0002-provenance-and-upkeep.md)):
pi-web-access 0.13.0→0.14.0 (donor); @heyhuynhgiabuu/pi-search 0.2.3→0.3.0,
pi-crawl4ai 0.1.2→0.1.5, pi-chrome 0.15.40→0.15.46 (fixtures only; not providers).

## C. After any fix

- Run the owning test and the registration test (exactly the expected tools, no
  duplicates) and the no-secret-in-output test.
- Bump the provenance doc's last-reviewed date and record the divergence.
- Update the governing ADR (`updated`, current decision, evidence/implementation metadata, revisit conditions, and History).

## Completion report

State: the failure class and diagnosis (or the drift found); the module(s)
re-ported or the change skipped (with reason); tests run and their result; the
docs/adr records updated. If a fix needs a Pi restart or a stopped-Pi change, print the
exact transaction and do not mutate a loaded tree.
