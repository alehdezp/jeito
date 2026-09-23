---
title: "Provenance — native fetch donor and apprenticeship"
description: "pi-web-access fetch-pipeline provenance plus live Native HTML, GitHub, PDF, YouTube, resource-bound, and locator findings."
tags: [jeito, web, provenance, pi-web-access, fetch, porting, mit, apprenticeship]
created: 2026-07-27
updated: 2026-08-01
status: active
owns: "pi-web-access porting provenance"
audience: contributor
code: [src/fetch-handlers/dispatch.ts, src/fetch-handlers/http.ts, src/fetch-handlers/github.ts, src/fetch-handlers/pdf.ts, src/fetch-handlers/youtube.ts, src/fetch-handlers/utils.ts, src/output.ts]
related: [docs/upstreams/README.md, docs/adr/0002-internal-architecture/0003-fetch-pipeline.md, THIRD_PARTY_NOTICES.md]
---

# pi-web-access — fetch pipeline donor

- **Package:** `pi-web-access`
- **Repository:** <https://github.com/nicobailon/pi-web-access>
- **Reviewed version:** 0.13.0 (installed at
  `~/.pi/agent/npm/node_modules/pi-web-access`; current npm was 0.14.0 at review —
  first drift fixture)
- **License:** MIT (author: Nico Bailon). Text at [#license](#license).
- **Grounded by:** reading `extract.ts`, `storage.ts`, `youtube-extract.ts`,
  `fetch-params.ts`, `utils.ts`, `package.json` (2026-07-27).

## Behavior imported

| Upstream file | Ported to | What we take |
|---|---|---|
| `extract.ts` (~704 lines) | `src/fetch-handlers/http.ts` (+ later handlers) | The `extractContent(url)` URL-type dispatcher; `extractViaHttp` native HTTP path; Readability+Turndown extraction; content-type detection; title extraction; `MIN_USEFUL_CONTENT`; `NON_RECOVERABLE_ERRORS`. The upstream `isLikelyJSRendered` heuristic was NOT ported. |
| `storage.ts` (~72 lines) | `src/output.ts` | In-memory `Map` response-ID store: `generateId`/`storeResult`/`getResult`, 1h TTL, `restoreFromSession` via Pi session branch. |
| `fetch-params.ts` (~67 lines) | `src/tools/web-fetch.ts` (normalization) | `normalizeFetchContentParams` url/urls/options normalization. |
| `utils.ts` | `src/failures.ts`, `src/fetch-handlers/*` | `isTimeoutError`, `readExecError`, `formatSeconds`; and the config-dir resolution pattern (`PI_CODING_AGENT_DIR` → `XDG/pi` → `~/.pi`). The upstream `mapFfmpegError` helper was not kept (no ffmpeg handler exists in this project). |
| `github-extract.ts` + `github-api.ts` | `src/fetch-handlers/github.ts` | `parseGitHubUrl`; shallow `git`/`gh` clone with size-gated `gh`-API fallback; tree/dir/README/file rendering; binary + noise-dir filtering; clone cache. `activityMonitor` removed; clone config read from `web.yaml` `github:`. |
| `pdf-extract.ts` | `src/fetch-handlers/pdf.ts` | `isPDF` (extension/content-type); `unpdf` page-by-page text → markdown with metadata header. Returns content directly instead of writing to `~/Downloads`. `unpdf` lazy-loaded (optional dep). |
| `youtube-extract.ts` (exec pattern only) | `src/fetch-handlers/youtube.ts` | `yt-dlp` exec + error mapping. **Divergence:** captions + metadata returned directly — the Gemini/Perplexity stream-analysis branches are NOT ported (no model dependency). |
| `video-extract.ts`, `rsc-extract.ts` | not yet ported | Deferred: video-file analysis is model-dependent (ffmpeg frames need a model to describe); RSC is out of scope. |

Runtime deps adopted for the text path: `@mozilla/readability`, `linkedom`,
`turndown`, `p-limit` (and `unpdf` as a lazy optional dep for PDF). The GitHub and
YouTube handlers shell out to lazily-detected binaries (`git`, optional `gh`,
`yt-dlp`); the plain HTTP/PDF path uses no native binaries.

## Behavior deliberately omitted

- **`index.ts` (~24K) and `curator-page.ts`/`curator-server.ts` (~32K):** the
  orchestrator + curator/UI monolith. Not the desired product boundary.
- **`ssrf-protection.ts`:** URL validation / SSRF. **Excluded by owner decision**
  (no security engineering). Its `fetchRemoteUrl`/`validateRemoteUrl` are replaced
  by plain `fetch` in `http.ts`.
- **Jina Reader fallback** (`extractWithJinaReader`, `r.jina.ai`) and the
  **Gemini / Parallel / Perplexity extraction branches**
  (`gemini-url-context.ts`, `parallel.ts`, `perplexity.ts`): those providers are
  out of scope; the native Readability path is kept.
- **Search provider modules** (`exa.ts`, `tavily.ts`, `brave.ts`,
  `openai-search.ts`, `gemini-search.ts`): we use our own adapters, not these.
- **`chrome-cookies.ts`, `activity.ts`, `summary-*.ts`, `banner.png`,
  `*.mp4`:** UI/cookies/summary/demo assets, not needed.
- **`video-extract.ts` (deferred):** local/YouTube video *file* analysis needs a
  model to describe ffmpeg-extracted frames; without one it produces no usable text,
  so it is not ported. YouTube *captions* are handled model-free in `youtube.ts`.
- **`rsc-extract.ts`:** React-Server-Component extraction, out of scope.

## Local divergences and reasons

1. **Plain `fetch` replaces `fetchRemoteUrl`/`validateRemoteUrl`.** Reason:
   security dropped by owner decision. Retained robustness bounds (scope, not
   security): `http(s)`-only, response size cap, `limits.timeoutMs`. Stated inline
   in `http.ts`.
2. **Own result types** instead of importing `SearchResult` from `perplexity.ts`
   (which `storage.ts` couples to). Reason: avoid coupling to an omitted module.
3. **Trimmed extraction fallbacks** (Jina/Gemini/Parallel/Perplexity). Reason:
   those providers excluded; keeps the port lean.

## Focused Native fetch recipes

Live calls on 2026-08-01 exercised every dispatched source class: structured React HTML (24,287 characters, 832 ms), Linkup documentation (2,772 characters, 439 ms), Exa SDK GitHub root and package blob (8,174/2,779 characters, about 4 s each), BrowseComp PDF (30,066 characters across 11 page-located pages, 440 ms), and an 18:43 Cloudflare Developers YouTube transcript (18,721 characters, 6.7 s, 19 minute locators after the locator correction). These are scoped runtime observations, not universal latency guarantees.

Native Readability fully extracted the sampled Linkup documentation, so that URL does not justify rendered fetch. Use Linkup `renderJs:true` only after Native or static Linkup output demonstrably lacks required content. GitHub extraction is preferable when repository structure or exact files matter; PDF page markers and YouTube minute headings preserve inspectable locators. Public page fetch returns a bounded inline excerpt and retains the complete body by response ID. Query-aware passage selection was explicitly deferred by `alehdezp` on 2026-08-01.

The live PDF run exposed a real bounds bug: `.pdf` URLs were fetched directly in `dispatch.ts`, bypassing `http.ts`'s timeout and `maxBytes` checks. PDF transport now always flows through `fetchHttp`, which detects both extension and content type before parsing. One focused test proves the byte and timeout guards fire before `unpdf`.

## Owning tests

- `tests/fetch-handlers/http.test.mjs` — extraction + content-type routing
  (adapted from upstream `test/fetch-params.test.mjs`, `test/pdf-extract.test.mjs`
  patterns as relevant).
- `tests/output.test.mjs` — response-ID store behavior.
- `tests/fetch-handlers/handlers.test.mjs` — GitHub/YouTube URL parsing, PDF
  detection, VTT caption cleanup, and dispatcher routing.

## Upkeep

- **Last reviewed:** 2026-07-28 (0.13.0, resolved SHA `7bdc30a65cf7`).
- **Next comparison:** `npm view pi-web-access version`; if newer, diff only the
  mapped files above (`extract.ts`, `storage.ts`, `fetch-params.ts`, `utils.ts`,
  and any handler we have ported) via `/skill:websift-maintain`. Do not diff the
  curator/UI or security modules — we do not port them.
- **Known drift:** 0.13.0 → 0.14.0 at review; 0.14.0 adds SearXNG, SERPdive,
  AnySearch, Firecrawl, source-check, credential-source modules (per design
  research) — none are in our ported set; review only if a mapped file changed.

## License

Standard MIT text; copyright holder recorded from `package.json` author. The
authoritative text is the `LICENSE` file in `pi-web-access` 0.13.0 — copy it
verbatim into this section during the Slice-1 port.

```
MIT License

Copyright (c) Nico Bailon (pi-web-access)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Vendored snapshot

- **Location:** `vendor/pi-web-access/` (gitignored; `npm run vendor:fetch`).
- **Role:** `port` — we copy code from it (the fetch-pipeline donor).
- **Pinned ref:** `v0.13.0` (npm 0.13.0). Resolved commit SHA: `7bdc30a65cf7`
  (tag `v0.13.0` resolved exactly; vendored 2026-07-27).
- **Mapped paths:** `extract.ts`, `storage.ts`, `fetch-params.ts`, `utils.ts`,
  `github-extract.ts`, `pdf-extract.ts`, `youtube-extract.ts`, `video-extract.ts`,
  `rsc-extract.ts`.
- **Update:** bump the ref in `vendor.manifest.json`; `npm run vendor:fetch`; then
  `git -C vendor/pi-web-access diff <old>..<new> -- <mapped paths>`; port the
  affected module and update this doc + `CHANGELOG.md`.
