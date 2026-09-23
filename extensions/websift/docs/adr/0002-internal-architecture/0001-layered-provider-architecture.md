---
title: "ADR 2.1 — Layered provider architecture and normalized contracts"
description: "Records the four internal layers, dependency direction, registry capability contract, normalized intents/results, and file-per-reason-to-change structure."
tags: [jeito-websift, adr, architecture, registry, normalization]
created: 2026-07-28
updated: 2026-07-28
status: active
adr_id: ADR-002.001
adr_type: child
decision_status: accepted
confidence: evidence-backed
evidence_grade: verified
implementation_status: validated
decision_owner: alehdezp
owns: "Internal layering, capability registry, normalized types, and dependency direction"
audience: contributor
parent: docs/adr/0002-internal-architecture/README.md
code: [index.ts, src/registry.ts::AdapterRegistry, src/types.ts, src/routing.ts, src/failures.ts, src/output.ts, src/config.ts]
related: [docs/DESIGN.md, docs/adr/0001-product-and-evidence/0002-tool-surface-and-evidence.md]
---

# ADR 2.1 — Layered provider architecture and normalized contracts


## ADR parent and current state

This micro-decision inherits its objective and settled constraints from [ADR-002 — the folder master ADR](README.md). It does not inherit confidence or evidence from sibling ADRs.

`alehdezp` owns the decision. Current metadata: `decision_status: accepted`, `confidence: evidence-backed`, `evidence_grade: verified`, and `implementation_status: validated`. The metadata—not optimistic prose—governs whether dependent work may treat the decision as proved.

## Decision

Four layers; tools never talk to providers directly. A tool calls the
orchestration core with a normalized intent; the core asks the registry which
adapter can serve it, runs the adapter, classifies any failure, optionally falls
back, normalizes the result, bounds the output, and stamps provenance.

```
Public tools (4)        web_search · web_fetch · web_answer · web_lookup
   │                    stable agent-facing contracts; rarely change
Orchestration (core)    routing · failures · normalization · output/storage · config
   │                    owned; changes rarely once stable
Capability registry     adapter metadata → selects provider for an intent
   │                    owned; one entry per provider
Adapters + handlers     adapters/{serper,exa,tavily,linkup,xsearch,
                        context7,skillsmp,pi-packages}.ts
                        fetch-handlers/{http,github,youtube,pdf,video}.ts
                        volatile; one file each
```

Adding a provider = add one adapter file + one registry entry + one provenance
doc. **Zero changes to tools or routing logic.** That is the core maintainability
guarantee.

## Why file-per-concern, and why folders abstract from code

The split is by *reason to change*, which is the axis a maintainer (human or
agent) searches on:

- `adapters/` changes when a vendor API changes.
- `fetch-handlers/` changes when extraction behavior changes (different reason:
  pi-web-access upstream, not a vendor API).
- `tools/` changes only when the agent-facing contract changes.
- core files (`routing`, `failures`, `output`, `config`, `registry`) change
  almost never once stable.

A monolithic orchestrator (pi-web-access's ~24K-token `index.ts` is the example
we avoid) returns noise from every `trace` query and buries the one edge a future
agent needs. One file per concern keeps each unit single-responsibility and each
navigation query precise: `explore(code, "exa adapter")` lands on
`adapters/exa.ts`; `trace(callers, "src/routing.ts::selectProviders")` shows
exactly what depends on routing.

## The capability contract (earned by nine adapters)

An abstraction with one implementation is premature; with nine adapters it is
justified. Each adapter exports metadata plus the operations it supports:

```ts
interface AdapterCapability {
  id: string;                    // stable provider id, e.g. "exa"
  operations: Operation[];       // search|fetch|answer|lookup       [routing]
  credentials: string[];         // env names, e.g. ["EXA_API_KEY"]  [config]
  strengths: string[];           // semantic, academic, news, social [routing/kind]
  modes?: string[];              // e.g. fetch: ["page","site","map"][fetch dispatch]
  returns: ("leads" | "content" | "answers")[];                     [evidence/routing]
  filters?: string[];            // recency, domains, version        [selection]
  timeoutMs: number;             // [bounds]
  concurrency: number;           // [bounds]
  fallbackEligible: boolean;     // [fallback policy]
  provenance: string;            // path to docs/upstreams/<id>.md
}

interface Adapter {
  capability: AdapterCapability;
  search?(intent: SearchIntent, ctx: OpContext): Promise<SearchResult[]>;
  fetch?(intent: FetchIntent, ctx: OpContext): Promise<FetchedContent[]>;
  answer?(intent: AnswerIntent, ctx: OpContext): Promise<AnswerResult>;
  lookup?(intent: LookupIntent, ctx: OpContext): Promise<LookupResult[]>;
}
```

**Named-consumer rule (after independent review — finding A1).** A field stays in
`AdapterCapability` only if routing, config, or tool dispatch *reads* it (the
`[…]` tags above name the consumer). Descriptive metadata with no consumer —
free-text limitations, relative cost/latency class, display names — lives in the
provider's [`docs/upstreams/<id>.md`](../../upstreams/README.md), not here. Promote a
field back only when a named consumer appears. This keeps "add a provider = one
file + one entry + one doc" honest instead of "…+ N metadata guesses," and is
checked at every review (ponytail gate).

`OpContext` carries the `AbortSignal`, resolved config, a `persist(data)`
capability (see [`0005`](0003-fetch-pipeline.md) persistence write path), and a
logger that never emits secret values. An adapter throws a typed `ProviderError`
carrying a `FailureClass` (see [`0004`](0002-routing-and-failover.md)); it never
returns a secret in an error message.

## Normalized result types (owned contracts)

```ts
interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;   // ISO
  score?: number;
  sourceType?: string;    // organic | news | academic | code | social
}

interface Source {
  url: string;
  title: string;
  passage?: string;       // extracted passage or snippet
  fetched: boolean;       // true only if we retrieved and read the page
  evidenceStatus: "lead" | "catalog" | "fetched";
  provider: string;
}

interface Attempt {
  provider: string;
  operation: string;
  status: "ok" | "failed" | "skipped";
  durationMs: number;
  failureClass?: FailureClass;
  fallbackReason?: string;
}
```

Adapters normalize provider-native shapes into these. Provider-specific value is
not flattened into a useless common denominator: where semantics are shared we
add a stable field; a generic untyped options bag is avoided until a reproduced
need proves it.

## index.ts wiring

`index.ts` registers the four tools and the two commands, builds the registry
from the adapter modules, and wires the config loader. It contains no provider
logic. It is created in Slice 1 (see
[`0003`](../0005-provider-evaluation-and-guidance/0001-provider-capability-policy.md) for the delivery sequence).


## Verified Pi runtime contract (ground truth for Slice 1)

Confirmed against `@earendil-works/pi-coding-agent` 0.82.x
(`dist/core/extensions/types.d.ts`) **and** the live `serper-search` adapter:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";           // bare "typebox", NOT @sinclair/typebox

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "websift Search",
    description: "...",
    parameters: Type.Object({ /* ... */ }),
    // executionMode: "parallel",          // optional: independent calls run concurrently
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // signal: AbortSignal | undefined → thread into fetch AbortController (§7 cancellation)
      // ctx.sessionManager.getBranch()  → D1 session-restore READ path (read-only)
      // pi.appendEntry(...)             → D1 persistence WRITE path (closure over `pi`)
      return { content: [{ type: "text", text }], details: { /* typed TDetails */ } };
    },
  });
}
```

- Full signature: `execute(toolCallId: string, params: Static<TParams>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
  ctx: ExtensionContext): Promise<AgentToolResult<TDetails>>`.
- `AgentToolResult<TDetails>` = `{ content: [{type:"text",text}], details }`
  (proven by the running serper adapter's working return).
- A typed `defineTool<TParams,TDetails,TState>(tool)` helper exists
  (`types.d.ts:379`) — optional, for inference.
- **D1 confirmed both ways:** write via `pi.appendEntry` (factory closure), read
  via `ctx.sessionManager.getBranch()` (execute arg). Cancellation (§7) confirmed
  via the `signal` arg.
- Residual: the exact live-Pi byte-version was read from an archived 0.82.x copy;
  the live install is proven compatible for the core contract by the running
  serper adapter. Re-confirm the live version's `types.d.ts` in the first minutes
  of Slice 1 (cheap insurance, not a blocker).
## What would change this architecture

- If the registry accumulates ceremony beyond "select by capability + priority,"
  simplify (ponytail gate at every review).
- If a provider's value cannot be expressed behind `Adapter` (e.g. a streaming
  operation), that is a contract signal, not a reason to special-case it inside
  routing.

## Alternatives and decisive trade-off

A monolithic orchestrator would couple every provider and return noisy caller/dependency neighborhoods. Wrapping old Pi tools would duplicate schemas and configuration while weakening cancellation and provenance ownership. Normalized orchestration over thin adapters keeps vendor churn local and the public contract stable.

## Evidence and verification

Current `index.ts`, `src/registry.ts::AdapterRegistry`, normalized types, routing, failures, output, and adapter tests support the layered contract. Future provider work must re-open this ADR only if repeated implementation exposes a shared invariant that current owners cannot protect.

## History

- 2026-07-27: hybrid layering settled; capability contract justified by nine
  adapters; security module excluded from the port (see
  [`../upstreams/pi-web-access.md`](../../upstreams/pi-web-access.md)).
