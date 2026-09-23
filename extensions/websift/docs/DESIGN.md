---
title: "jeito websift — design overview (the whole system in one read)"
description: "The integrated jeito websift design: everyday tools, explicit provider specialists, evidence boundaries, persistent retrieval, research briefs, routing, evolution, and credentials."
tags: [jeito, web, design-overview, architecture, tools, provider-specialists, research-brief, fallback, config, network-policy]
created: 2026-07-27
updated: "2026-09-23 13Z"
status: active
owns: "Integrated system overview"
audience: mixed
code: [index.ts, src/types.ts, src/registry.ts, src/routing.ts, src/failures.ts, src/gcf.ts, src/output.ts, src/fetch-cache.ts, src/destination-policy.ts, src/section-rank.ts, src/webclaw-spawn.ts, src/js-needs.ts, src/crawl-jobs.ts, src/adapters/webclaw.ts, src/tools/web-search.ts::registerWebSearch, src/tools/web-fetch.ts::registerWebFetch, src/tools/web-answer.ts::registerWebAnswer, src/tools/web-lookup.ts::registerWebLookup, src/tools/web-search-specialists.ts::registerWebSearchSpecialists, src/tools/web-answer-specialists.ts::registerWebAnswerSpecialists, src/config.ts, src/provider-control.ts]
related: [docs/README.md, docs/adr/README.md, docs/adr/0001-product-and-evidence/0001-objective-and-scope.md]
---

# jeito websift — design overview

One Pi extension, `@alehdezp/websift`, that replaces nine fragmented web/discovery
packages with four startup evidence tools plus five explicit provider/method
specialists over thin adapters. The per-decision rationale lives in the numbered [`docs/adr/`](adr/README.md) hierarchy; this document is the integrated current picture.

## 1. What we are building and why

**Problem.** websift capability is scattered across nine packages (Exa, Tavily,
Linkup, xsearch, pi-web-access, Context7, SkillsMP, pi-package-search, plus the
standalone jeito serper-search/skillsmp-search) — ~23 tools, inconsistent
schemas, no shared evidence discipline, drift to track in nine places.

**Why a build, not a wrapper.** Pi's `ExtensionAPI` (0.82.1) can register and
inspect tools but **cannot execute another registered tool**. A facade over the
existing packages is therefore impossible without private internals — so we build
a small owned stack instead.

**Guiding principle.** *Own the stable, rent the volatile, isolate the volatile.*
We own the parts that rarely change and define the system (the tool contracts,
routing, failure handling, normalization, output bounding, config, docs). We
*rent* provider access through the vendor's stable boundary (an official SDK or a
few lines of HTTP). And we isolate each volatile thing — every provider, every
fetch handler — in its own file so a change touches one file, not the system.
This is the maintainability guarantee.

## 2. Registered tool surface

Each everyday tool is one **evidence verb** an agent already thinks in:

| Tool | Verb | Returns | Evidence status |
|---|---|---|---|
| `web_search` | Serper lexical find | leads (title/url/snippet) | **lead** — fetch before citing |
| `web_fetch` | read | extracted page/repo/PDF/transcript | **fetched content** |
| `context7` | library docs | version-pinned docs | **fetched content** |
| `web_lookup` | catalog | skills / packages | **catalog** — inspect source before use |
| `web_answer` | orient | one quick Exa answer | **provisional synthesis** — fetch before relying |

The startup boundary is search, fetch, catalog, and orient — `web_search`, `web_fetch`, `web_lookup`, `web_answer`. `context7` (library docs) plus five provider specialists (`web_search_exa`, `web_search_x`, `web_search_tavily`, `web_answer_exa`, `web_answer_linkup`) are lazy via `web-stack`. Neither `web_search` nor `web_answer` falls back. `$mini-research` verifies W1/W2 claims and `$research` owns adaptive W3/W4 investigation. Standalone policy may expose all ten registrations.

## 3. The evidence model (the invariant every tool honors)

- **Lead** — a pointer. Not evidence until fetched. All search results are leads.
- **Catalog record** — structured package or skill discovery metadata; verify its
  source before using it as evidence of quality or fit.
- **Provider citation** — a provider-native answer citation, optionally with a provider-returned passage; it is not independently fetched evidence.
- **Fetched content** — bytes or documentation content we retrieved. Every `Source` retains `fetched: boolean` and names `evidenceStatus` as `lead|catalog|provider-citation|fetched`.
- **Synthesis** — a third-party model's answer. Treated as a lead or provider citation until the cited target is independently fetched.

The invariant is explicit: search and catalog output stay leads until an owned fetch retrieves the source; provider-returned citation text is `provider-citation` evidence, not independently fetched content. `web_answer` intentionally does not verify claims or run research; those workflows remain skill-owned so evidence selection can adapt after each source read.

## 4. The schemas — settled everyday core and evidence-bounded specialists

Every startup tool has a concise path. Five specialists retain evidence-bounded recipes. W12 constrained `web_search_tavily` and removed public Linkup Search after it failed the distinctive-value gate; `web_answer_linkup` and internal Linkup operations remain. Registration establishes no provider superiority, fallback role, or automatic diversity.

### web_search (Serper Search)
| Param | Default | Meaning |
|---|---|---|
| `query` | required | grounded Google/Serper lexical query; aliases `q`/`term` are accepted when equal, while conflicting values fail before dispatch |
| `country` | — | raw Serper `gl` locale/ranking code; the adapter validates, normalizes, and emits the receipt |

`web_search` always forces Serper once with no fallback and fixes 10 leads. It has no provider route, batch, compare, language, depth, typed dates, or typed domains. Answer boxes and knowledge graphs are unfetched leads in `details.serper`.

### web_search_tavily (constrained basic general search)
| Param | Default | Meaning |
|---|---|---|
| `query` | required | focused Tavily basic/general query for independent guides or regional discovery |
| `country` | — | full-name country ranking boost; provisionally supported by one matched India task |

`web_search_tavily` fixes basic depth, general topic, and 10 leads. W12 withheld advanced/topic/freshness/domain/chunk/exact-match controls because they did not pass matched public-parameter admission.

### web_fetch
| Param | Default | Meaning |
|---|---|---|
| `urls` | required | one URL string or array up to 10; page/download process each independently, while `map` maps every seed with separate scope and cache identity |
| `mode` | `page` | `page`: cache-first read; `download`: fresh fetch; `map`: same-origin discovery (literal path = recursive prefix, `*` = one segment, `**` = recursive; local scope filtering → dedupe → cap → scope-keyed cache); `crawl`: one bounded async subtree job with local scope/cap/dedupe/destination checks; `llm_answer`: exact retained reuse or one async generation for each page-content/objective/`query_terms` identity. |
| `objective` | — | selects an immutable intent-keyed `llm_answer`, or guides the separate single-page >5K no-quality-match rescue |
| `query_terms` | — | addition, never a replacement: selects an immutable `llm_answer` intent or adds top-5 matches with score + read range + 3 context lines, top-3 per source in batches, top-2 per retained crawl page; no-match sources show their cache path |
| `wait` | — | 0–60 second soft wait for a new crawl, `crawl:N` poll, or `llm_answer` job; crawl polls default to 30 seconds |
### web_answer
| Param | Default | Meaning |
|---|---|---|
| `question` | required | one question for a quick provisional Exa answer; aliases `q`/`query` are accepted |

`web_answer` makes one disclosed Exa attempt with no fallback. Its prose and citations are leads. Fetch decisive sources, use `$mini-research` for one-to-three-source verification, and use `$research` for comparisons, conflicts, hard constraints, or consequential decisions. Provider-native structured Exa and date/domain-bounded Linkup questions stay in their lazy specialists.
### web_lookup
A **source-discriminated union**: each `source` branch is a closed object, so Context7-only
fields are rejected on the catalog sources and vice versa (no shared flat bag).

| Param | Default | Meaning |
|---|---|---|
| `source` | required | `context7` (library docs) \| `skillsmp` (skills) \| `pi-packages` (Pi packages, discovery only) |
| `query` | required except exact Context7 ID | `query`/`q`/`term` is required for catalog search and name resolution; exact `context7.libraryId` or slash-shaped `library` may omit it and uses neutral provider query `overview` |
| `library` / `version` | context7 | library name to resolve; `version` pins the resolved ID via the official `@<version>` suffix |
| `page` | 1 | Context7 donor-compatible retrieval hint, or catalog result page |
| `limit` | catalog | results per page — **catalog sources only**; rejected on Context7 (no grounded meaning) |
| `context7` | — | closed options: `mode` (`docs` default \| `resolve`), `libraryId` (exact, bypasses resolution), `topic`, `fast`, `responseType` (`txt` default \| `json`) |
| `sortBy` | `stars` | SkillsMP only: `stars` \| `recent` sort |
| `category` | — | SkillsMP only: category slug filter |
| `occupation` | — | SkillsMP only: SOC occupation slug filter |
| `language` | — | SkillsMP only: detected Skill content-language ISO code; `mul` mixed, `und` undetermined |

Requested versions fail closed when no candidate advertises them. Version-miss guidance is rendered before generic ambiguity guidance and never recommends unpinned docs or automatic rank-one selection.

**Context7 evidence + retention.** `mode:"resolve"` returns **catalog** candidates (`fetched:false`,
no docs file). `mode:"docs"` resolves safely (a unique/defensible candidate only — no silent
first-candidate fallback), pins the requested version, and returns **fetched** documentation: a
bounded inline excerpt plus the complete raw body (txt, or the exact json) saved to
`.cache/web/docs/<doc>/full.md|json`; the printed docs path is the handle — the agent reads it with the read tool. Ambiguous or unversionable resolution
returns candidates and performs no docs request.

**SkillsMP / pi-packages evidence.** Catalog branches return **catalog** records (`fetched:false`,
**no docs file**) — discovery leads, never fetched evidence. The SkillsMP branch adds
`sortBy`/`category`/`occupation`/`language` filters and parses grounded `x-ratelimit-*` headers into
`details.rateLimits` (operational state, not a ranking signal). The API documentation does not define
a response-pagination object, so no pagination shape is inferred. A catalog record carries no claim
that the skill's source, license, or scripts are safe or compatible; inspect before installing.

**Why the search surface is provider/method explicit:** search providers expose different query languages, costs, result shapes, and failure modes. Packing them into one discriminated union duplicated specialist lanes and made the caller learn every provider at once. `web_search` is the owner-selected Serper naming exception; retained search specialists are `web_search_exa`, `web_search_x`, and constrained `web_search_tavily`. Public Linkup Search was removed after W12; its answer/fetch/internal operations retain their separate contracts.

Each method performs one named provider attempt without hidden fallback. `$research` owns deliberate diversity: another method runs only after naming the source class, language/region, chronology, semantic neighborhood, social provenance, or sequential-retrieval error it could expose. The historical typed multi-provider `requests[]` contract is superseded by [ADR 1.3](adr/0001-product-and-evidence/0003-core-search-and-provider-specialists.md) and retained only in stale [ADR 5.3](adr/0005-provider-evaluation-and-guidance/0003-multi-provider-search-schema.md).

Serper media/local/shopping/Scholar/Webpage operations, Tavily answer/raw/images/Research, Linkup structured Search/Research, Exa internal operations, and xAI model/video controls remain internal because their result shapes or evidence rights do not fit the current method interfaces. A later method tool requires its own retention evidence rather than flattening output into generic leads.

### The result envelope (every tool)
Structured model-facing values use official GCF generic-profile text in `content[0].text`; fetched Markdown/raw bodies and native answer prose remain text. Full provider-native JSON and operational detail remain in `details`:
```ts
details: {
  provider: string;        // who produced the result
  attempts: Attempt[];     // every provider tried, in order
  sources: Source[];       // each carries fetched + evidenceStatus
  fallbackOccurred: boolean;
  cached: boolean;
  warnings: string[];      // e.g. normalization, low yield, bounded fan-out
  responseId removed in schema v2 — retained content is recovered from the printed cache path
}
```
GCF changes representation, not evidence rights or provider structure. Structured search rows, catalogs, Context7 JSON, JSON pages, retained JSON, maps, and crawl manifests keep model-relevant fields; repeated byte-identical xAI synthesis is represented once. Output bounds remove only complete records and declare total/shown/omitted counts—never a partial GCF row or silent JSON fallback. Plain text is bounded by its owning fetch/answer contract; complete retained content remains recoverable from the printed cache path (`.cache/web/...`, read with the read tool).

### Normalized types (owned)
```ts
SearchResult { title, url, snippet, publishedAt?, score?, sourceType? }
Source       { url, title, passage?, fetched: boolean, evidenceStatus, provider }
Attempt      { provider, operation, status, durationMs, failureClass?, fallbackReason? }
```

### The internal adapter contract
Each provider exports its capabilities; routing selects on them:
```ts
AdapterCapability {
  id, operations[], credentials[], strengths[],   // [routing/config consumers tagged]
  modes?[], returns[], filters?[],
  timeoutMs, concurrency, fallbackEligible, provenance
}
```
**Named-consumer rule:** a field stays in this contract only if routing, config,
or tool dispatch actually reads it. Descriptive metadata with no consumer lives
in the provider's provenance doc, not here. This stops the contract bloating as
providers are added.

## 5. The stack, and why each piece

| Piece | Choice | Why |
|---|---|---|
| Language/runtime | TypeScript on Node ≥22.19 | host convention; runs via `node --experimental-strip-types` |
| Schemas | `typebox` | the host's schema standard; the schemas *are* the agent-facing contract |
| Provider access | official SDK where stable (`@tavily/core`, `exa-js`), direct HTTP where trivial (Serper ≈ 30 lines) | the SDK is the stable vendor boundary — we rent it, not re-implement it |
| Fetch pipeline | webclaw local binary (`-f llm`, single format) as universal text extractor + tavily escalation via js-needs DB v2 + 8 proven vertical shapes; native handlers own github/youtube/pdf; LLM lane = webclaw extract-prompt over deepseek direct | per [ADR 2.5](adr/0002-internal-architecture/0005-webclaw-extraction-redesign.md); `extract`/`linkup`/`llm_rich` params removed |
| Config | YAML (`yaml` pkg) | owner requires non-JSON; matches host convention (`tool.yaml`) |
| Persistence | `pi.appendEntry` + in-memory `Map` | the Pi-supported way to persist custom state across restarts |

## 6. File hierarchy, and why it is shaped this way

```
extensions/websift/
  package.json            # pi manifest (4 tools + skills), deps
  index.ts                # registers tools + commands; wires the registry; no provider logic
  README.md · THIRD_PARTY_NOTICES.md · CHANGELOG.md
  src/
    types.ts              # SearchResult, Source, Attempt, AdapterCapability, envelope
    config.ts             # web.yaml load + credential resolution
    destination-policy.ts  # initial DNS/IP policy + manual direct-fetch redirects
    registry.ts           # adapter metadata + provider selection
    routing.ts            # auto-select + explicit override + bounded fallback
    failures.ts           # loud failure classification
    output.ts             # lean text + details budget + response-ID store
    tools/                # the four schemas (the stable agent contract)
      web-search.ts web-fetch.ts web-answer.ts web-lookup.ts
    adapters/             # one thin file per provider
      serper.ts exa.ts tavily.ts linkup.ts xsearch.ts
      context7.ts skillsmp.ts pi-packages.ts
    fetch-handlers/       # generic fetch, one content type each (ported)
      http.ts github.ts pdf.ts youtube.ts
  skills/websift-setup/ · skills/websift-maintain/
  skills/mini-research/ · skills/research/   # planned by ADR 5.5; not active until safe cutover
  docs/                   # DESIGN.md, numbered adr/, upstreams/, ROADMAP.md
  tests/                  # mocked contract + FakeAdapter routing + fixtures
```

**Why this shape:** folders are *change boundaries made navigable.* `adapters/`
changes when a vendor API changes; `fetch-handlers/` changes when extraction
changes (a different reason — the pi-web-access upstream); `tools/` changes only
when the agent contract changes; the core files almost never. So "add a provider
= one file in `adapters/` + one registry entry + one provenance doc," and a
future agent's `explore(code, "exa adapter")` lands on exactly `adapters/exa.ts`.
A monolithic orchestrator (pi-web-access's ~24K-token `index.ts`) is precisely
what we avoid — it returns noise from every query and buries the edge you need.

## 7. Routing and fallback — how, and the reasoning

**Auto selection** (when `provider` is omitted) builds the candidate set in
order: **operation** (which adapters can do search/fetch/answer/lookup) →
**kind/strength match** (`kind:"social"`→xsearch, `kind:"academic"`→exa) →
**credentials present** (drop providers with no resolvable key) → **priority
policy** (configured order; explicitly *unmeasured* until focused comparisons justify
it). Then **first-fit**: try the top candidate, fall back only on an eligible
failure. **Not fan-out** — max two providers per ordinary request, bounded
timeout/concurrency, a session-local circuit-breaker/cooldown.

**Loud failure classes** — adapters fail loudly (a reshaped or empty response is
*classified*, not silently returned as garbage). This is what makes the
lightweight "document it, check occasionally" maintenance model work: a break
announces itself.

| Class | Falls back? | Why |
|---|---|---|
| unavailable / missing-credential | yes | another provider can serve |
| auth (401/403) | yes, then **disable provider for session** | don't hammer a bad key |
| rate-limited / timeout / network / 5xx | yes | transient; retry elsewhere |
| empty (**structural**: zero results or shape failure) | yes, if depth/strategy allows | soft failure |
| invalid-input | **no** | caller bug — surface it |
| aborted (user AbortSignal) | **no** | never a second billable call; cancel in-flight |
| explicit-provider failure | **no** unless opted in | the caller chose it |
| valid-but-disagrees | **no** | disagreement is data, not failure |

Two refinements that matter:
- **`empty` is structural, not a count threshold.** A low-but-nonzero result is
  `ok` + a `low_yield` warning — never an automatic fallback trigger. This keeps
  the threshold deterministic, not per-adapter judgment, and prevents
  double-spending on merely-thin results.
- **`Retry-After` is honored.** On a 429 we seed the cooldown from the server's
  `Retry-After` so we don't immediately re-select a throttled provider.

**Explicit override is always honored:** set `provider` and that engine is used
exactly, with no silent fallback (unless you opt in via `fallbackOnExplicit`).

**The reasoning in one line:** first-fit + loud failures + bounded attempts give
low cost/latency with no *silent* billable cascades, while never-fallback on
abort/invalid/policy/explicit ensures real problems are surfaced, not masked.
Cascade/`compare` fan-out exists but is an explicit opt-in against a hard
`maxFanOut` ceiling — never imposed. Provider *quality ranking* is deliberately
**deferred and never inferred**; results expose the *fact* of the choice
(`attempts[]`), and targeted comparison may later calibrate priority.

## 8. The fetch pipeline

`web_fetch` is a **dispatcher over pluggable content handlers**:
```
web_fetch(urls, mode?, objective?, query_terms?, wait?)
 ├─ urls "crawl:N"?  → poll a session-local crawl job (30s soft wait default)
 ├─ exact cache hit? → persistent .cache/web/<host>/ Markdown (no network)
 ├─ mode map         → webclaw --map, bounded same-host URL leads
 ├─ mode crawl       → bounded same-origin subtree job with local scope/cap/dedupe checks
 └─ page/download per URL:
      js-needs DB or rule v2 says shell?        → webclaw skipped, Tavily escalation
      GitHub → github.ts · YouTube → youtube.ts · PDF → pdf.ts ·
      npm/pypi/crates/docker/arxiv/HF/SO/HN    → webclaw typed vertical (JSON body)
      otherwise → webclaw -f llm extraction
      thin/empty result                        → one visible Tavily fallback
```
The fetch priority is `["webclaw", "tavily"]`: webclaw is the general page
extractor (static + typed verticals), Tavily is the JS/bot-walled escalation
lane. URL shape decides the handler; the js-needs DB remembers hosts that
returned shells so the next call escalates before spawning webclaw.

- **Persistent page cache:** exact page hits reuse `.cache/web/<host>/` indefinitely. Content at or below ~5,000 estimated tokens returns in full. Larger pages return the pi-nav smart-read source view (web metadata + pi-nav `pi_nav_read` outline over the cache file; pi-nav's own thresholds decide full vs outline; headers-only fallback when pi-nav is absent). `download` always re-fetches and updates the cache. YAML provenance redacts URL userinfo and secret-looking query values.
- **Targeted section retrieval:** `query_terms` is an addition, never a replacement — full content always shows first; ranked matches (score, exact line ranges, 3 context lines) overlay it. Single-URL top 5, multi-URL top 3 per source. No quality match → verdict-first line with the cache file path.
- **LLM lanes:** `mode:"llm_answer"` reads exact retained page bytes and either reuses a matching immutable sidecar or starts one asynchronous DeepSeek job. Sidecars are keyed by cache path, current content hash, objective, and `query_terms`; a different intent creates a separate artifact, while legacy `<cachePath>.summary.md` files remain exact-match readable. Separately, the deterministic single-URL rescue may call the LLM only when a cached/fetched page exceeds 5K tokens and `query_terms` has no/weak match below `WEAK_SCORE_FLOOR` 2.0.
- **Provider deadline and degradation:** webclaw spawn failures and js-needs hits route to Tavily through the same fallback machinery as search. Failure is reported honestly; ordinary source output remains authoritative.
- **Bounded site operations:** `map` retains each seed's URL list while returning leads only. `crawl` starts one session-local bounded subtree job and enforces same-origin scope, include/exclude rules, dedupe, page cap, destination policy, and shutdown cancellation before cache writes.
- **Outbound destination boundary:** `src/destination-policy.ts` rejects any loopback/private/link-local/reserved/metadata address before direct request or subprocess. Direct fetches pin an approved resolved address and manually validate every redirect. URL-bearing subprocesses fail closed unless the binary reports a version in the reviewed range 0.6.16 <= v < 0.7.0 (ADR-002.005 revision 2026-09-22); webclaw in that range independently validates initial URLs, all DNS answers, connection-time resolution, and each redirect. Webclaw/crawl-reported effective URLs re-enter extension policy before attribution or cache writes. Exact host-owned `network.allowPrivateHosts` entries permit only loopback/RFC1918/ULA local development through the direct lane. Effective URLs own evidence attribution; requested URLs remain visible and own cache identity.
- **GitHub/PDF/YouTube handlers are implemented and live-exercised; their optional runtimes remain lazy** (`git`/optional `gh`, `unpdf`, `yt-dlp`). They report `unavailable` if absent and never block base install. There is no `video.ts`/ffmpeg baseline. PDF transport shares the 5 MB/default timeout guard before parsing and extracts at most 100 pages; GitHub repos over `maxRepoSizeMB` use the bounded API view; YouTube captions preserve minute locators and degrade to metadata-only when unavailable.
- **No response-id session store:** the `responseId` mechanism was removed; Context7 inline docs save their body to `.cache/web/docs/<doc>/full.<md|json>` and the result names that path.
- **Divergence, on record:** webclaw is spawned user-side (AGPL-3.0, no linking); the extension never bundles or distributes it. The accepted host/path table and priority are evidence-dated; [`ADR 2.2`](adr/0002-internal-architecture/0002-routing-and-failover.md) owns routing, [`ADR 2.5`](adr/0002-internal-architecture/0005-webclaw-extraction-redesign.md) owns the webclaw extraction design.

## 9. Config and credentials — env var or hardcoded key

**One YAML configuration file, `web.yaml`**, located by `PI_CODING_AGENT_DIR` → `$XDG_CONFIG_HOME/pi` → `~/.pi`. It normally contains non-secret policy but may contain a plaintext inline `apiKey`. The user-invoked `/web-setup` masked command is the only extension surface that receives a value: it may write one inline key or one assignment in its command-owned shell secret file. `/skill:websift-setup` and the model never receive values. Malformed YAML degrades to defaults with `config_parse_error`; parsed config is cached until mtime changes.

**Resolution order** for each provider (first hit wins):
1. **inline `apiKey` in `web.yaml`** (the hardcoded option) —
2. **`process.env[<custom env name>]`** (if `env:` overridden) —
3. **`process.env[<default name>]`** (`EXA_API_KEY`, `TAVILY_API_KEY`, …) —
4. otherwise the provider is **disabled** for the session.

```yaml
providers:
  serper: { enabled: true }                        # → SERPER_API_KEY (env)
  exa:    { enabled: true, env: MY_EXA_TOKEN }     # → custom env name
  tavily: { enabled: true, apiKey: "tvly-..." }    # → hardcoded inline key
priority:                                          # starting policy, unmeasured
  search: [serper, exa, tavily, linkup]
  fetch:  [webclaw, tavily]
  answer: [exa, linkup]
defaults: { depth: standard, strategy: single, maxAttempts: 2 }
limits:   { timeoutMs: 20000, concurrency: 3, inlineChars: 12000, maxFanOut: 4 }
```

`process.env` is shell-agnostic once Pi inherits it. When a recognized variable is absent, `/web-setup` may scan a bounded Fish/Zsh/Bash startup-file set locally and report only assignment names and source paths—never values or evaluated content. Masked persistence writes a command-owned `0600` secret file; Fish uses `conf.d`, while Zsh/Bash receive one shell-quoted guarded loader line with existing rc permissions preserved. Unsafe targets and CR/LF/NUL values are rejected, no secret backup is created, and partial loader failure is reported honestly. Environment changes need a shell/Pi restart.

Inline masked entry still mutates exactly `providers.<id>.apiKey`, preserves comments, refuses malformed/symlink/non-regular targets, and reloads on `web.yaml` mtime. Environment inheritance remains the robust default; plaintext inline and shell-file persistence are explicit single-user convenience choices.

## 10. Evolution — adding providers, parameters, handlers

- **Add a provider = one adapter file + one registry entry + one provenance
  doc.** The definition of done *requires* that no tool or routing logic
  changes — if it does, the contract leaked and we fix the contract. Each new
  provider is grounded by reading its installed source first (no inference).
  A provider with an account/credential surface also adds one declarative
  entry to `src/provider-control.ts::PROVIDER_PAGES` — setup navigation/status
  metadata (official convenience links, local/no-account flag), not routing or
  tool logic.
- **The contract can't bloat:** the named-consumer rule keeps `AdapterCapability`
  to fields something actually reads.
- **Public schemas are stable:** tool/param names are immutable once shipped; new
  params are additive with a safe default; removal/rename is a major version.
  Deprecated params fire a `details.warnings` note and are removed only at a
  major bump.
- **Versioning of `@alehdezp/websift`:** patch = upstream parity/bugfix; minor = new
  provider/handler/additive param/`details` key; major = breaking public schema.
  `0.x` until the full public surface and Slice-1 providers are stable.
- **Upstream tracking (lightweight, human-reviewed):** each ported source has a
  provenance doc pinning the exact git ref; `websift-maintain` runs a mapped-path-only
  drift check (`npm view` + `git diff <ref>..<tag> -- <mapped-file>`), reports
  affected local files, and a human decides port-or-skip. A `CHANGELOG.md` tags
  every change `[ported]`/`[owned]`/`[fix]`. The four-part silent-drift defense:
  loud failures + mapped-path diff + pinned ref + `[ported]` CHANGELOG line. No
  auto-merge, ever.
- **Test gates:** a `FakeAdapter` that throws a given failure class proves the
  routing/fallback chain deterministically; a per-provider fixture corpus proves
  normalization; a shared no-secret-in-output gate runs against every adapter;
  registration asserts exactly nine tools with no duplicates; `tsc --noEmit` guards
  the schemas as the public contract.

## 11. Setup, the `/web-setup` command, and maintenance

- **`/web-setup`** — local command, not a fifth model tool. Opening makes zero network calls and reports credential status. A separate presence-only diagnostic checks bounded Fish/Zsh/Bash files for recognized exported assignment names/paths. Masked entry writes one inline key or one command-owned shell assignment under the secret-safe mode/symlink/no-backup contract. Official account/key/billing/docs pages are navigation only. One-provider liveness is explicit, confirm-gated, direct, and content-free; it reports operation/status/failure class/latency, not comparative quality. Tavily usage and Linkup balance remain the only grounded native quota checks.
- **`/skill:websift-setup`** — secret-blind guided/headless review: config and current-process presence, command-reported shell status, operation coverage, account links, non-secret policy, and restart guidance. It never reads raw private shell files with model tools, handles a value, or runs an unapproved network call.
- **`/web-doctor`** — read-only, network-free capability + presence report.
- **`/skill:websift-maintain`** — failure and provider-drift owner: use failure class and provenance, re-port only the affected module, run owning proof, then update current docs.

Setup distinguishes local readiness, one-operation live compatibility, Tavily/Linkup quota visibility, and accepted comparative quality. Only focused comparative evidence plus interactive owner review may choose provider winners or final ordering.

## 12. What is settled vs pending

- **Settled and validated:** lead/catalog/provider-citation/fetched evidence rights, GCF for model-visible structured provider JSON, file hierarchy, config/credential resolution, fetch-handler pipeline, and human-reviewed upkeep.
- **Search method split:** `web_search` is Serper-only. `web_search_exa` and `web_search_x` retain mastered scoped recipes; W12 constrained `web_search_tavily` to query/full-name-country basic search and removed public Linkup Search. The removed multi-provider `requests[]` surface is historical, not a fallback path.
- **Answer methods:** `web_answer` is one provisional Exa orientation attempt; `web_answer_exa` and `web_answer_linkup` expose provider-native answer controls. Verification and research are skill-owned.
- **Grounded by source read:** every shipped adapter and the pi-web-access fetch donor.
- **Native fetch baseline:** GitHub/PDF/model-free YouTube are live-exercised under ADR-002.003; PDFs preserve page markers and guarded transport, YouTube captions preserve minute locators, and generic visual-video understanding remains an unresolved owner-gated capability question.
- **Implementation status:** current registration contains four startup tools plus five provider/method specialists. Aggregate policy keeps the startup four visible and specialists lazy-discoverable; search/catalog/structured-fetch output uses pinned official GCF `2.4.0`; answer prose remains text.
- **Provider diversity is not a ranking.** Retain a method only when mastered calls show distinctive decision-changing evidence, a unique source class, or reproduced constraint/cost value. See [`docs/WORK-PLAN.md`](WORK-PLAN.md) W8c.
- **Migration runtime fact:** `pi-web-access` already registers `web_search`, so
  `tool.yaml` exclusion cannot prevent the registration-time collision. Slice
  proofs use `pi -ne -e extensions/websift/index.ts`; final cutover must disable the
  old extension registration while leaving its installed package available for
  rollback until the separate stopped-Pi migration.

## 13. Vendoring upstream source and evolving it

For inspection and evolution, the source of every upstream we port from or derive
a contract from is **cloned locally into `vendor/`** — which is **gitignored**.
`vendor/` is a *maintainer* workspace, **not** part of what an end user installs:
the extension's real runtime dependencies come from `package.json` via npm. It is
reproducible on any maintainer machine from the committed `vendor.manifest.json`:

```
npm run vendor:fetch        # clone/refresh every upstream at its pinned ref
```

The manifest records, per source: package, version, repo URL, pinned ref, `role`
— **`port`** (we copy code: pi-web-access) or **`reference`** (we inspect it to
derive an adapter while the runtime uses the vendor's npm SDK: the provider
packages) — and the `mappedPaths` we use. First-party code (serper/skillsmp) is
not vendored; it is absorbed from the sibling extensions.

**Evolution (git-pull, what-changed):** bump the ref in the manifest →
`vendor:fetch` → `git -C vendor/<name> diff <old>..<new> -- <mappedPaths>` (see
exactly what changed, only in the paths we use) → decide port-or-skip → port →
update the provenance doc + `CHANGELOG.md` (`[ported]`). `/skill:websift-maintain`
orchestrates it. See [`ADR 4.3 — vendored inspection, evolution, and installability`](adr/0004-operations-and-evolution/0003-vendoring-evolution-install.md).

## 14. Installing on another computer

Designed for installation on someone else's machine, not tied to the maintainer's checkout. The [release journey](../../../docs/publication-readiness.md#15-no-immutable-ref-installation-proof-yet) is still unproved:

- **Distribution:** a jeito sub-extension installed with the aggregate once an immutable Git release and prepared Core payload exist, or separately from a local checkout. Pi Git sources cannot target this monorepo's subdirectory. The [websift installation section](../README.md#installation-and-first-use) owns the current workspace preparation and registration steps; no standalone npm release has been selected.
- **Runtime deps declared, not vendored:** `package.json` lists everything it runs
  on (typebox, yaml, readability, linkedom, turndown, p-limit, @tavily/core; unpdf
  optional); `npm install` fetches them anywhere. **`vendor/` is not required to
  install or run** — maintainer-only, reproducible via `vendor:fetch`.
- **No machine-specific assumptions:** no hardcoded home paths (config resolves via
  `PI_CODING_AGENT_DIR` → `XDG_CONFIG_HOME/pi` → `~/.pi`); upstreams referenced by
  URL, not local path.
- **Optional binaries lazy:** unpdf/yt-dlp (plus `git`/optional `gh` for GitHub)
  handler reports `unavailable`. Base install never requires them.
- **Fresh-machine sequence:** install → restart Pi → `/skill:websift-setup` read-only review → `/web-setup` masked local key persistence and optional confirmed liveness/usage → restart after environment changes. Missing optional providers never warn at boot.

## 15. What we take from each upstream — port vs call (not wrap)

The approach is **not** "wrap the existing tools" (impossible — Pi cannot execute
another registered tool) and **not** uniform. It splits on one question: *is there
a stable vendor boundary to rent?* **Yes → call it (take zero code). No → port the
proven code (take only the modules we need, adapted).** We never wrap a registered
tool and never import an upstream package wholesale (that drags in the security
layer and out-of-scope providers we dropped). "Minimal" means minimal coupling and
baggage, not minimal lines written.

| Upstream | We take at runtime | How | Why |
|---|---|---|---|
| Serper | nothing (call the API) | own ~30-line HTTP adapter → `google.serper.dev` | trivial API, no SDK needed |
| Exa (`@capyup/pi-exa`) | nothing from the extension | own thin adapter → official `exa-js` SDK | the SDK is the stable boundary — rent it |
| Tavily (`@weihan28/pi-tavily`) | nothing from the extension | own thin adapter → official `@tavily/core` SDK | same |
| Linkup / xsearch / Context7 / SkillsMP / pi-package-search | nothing from the extensions | own thin adapter → their SDK/HTTP API | same |
| **pi-web-access** | **the actual code (ported)** | selective port of `extract`/`storage`/`fetch-params`/handlers, adapted | **no vendor SDK for content extraction — the value *is* the engineering** |

**Why not import pi-web-access instead of porting:** its `extract.ts` imports its
whole module graph — `ssrf-protection.ts` (dropped), `gemini`/`parallel`/
`perplexity` (out of scope), activity/config/peer-deps. Importing it pulls in
everything we removed; `extractContent` is a private internal, not a stable
library API. Selective porting takes *less* and lets us make the settled
divergences (plain `fetch`, trimmed branches).

**Runtime independence:** the extension depends only on npm packages (`typebox`,
`yaml`, `@mozilla/readability`, `linkedom`, `turndown`, `@tavily/core`, `exa-js`)
plus our own ported code. It requires **none** of the old extensions at runtime —
they can be fully uninstalled (the migration). Vendored copies are
reference/evolution material, never imported.
