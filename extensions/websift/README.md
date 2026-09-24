# websift

![websift banner: the name over "Read less, keep the rest" with a scan line sweeping a saved page.](docs/images/v2-banner.svg)

**websift keeps the source and narrows the reading, so a claim stays answerable to its page.** Both settled research habits lose the evidence: raw pages flood the working context with text the task never needed, and a fluent summary hides the qualification that changes the conclusion. websift saves extracted pages as local files, returns a full small page or focused passages from a large one, and lets the rest be read later without another fetch.

Search hits are leads; generated answers carry provider citations; fetched passages can be checked against claims. The distinction matters more than how many results a search returns.

The question picks the method. Exact terms, unfamiliar terminology, first-hand posts, region-specific coverage and installed library versions call for different searches and version-pinned docs, and no single provider silently becomes the answer to every question. One known page may need only a plain fetch; a longer investigation benefits from saved material and a deliberate next method.

## Search by wording, meaning or source

Serper matches exact wording, Exa covers lexical and semantic phrasing, X search adds account and date controls for first-hand posts, and Tavily adds a region-ranked index. Each search names its provider and makes one attempt.

After examining the results, the agent can choose another method to fill a specific gap — unfamiliar terminology, a missing first-hand source — instead of repeating the same search elsewhere. The extension does not automatically run every provider.

Choosing the collection matters too. `context7` resolves a library and retrieves documentation for an advertised version, so the request can target the API being used. An unavailable version returns candidates instead of silently serving the latest; returned source references still need checking for release mismatches. `web_lookup` searches npm packages or SkillsMP's agent skills when the question is whether a usable implementation already exists. Those records identify candidates, not their safety or suitability, and lookup installs nothing.

## Narrow the reading, keep the source

websift separates the text it retains from the text it returns: `web_fetch` saves the extracted page and supplies a local path alongside its reading. Returning whole pages would put text into the conversation before its relevance is clear; a generated summary makes a different selection and cannot expose a qualification it omitted.

Smaller pages can appear in full. On large pages, search terms select up to five matching passages, with locations for further inspection. Matching is lexical and takes headings into account. It can miss different terminology or a condition elsewhere in the page; a high-ranked passage is a starting point, not proof of complete coverage. The retained file makes it possible to examine that condition without retrieving the page again.

![Mechanism diagram: a search hit is a lead, a generated answer carries provider citations only, and a fetched passage is checkable text; all three check back against the retained page, which holds the first excerpt inside a wider range a later local read can open without a second fetch.](docs/images/source-check.svg)

Downloads and bounded crawls extend this from individual pages to a collection. A crawl records the titles, URLs and local paths of the pages it collected; repository downloads retain a shallow clone for code inspection. Ordinary file tools can search this material across follow-up questions. The collection consists of files and navigation metadata, with no automatic semantic index or guarantee of whole-site coverage.

Retention also means deciding when to refresh. An ordinary page read reuses the saved copy without checking the remote site; download refreshes an ordinary page, while repository downloads reuse an existing clone within the session. Reading more can recover text omitted from the response, but cannot recover material the extractor never captured. The [fetch reference](docs/DESIGN.md#web_fetch) covers selection limits and retrieval modes.

## Generated answers help orient the investigation

`web_answer` returns a preliminary Exa explanation with source links. That can establish terminology or possible approaches before a larger investigation, without requiring several separate page reads just to get oriented. Exa and Linkup answer specialists also support more constrained questions and structured results. Their citations remain provider citations until the linked material is retrieved independently; fluent prose and a list of URLs do not establish that a claim is supported.

websift can also generate an answer about a retained page. It saves that answer separately from the source and reuses it only for matching page content and intent. The distinction matters when checking a quotation or a consequential claim: the extracted text remains available for comparison with the model's interpretation. Both explicit page answers and a separate automatic rescue path can send material to DeepSeek; see [external services and model calls](#external-services-and-model-calls) before enabling that access.

The supplied [mini-research](skills/mini-research/SKILL.md) and [research](skills/research/SKILL.md) skills guide source selection and checking across these capabilities. They are instructions for the agent, not a verification system. The larger skill calls for substantial investigation and is not a low-cost default.

For one known page, a download and ordinary file search may be sufficient. websift's additional integration is useful when the work involves changing search methods and checking several collected sources. Adopting it means configuring the services needed and maintaining the retained files; further investigation can require more requests and waiting.

## External services and model calls

Queries and requested content can go to external services, with independent credentials, quotas and charges. Page extraction can try another eligible extractor within a configured limit and reports those attempts. This differs from search and answer tools, which do not switch providers automatically. Neither an extension attempt count nor a reported cost caps the provider's internal work or total billing.

Fetching can also invoke DeepSeek automatically. With `query_terms`, weak or missing matches on a single page above 5,000 estimated tokens can trigger a webclaw model call when a DeepSeek key is available. This rescue reads the URL again, so its input may differ from the retained page; it is separate from the reported extractor attempts. Explicit `mode:"llm_answer"` uses retained text, and supplying an objective can require two generation calls. Both paths can incur charges. They read the DeepSeek key from Pi's `auth.json`, separately from the provider configuration below.

Extracted pages persist in `.cache/web/`; keep that directory out of commits and treat it as stored research material. Destination checks reject private and internal addresses by default, with a configurable local-development exception. Network restrictions and evidence labels do not make retrieved text safe to follow as instructions.

## Installation and first use

Requirements: Node.js `>=22.19.0` and Pi `>=0.82.1`. Use the [selected-extension installation flow](../../docs/getting-started.md#install-one-extension-from-a-checkout). The command chain stops if npm preparation fails:

```bash
cd /absolute/path/to/jeito &&
npm install --omit=dev \
  --workspace @alehdezp/websift \
  --include-workspace-root=false &&
pi install "$PWD/extensions/websift"
```

Do not register standalone websift beside the aggregate or load a second copy of its research skills. Restart Pi after registration. Standalone websift registers all ten tools; the shipped Tooltap configuration limits startup visibility to four. Installing websift alone does not apply that host configuration.

Additional prerequisites depend on the operation:

- webclaw URL subprocesses require **webclaw >= 0.6.16 and < 0.7.0** under the current version guard (the reviewed security floor through the 0.x contract line — e.g. Homebrew 0.6.23 is accepted). npm does not install it. This affects webclaw extraction, map/crawl and model-assisted operations, not search or every native fetch handler. `/web-doctor` reports version conformance.
- YouTube captions require `yt-dlp`; repository retrieval uses Git and, for some GitHub operations, `gh`.
- PDF text extraction uses the optional `unpdf` dependency.

Start with `/web-doctor` to inspect local readiness. `/web-setup` provides masked credential entry and provider controls; never paste keys into the conversation. Opening setup makes no network calls. Explicit provider liveness checks require confirmation and may consume credits; local health alone does not establish live compatibility.

For a first source read after setup, ask Pi to retrieve a public documentation page you already know and identify the passage supporting one claim. A successful `web_fetch` page result includes a `Cache:` path for further inspection. If a provider or prerequisite is unavailable, use the reported failure and `/web-doctor` to identify what is missing before retrying. Search and model-assisted reading depend on the configured services and may incur charges.

Provider credentials come from environment variables or host-owned `web.yaml`. Its location is `$PI_CODING_AGENT_DIR/web.yaml`, otherwise `$XDG_CONFIG_HOME/pi/web.yaml`, otherwise `~/.pi/web.yaml`. Inline keys take precedence over environment variables. The [setup skill](skills/websift-setup/SKILL.md) explains configuration and credential handling.

## Attribution and reference

Providers supply the search indexes and generated answers. jeito integrates their distinct controls with source status, retained material, bounded readings and recovery locations in Pi. Portions of fetching and output handling are adapted from Nico Bailon's MIT-licensed `pi-web-access` 0.13.0. [Third-party notices](THIRD_PARTY_NOTICES.md) also credit the Tavily adapter reference, GCF codec and other distributed dependencies; [upstream provenance](docs/upstreams/README.md) records their versions and licenses.

The [documentation index](docs/README.md) routes product, provider and operation questions. The [design overview](docs/DESIGN.md) describes the integrated architecture and tool surface; the [decision records](docs/adr/README.md) preserve the reasons and distinguish accepted work from proposals and superseded choices.

websift remains private to prevent accidental npm publication; its first-party code is [MIT licensed](LICENSE) and the package is pre-release. Local development checks are:

```bash
npm run typecheck --workspace @alehdezp/websift
npm run test --workspace @alehdezp/websift
```

These checks exercise local contracts. They do not establish provider availability, source quality or a tested platform matrix.
