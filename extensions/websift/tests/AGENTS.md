---
title: "jeito websift test ownership and proof budget"
description: "What jeito websift tests prove, who owns each behavior, and when to stop adding proof so tests never outgrow the implementation."
tags: [jeito-websift, testing, proof-budget, test-ownership, verification]
created: 2026-07-30
updated: 2026-08-05
status: active
owns: "jeito websift test scope, ownership, and proof-budget boundaries"
audience: contributor
---

# jeito websift test ownership and proof budget

The product behavior is the objective; tests are proof of it, not an inventory of the code. A green suite that mirrors every line proves nothing the next reader can trust.

- **Reuse the owning test.** Each behavior has one owner. Before adding proof, find the test that already owns the behavior and extend it; do not fork a second test that asserts the same thing from another angle. Registration shape lives in `registration.test.mjs`; provider setup behavior lives in `provider-control.test.mjs`; per-adapter contracts live in `tests/adapters/<id>.test.mjs`; the shared credential-redaction gate lives in `no-secret.test.mjs`.
- **New test files only for a distinct public owner or boundary.** A new file needs a new public surface, owner, or trust boundary to justify it — not a new helper, fixture, or permutation of an existing one.
- **Test public behavior and real boundaries.** Prove the contract callers depend on and the boundaries that can actually fail: security (secret handling, 0600, no-overwrite of unsafe targets), billing (usage accounting, no hidden retries), data loss (atomic writes, selective YAML preservation), and lifecycle (registration, cancellation, timeout). Do not add tests for private helpers, display labels, serialization round-trips, every field, every branch, SDK defaults, or internal mechanics.
- **Combine plausible regression trajectories.** One test may walk a whole path — set/replace/remove, or concurrent dispatch plus partial failure plus filtering — asserting the connected behavior together instead of one assertion per test.
- **No source seams for low-value tests.** Never add an abstraction, injection point, or export to the production source solely to make a low-value test possible. If a behavior needs a seam to test, the behavior is probably not worth testing at that granularity.
- **Mocks own mapping, failure, and evidence; live calls need authorization.** A mock proves how the adapter maps a response, classifies a failure, and preserves evidence. Live provider calls consume credits and run only when mocked proof cannot establish compatibility and the user has authorized the cost.
- **Never assert what a provider returned.** Provider behavior drifts by version and by day; result quality is validated by the adaptive mastery loop (agent-intelligence-driven query, mutation, and result understanding) in `docs/WORK-PLAN.md`, never by fixtures or hardcoded expectations. This suite protects only deterministic contracts: request shape, routing, billing ceilings, cancellation, credential redaction, and evidence-state guardrails.
- **Default proof is the focused owner plus typecheck.** Run the owning test file(s) and `npm run typecheck --workspace @alehdezp/websift`. Run `npm test --workspace @alehdezp/websift` only at a coherent provider slice or package boundary.
- **Hold the proof budget.** Plan how much proof a change needs before writing it. If new proof approaches or exceeds the implementation it covers, stop and consolidate. The only exceptions are the real boundaries above (security, billing, data loss, lifecycle), and each exception must be justified by name.
- **Deleting redundant, brittle tests is maintenance.** Removing tests that duplicate an owning test or assert internal mechanics — while the owning proof stays green — is a correct cleanup, not a coverage loss.

## W6 deterministic-test intent audit — 2026-08-04

This audit covers all 27 `*.test.mjs` owners. Every retained file protects a locally deterministic contract; none asserts that a live provider returned a particular fact, ranking, or quality level. Provider-shaped fixtures exercise request mapping, evidence state, billing, cancellation, or redaction only. The local `section-rank` corpus gates are retained because they test repository-owned retrieval logic, not provider behavior.

| Owning test | Decision protected | Audit action |
|---|---|---|
| `adapters/context7.test.mjs` | Version pinning, ambiguity refusal, retained docs, evidence rights | Keep; intent comment added |
| `adapters/exa.test.mjs` | Request mapping, cost metadata, answer evidence state, internal operation reachability | Keep; intent comment added |
| `adapters/linkup.test.mjs` | Request modes, zero-call input guards, evidence mapping, cancellation, redaction | Keep; intent comment added |
| `adapters/native.test.mjs` | Unsupported modes fail before Native transport | Keep; intent comment added |
| `adapters/pi-packages.test.mjs` | Bounded catalog lookup never installs | Keep; intent comment added |
| `adapters/serper.test.mjs` | Locale/request mapping, lead-only evidence, billable-call guards, cancellation, redaction | Keep; intent comment added |
| `adapters/skillsmp.test.mjs` | Catalog filters/bounds, evidence metadata, cancellation, redaction | Keep; intent comment added |
| `adapters/tavily.test.mjs` | Request mapping, date guards, usage credits, cancellation, redaction | Keep; intent comment added |
| `adapters/xsearch.test.mjs` | Handle/date bounds, work metadata, no-winner state, cancellation, redaction | Keep; intent comment added |
| `config.test.mjs` | Malformed/cached/deleted configuration degrades safely | Keep; intent comment added |
| `doctor.test.mjs` | Readiness and configuration faults are actionable and secret-safe | Keep; intent comment added |
| `failures.test.mjs` | Shared failure taxonomy and recovery preserve caller intent and secrets | Keep; intent comment added |
| `fetch-handlers/handlers.test.mjs` | Specialist dispatch, locators, byte limits, timeouts | Keep; intent comment added |
| `fetch-handlers/http.test.mjs` | Native HTTP scheme, size, and thin-content boundaries | Keep; intent comment added |
| `llm-rich.test.mjs` | Deterministic trigger/format/cache/fallback; no live model call | Keep; explicit intent header retained |
| `no-secret.test.mjs` | Resolved credentials never enter adapter output/failures | Keep; intent comment added |
| `novel-corpus.test.mjs` | Local retrieval carries novel facts and refuses true absence | Keep; intent comment added |
| `output.test.mjs` | Session retention and GCF whole-record/evidence/truncation state | Keep; intent comment added |
| `provider-control.test.mjs` | Zero-call startup, masked persistence, safe files, isolated usage, one-call liveness | Keep; intent comment added |
| `real-corpus.test.mjs` | Local retrieval recall and context budget on retained snapshots | Keep; intent comment added |
| `registration.test.mjs` | Current resources register once; lookup schemas retain evidence rights | Keep; intent comment added |
| `routing.test.mjs` | Host policy, fallback taxonomy, eligibility, no hidden calls | Keep; intent comment added |
| `section-rank.test.mjs` | Markdown structure, exact locators, size bounds, ranking, true absence | Keep; intent comment added; file also has concurrent work |
| `web-answer.test.mjs` | Core public answer behavior remains stable beside provider specialists | Keep; intent comment added |
| `web-fetch.test.mjs` | Explicit routing, retained evidence, cache provenance, composition, input bounds | Keep; intent comment added; file also has concurrent work |
| `web-search.test.mjs` | Serper-only query/country schema, fixed 10 leads, one no-fallback attempt, lead evidence, metadata | Superseded multi-provider-plan tests removed; current intent comment owns the replacement |
| `web-specialists.test.mjs` | Five retained specialist schemas, one-attempt dispatch, evidence rights, cost/work metadata | Keep; constrained Tavily Search and retained Exa/X/answer methods |

W6 added comments but no tests or assertions, and found no provider-result expectation to delete. The coherent package suite passes 297 tests. Its higher count comes from the separately authorized W2 specialist proof and concurrent fetch/LLM-rich work, not from expanding the W6 audit into provider-quality validation.
