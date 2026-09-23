---
title: "Independent test oracles and proportionate performance work"
description: "Design record for consolidating tautological-test guidance and preventing out-of-scope micro-optimization and benchmark infrastructure in APPEND_SYSTEM.md."
tags: [append-system, testing, performance, benchmarks, design-session]
created: 2026-08-28
updated: 2026-08-28
status: accepted
owns: "The 2026-08-28 APPEND testing and performance wording decision"
---

# Independent test oracles and proportionate performance work

## Objective and observed gap

Prevent tests from deriving their oracle from the implementation under test, prevent millisecond-scale optimization that has no material effect on the accepted outcome, and prevent maintained benchmark machinery when neither the user nor a recurring project performance contract asks for it.

The current prompt states the implementation-derived-test principle twice. Its performance rule says to measure first and optimize the measured critical path, but that wording can itself invite irrelevant microbenchmarks and does not distinguish a disposable decision measurement from maintained benchmark infrastructure.

## Options considered

1. Add “Tautological tests considered harmful” as a new rule. Rejected because it duplicates two active rules and names the failure without teaching an independent correctness source.
2. Ban micro-optimization or benchmarks below a fixed millisecond threshold. Rejected because tiny per-operation gains can be material at scale, while larger isolated gains can be irrelevant.
3. Keep the current wording. Rejected because “measure first” does not require accepted scope, material workload impact, or proportionate benchmark ownership.
4. Consolidate the test rule and replace the performance rule. Accepted because it removes duplication, gives both decisions observable gates, and preserves legitimate performance work.

## Accepted design

- Delete the duplicate testing bullet from `Prove before you claim`.
- Replace Code's performance bullet with an accepted-outcome and representative-workload gate. A one-off question uses existing or disposable measurement. Maintained benchmark infrastructure requires a recurring project-owned performance contract or an explicit user request.
- Replace Code's testing bullet with one behavior-contract owner. Expected outcomes come from caller or user-visible contracts, reported failures, or trusted specifications rather than current implementation behavior. A useful test fails on contract breakage and survives behavior-preserving refactors.

## Evidence and limits

Current test-oracle research establishes that regression assertions which adopt current behavior cannot reveal faults already present. Current performance research shows that agent-authored performance changes under-report empirical validation, sterile microbenchmarks can reverse the apparent winner, and application-grounded benchmark suites can contain large redundant surfaces. Exact sources, methods, and limits live in the canonical APPEND research `EVIDENCE.md` entries 152–156 and `FINDINGS.md` Lane 25.

No controlled study proves these exact prompt lines will change agent behavior. Structural checks can prove only the approved wording, single-owner placement, runtime linkage, and record coherence. Normal use remains the behavioral feedback boundary.

## Authorization and frozen scope

The user approved the latest displayed draft with “do it” on 2026-08-28. The allowed APPEND delta is exactly three hunks: delete the duplicate Prove testing bullet, replace Code's performance bullet, and replace Code's testing bullet. Required backup, decision-ledger, changelog, and research-state updates may record the change. No other APPEND rule, tool contract, benchmark framework, numeric threshold, or runtime behavior is authorized.
