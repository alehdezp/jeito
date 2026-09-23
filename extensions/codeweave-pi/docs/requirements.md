---
title: "jeito codeweave-pi binding product and delivery contract"
description: "Binding codeweave-pi product behavior, progressive setup guidance for unfamiliar users, lifecycle ownership, credential safety, machine and project configuration, nested-project isolation, backend maintenance, delivery acceptance, and proof boundaries."
tags: [jeito-codeweave-pi, requirements, prd, delivery, progressive-setup, onboarding, per-project-contract, nested-folders, update-policy, testing-discipline, minimal-design, openrouter, opencode-go]
created: 2026-07-28
updated: 2026-09-21
status: active
owns: "The binding product objective, per-project contract, delivery contract, credential model, onboarding/setup behavior, nested-folder rules, backend update policies, testing/fix discipline, and the minimal-design boundary"
audience: mixed
code: [scripts/machine-snapshot.mjs, src/core/provider-registry.ts, src/core/navigation-config.ts::resolvePreparedLane, src/core/navigation-corpus-policy.ts::compileNavigationCorpusPolicy, index.ts::jeitoCodeweavePiExtension]
related: [docs/current-truth.md, docs/testing-redesign.md, docs/harness-doctrine.md, docs/automatic-workflow.md, docs/decisions/r5-crg-clean-break.md, AGENTS.md]
---

# Binding product and delivery contract

## Authority of this document

This file owns intended product behavior and release obligations. Current source and focused execution own implementation facts; [`current-truth.md`](current-truth.md) owns the concise implementation-status summary; [`testing-redesign.md`](testing-redesign.md) owns execution order and evidence gates. If any source, test, skill, plan, or document conflicts with this contract, stop and record the contradiction—never hide observed behavior because this file says something else, and never silently change the contract to match an accidental implementation.

`docs/plan/` is investigation history unless an active canonical plan explicitly says otherwise. A change to product objectives, supported targets, provider defaults, public delivery, destructive migration, or release acceptance requires explicit package-owner approval. Ordinary implementation may clarify wording but may not weaken these requirements.

**Successor boundary, recovered September 11:** Part 1's thin-coordinator/three-backend ownership describes the legacy R-series product, not a veto of the user-selected coherent CodeGraph-derived successor and ranked-grep-centered output. The selected goal (local-only work record) and decision/provenance record (local-only work record) preserve that explicit change and its current recovery-only freeze. This page is not the missing approved ranked/fuzzy specification. Its unchanged privacy, query-time purity, user-state and release obligations still apply; conflicting root/default rules must be reconciled explicitly before activation, not erased or silently followed.

---

# Part 1 — How we work (binding rules)

## The minimal-design rule

This extension is a **thin, reliable coordinator** around three existing backends—Core (the CodeGraph-backed indexed code graph), QMD (docs retrieval), and Graphify (semantic graph). Those backends own parsing, indexing, retrieval, detection, extraction, merge, cache, locking, and backend-native publication. codeweave-pi owns only package-local runtime selection, policy resolution, project/corpus selection, the smallest backend-policy translation, lifecycle scheduling, artifact identity and last-good admission, and the user-facing setup/diagnosis handoffs.

Before adding production machinery, state which real user failure it prevents and which existing backend or Pi primitive it reuses. If no named failure exists, or the backend already owns the behavior, do not add it. Custom Graphify pipelines, a code-graph scheduler, a QMD watcher, catalogs, registries, compatibility layers, and test frameworks are not acceptable substitutes for using the existing owner correctly.

Careful means preserving trust boundaries, user state, isolation, and failure evidence—not surrounding every line with guards and tests. The target is the smallest coherent implementation that reliably satisfies this contract.

## The testing and fix discipline (hard requirement)

- **Proof follows user consequence.** A check is retained only when it catches a stable product failure a user could hit. Tests derived from implementation mechanics, wording snapshots, command-string trivia, and duplicate fixtures are deleted after stronger evidence owns the same claim.
- **Use three proof roles, not one giant suite:**
  1. A disposable **decision probe** answers one design-changing uncertainty and is deleted after success; a failing fixture and redacted evidence remain until root cause is known.
  2. One **focused guard** protects stable behavior owned by the changed module and must fail when that behavior breaks.
  3. An **installed-artifact smoke or real-user journey** proves package loading, Pi lifecycle, actual backends, isolation, shutdown, update, or release claims that source-level tests cannot observe.
- **Grade evidence honestly.** Fakes prove wrapper mechanics, not Pi hook delivery or backend behavior. Direct backend calls diagnose a lane, but only a real Pi session proves host loading, skill expansion, tool delivery, lifecycle events, and teardown. A command exit, file existence, wrapper exit, or agent final sentence is never sufficient by itself.
- **Invoke manual skills correctly.** `--skill <path>` loads a resource; it does not itself execute the skill body. Every skill in this contract uses `disable-model-invocation: true`; behavioral probes must execute `/skill:name` through Pi input expansion (RPC or an actual interactive command). Onboarding behavior is exercised both with extension code loaded and with `--no-extensions`; neither state changes the user-facing contract. Print-mode prose that merely mentions a skill does not test its body. Free-form answers are graded by deterministic state/transcript evidence, not golden wording.
- **Fix shared code, not representative hosts.** A Mac mini or Linux-container failure is a general defect unless evidence proves an unsupported environment. After a relevant fix, rebuild a new immutable artifact and rerun only the affected boundary from clean jeito state; never copy the working tree or patch the host to manufacture success.
- **Keep release evidence cheap and real.** Representative journeys use only the private, inherited `OPENROUTER_API_KEY`, never print it, and prefer the configured free OpenRouter models. Do not rerun package, install, backend, or platform journeys after documentation-only or unrelated test changes.
- [`testing-redesign.md`](testing-redesign.md) is the canonical execution plan. Test count, coverage percentage, and a broad green source suite are not release outcomes.

---

# Part 2 — What this is

## What this delivers

One Pi extension that, once installed and onboarded, gives any project folder prepared code navigation (Core), prepared docs search (QMD), and a prepared semantic code graph (Graphify), kept current automatically, with strict per-folder isolation when the user opts into nested projects.

The user-visible completion path is: acquire one immutable package source; open Pi without unintended installation or project mutation; explicitly review machine policy; explicitly prepare a selected project; receive current, scoped evidence; survive edits, restart, failure, update, rollback, and removal without leakage or user-state loss. Without credentials, codeweave-pi remains honestly useful through the package-local indexed code graph and its shipped local code model, QMD lexical retrieval, and Graphify’s local AST graph; it never labels a lane semantic-ready when that lane’s semantic path is unavailable.

## The per-project contract (what a prepared project is)

A **prepared project** is one folder plus everything it owns beneath it. Independent of how it is delivered or whether it is nested, every project must satisfy:

- **Boundary and config:** a `.pi-navigation.json` at the project root declares the corpus root, the enabled lanes (Core / QMD / Graphify), and `scope.exclude` subtrees. It is the authoritative boundary.
- **Corpus:** the complete set of admitted files (root minus excludes). Each backend artifact is built from exactly this corpus and nothing outside it.
- **Owned state and artifacts:** Core owns a machine-side indexed graph at `<storage.indexRoot>/codegraph/<root-hash>` (default `~/.pi/navigation/indexes`); QMD owns a project-local database, vectors, generation, transaction, lock, and health under `.pi/navigation/qmd`; Graphify owns a verified `graph.json` generation under `.pi/navigation/graphify`; codeweave-pi records matching lane and corpus-policy identity in `.pi/navigation/state.json`. Local QMD model files may be shared as immutable machine cache, but project databases, generations, locks, and health are never shared.
- **Identity and provenance:** the live `scope.exclude` digest must match each prepared lane before use. Every prepared result reports requested scope, selected project, corpus root, backend artifact, generation/health identity, and material omissions.
- **Provider inheritance:** a project inherits the global provider defaults and works automatically when globals are set. No per-folder key work is required for the common case; a project may override providers individually.
- **Independent lanes:** the Core, QMD, and Graphify lanes are enabled independently. A missing, broken, or unprepared lane makes that lane unavailable for the one request — it never crashes, and never falls back to another project's corpus.
- **Selection:** a query resolves to the **nearest** project boundary and selects exactly one project. If that project lacks the requested lane, the query fails closed — it never falls through to an ancestor.
- **Integrity / no leakage:** a project's results contain only its own corpus. Isolation is by construction (a separately-built corpus), never by post-query filtering.
- **Lifecycle ownership:** changes are attributed to the project that owns the path; each project refreshes independently under the update policies below, and can be refreshed **on demand** through the navigation procedure without waiting for stop/cadence.
- **Read-only query:** querying a project never mutates, builds, or repairs it.

---

# Part 3 — Delivery and installation

- **Supported targets:** `darwin-arm64` and `linux-arm64`, Python >=3.10 with `venv`, Node 22.19+, Pi 0.82.1+. Other targets are unsupported until they pass the same Git-installed journey.
- **Distribution boundary:** GitHub is the only current delivery channel. npm publication and Apple Developer signing/notarization are not release gates. The repository owner, repository name, visibility, and first immutable ref remain undecided until the owner explicitly selects them.
- **Managed user path:** `pi install git:github.com/<owner>/<repository>@<immutable-tag-or-commit>`. Pi clones the aggregate package under `~/.pi/agent/git/<host>/<path>`, runs the root npm lifecycle, and records the Git source in `~/.pi/agent/settings.json`. A Git source installs the complete monorepo package; Pi cannot target `extensions/codeweave-pi` inside that source.
- **Editable contributor path:** contributors may clone to any stable absolute path, run full `npm install`, then `pi install "$PWD"`; Pi records the exact live checkout without copying it. Moving or deleting that checkout breaks registration, and source/dependency changes take effect only after preparation and Pi restart.
- **Contained extension path:** codeweave-pi-only local installation remains available from a prepared clone through the root `install:codeweave-pi` script. Never register that contained package together with an aggregate that exposes codeweave-pi unless the aggregate explicitly disables the duplicate resources.
- **Installed automatically:** extension code and skills; the package-owned Core maintenance runtime, grammars and pinned local code model; the QMD runtime; the matching pi-nav artifact; required Node dependencies. The optional Graphify 0.9.23 runtime is the only Python-requiring piece and stays a separate stopped-Pi step (`npm run nav:provision:legacy`). npm is an installation mechanism inside the Git/local package lifecycle, not a publication channel.
- **Package isolation:** every runtime invocation uses extension-relative QMD, Graphify and pi-nav identities plus the package-owned Core runtime. Unrelated global tools, Pi packages, caches, project indexes, and models remain untouched. Their presence must not change backend selection; any shared machine-state collision fails closed with an owner-specific diagnostic rather than adopting, deleting, or killing foreign state.
- **Not automatic or silent:** installation never writes API-key values, machine policy, shell startup files, local QMD models, project configuration/indexes, or global backend commands. After installation, `/skill:deep-navigation-onboard` may configure approved shell credential plumbing and `navigation.yaml`; `/skill:navigation-setup` may prepare an approved project. Every host-file mutation gets exact preview, backup when replacing/appending, explicit approval, and verification. Retired CRG artifacts, bindings and stores are never adopted, migrated, or deleted.
- **Transactional preparation:** platform, Python, Node, and Pi compatibility is checked before replacing a working runtime. Failed preparation leaves the previous installation usable and must not be followed by registration.
- **Update compatibility:** machine policy resolution is explicit override → current `~/.pi/agent/navigation.yaml` → predecessor `~/.pi/navigation/config.json` → defaults. Legacy-only policy remains active and is reported; current and predecessor files are never merged silently; malformed active policy disables automation. npm install, Pi registration, startup, and aggregate setup never translate, overwrite, or delete either policy or project state.
- **Setup handoff:** `/skill:jeito-setup` remains responsible for the user's package lifecycle goal, verifies package/runtime ownership, and discovers the installed specialist whose declared purpose matches the unresolved work. `/skill:deep-navigation-onboard` reviews fresh/current/predecessor machine policy and recognized provider capability without preparing a project. Only a completed machine-policy review may hand a user-selected project to `/skill:navigation-setup`; symptoms route first to `/skill:navigation-debug`. Every handoff states the next owner, verified evidence, proof limit, and resume point.
- **Unsafe roots:** HOME and the filesystem root are not preparation targets. A covering legacy HOME boundary is preserved and reported as an explicit migration decision; dry-run and doctor must not recommend direct freshen or automatic setup there.
- **Cold open is inert until consent:** opening Pi without an approved machine policy and prepared project only registers resources and reports readiness. It never installs, downloads, seeds policy, or selects/prepares a project. An already prepared project may run only the bounded maintenance explicitly allowed by its approved automation policy.
- **Platform equivalence:** operating-system adapters may differ, but completion, timeout, cleanup, and artifact behavior must be identical. A one-machine path is not a product fix.
- **Query time is read-only:** queries never install, index, download, build, repair, call an indexing provider, or mutate.
- **Setup failure classification:** the front-door setup distinguishes an expected local blocker, a suspected shared delivery defect, and unknown ownership. It diagnoses only far enough to identify the correct owner and safe next action; ordinary setup is not a general debugger or release-validation run.
- **Local recovery:** unsupported targets, missing prerequisites or credentials, user-owned malformed policy, moved checkouts, private network/permission restrictions, and manually duplicated registration receive one supported recovery action or the current owning skill. A local prerequisite is not itself a product defect.
- **Shared delivery defects:** package-owned failures in a documented supported path—packaged artifacts, lifecycle, readiness, selection, state preservation, or guidance—are fixed in first-party source and retested through the affected boundary. Setup never hotfixes installed dependencies, adds machine-specific overrides, disables checks, copies runtimes, or silently changes provider/model to manufacture success.
- **GitHub escalation:** read-only diagnosis may offer a compact redacted issue draft only when evidence supports a shared defect. The exact repository is verified, the complete draft is previewed, secrets/private configuration/user-specific absolute paths are omitted, and submission requires explicit approval. Insufficient evidence remains `unknown`; setup never files automatically.

---

# Part 4 — Providers and credentials

## Credential model — one OpenRouter key is the default

`OPENROUTER_API_KEY` is the recommended minimal credential. After one approved onboarding write it configures defaults for every semantic lane; credential presence and configured policy still do not prove authentication, quota, model access, or provider health. Users may override providers or models globally or per project.

| Lane | Zero-key behavior | OpenRouter quick-start mapping |
|---|---|---|
| Core | Complete package-local indexed code graph with lexical/FTS retrieval | No key and no external provider: the pinned local code model ships with the package, and `backends.architecture` carries consent keys only. |
| QMD | Lexical docs retrieval; optional, separately approved local model acquisition (~928 MiB for the owned embedding and reranking pair) | Embeddings with `nvidia/nemotron-3-embed-1b:free` and reranking with `nvidia/llama-nemotron-rerank-vl-1b-v2:free`. |
| Graphify | Local AST graph; semantic extraction unavailable | Native Graphify `openai` backend pointed at OpenRouter, using `inclusionai/ling-3.0-flash:free`. |

Release journeys may use `inclusionai/ling-3.0-flash:free` as their Pi driver, but backend configuration never changes the user’s Pi conversation model.

The consumers are independently configurable. Selecting a Pi conversation model never changes Core, QMD, or Graphify.

### Provider decision and evidence

- This contract owns the selected defaults; `src/core/provider-registry.ts` owns their executable endpoint, capability, credential-name, and model representation. They must agree before onboarding recommends or writes policy.
- A disposable 2026-07-28 Graphify 0.9.23 probe produced the same valid code-plus-doc graph with `inclusionai/ling-3.0-flash:free` in 4 seconds and `nvidia/nemotron-3-ultra-550b-a55b:free` in 9 seconds. Ling is the default because it produced equivalent observed output faster; this is not a universal superiority claim.
- Production-shape Ling extraction preserved code and docs across initial, unchanged-cache-hit, and changed-doc runs (7/6, 7/6, then 8/7 nodes/edges). A deliberate provider failure exited nonzero and preserved the last-good graph byte-for-byte.
- `poolside/laguna-s-2.1:free` hit an upstream 429 and is not a default. `deepseek-v4-flash` remains the proven paid Graphify fallback. MiniMax-M3 may drive Pi, but Graphify onboarding must not offer it as a selectable extractor: a thinking-disabled tiny fixture succeeded, then two forced `extensions/shell` runs diverged materially. One run dropped 21 model-misattributed nodes and produced 173 nodes / 382 edges / 0 hyperedges; the other produced 186 / 410 / 3. This falsifies stable source attribution despite valid JSON.
- The retired CRG runtime's MiniMax `embo-01` and Google embedding provider mappings are historical and have no current code-lane owner; the package-local Core lane needs no embedding credential. Graphify accepts `GEMINI_API_KEY` or `GOOGLE_API_KEY`. Onboarding must report these lane-specific credential differences rather than hiding an available key behind one canonical name.
- Free endpoints may rate-limit or change availability. Project content leaves the machine and provider handling is governed by the provider’s current policy; codeweave-pi makes no retention or training guarantee. Provider failure preserves last-good artifacts, with no silent fallback or weaker publication.

- OpenCode Go is a supported low-cost Graphify alternative through Graphify's built-in `openai` backend with a child-scoped `https://opencode.ai/zen/go/v1` endpoint and `OPENCODE_API_KEY`; codeweave-pi never writes global Graphify provider configuration. Two forced Graphify 0.9.23 runs over `extensions/shell` completed in 29.87s and 29.13s for approximately $0.0023 and $0.0024, representing all six code and four documentation sources and remaining queryable. The semantic graphs differed slightly (188/403 then 189/408 nodes/edges), so this proves complete repeat operation, not deterministic semantic identity. The actual codeweave-pi production path then passed extraction, semantic-output detection, query verification, and immutable-generation publication with 185 nodes and 360 edges. At official rates its 5,662 input / 4,713 output tokens cost approximately $0.0021; Graphify displayed `$0.0098 (~openai)` because the child-scoped compatibility route uses its built-in OpenAI price table, which is not billing authority. OpenCode documents DeepSeek V4 Flash training as `Used` with `No agreement` for retention; onboarding requires explicit privacy acceptance and never makes it a silent default. Official setup and contract: https://opencode.ai/auth and https://opencode.ai/docs/go/.
- Command Code documents an OpenAI-compatible Provider API and suitable source-code privacy terms, but the bounded Graphify request returned HTTP 403 `upgrade_required` because a Go-plan key lacks Provider API access. Onboarding detects `COMMANDCODE_API_KEY`, explains the entitlement distinction, and links https://commandcode.ai/studio/provider, https://commandcode.ai/provider, and https://commandcode.ai/docs/resources/pricing-limits. Command Code remains detection-only—not a selectable Graphify backend—until a Provider-plan extraction passes the same completeness and queryability gates.
- Setup always renders every core Graphify choice, then highlights one recommendation. The recommended order is OpenCode Go `deepseek-v4-flash` → OpenRouter `inclusionai/ling-3.0-flash:free` → native DeepSeek `deepseek-v4-flash`; failure preserves last-good and never invokes the next provider automatically. Gemini, MiniMax, and Command Code remain visible with their exact evidence state rather than being hidden because they are not selected. Ollama is excluded from recommendation profiles.
- Gemini `gemini-3-flash-preview` is a native Graphify experimental free option, not a certified fallback. Google documents free input/output for eligible models, but unpaid Gemini API content is used to improve products and human reviewers may process prompts/responses; setup requires explicit privacy acceptance and a bounded corpus proof. Official key, pricing, and terms: https://aistudio.google.com/apikey, https://ai.google.dev/gemini-api/docs/pricing, and https://ai.google.dev/gemini-api/terms.
- MiniMax Token Plans are reusable API subscriptions—not chat-only plans—and use a Subscription Key separate from pay-as-you-go keys. Monthly plans are $20/$50/$120; MiniMax-M3 pay-as-you-go below 512K is $0.30/M input, $1.20/M output, and $0.06/M cache read. The API documents OpenAI-compatible `/v1/chat/completions` and `thinking.type`; these protocol facts do not override the failed stability proof. Official sources: https://platform.minimax.io/docs/guides/pricing-token-plan, https://platform.minimax.io/docs/guides/pricing-paygo, and https://platform.minimax.io/docs/api-reference/text-chat-openai.

Skills and other docs reference this contract for selected defaults and the executable registry for supported combinations; neither invents provider/model behavior independently.

Onboarding exposes every current registry/backend option plus zero-key/local behavior. It reports current active capability, every recognized credential candidate as present/absent, unused supported capability, and options needing credential or model acquisition. Credential presence is never validity. OpenRouter remains the proven **one-key quick-start comparator**, not the automatic recommendation. An unfamiliar user is ambitious by default: setup requires a complete provider/lane/model comparison followed by the strongest coherent reliable recommendation whose quality, coverage, privacy, cost, rate-limit, download, and evidence trade-offs are explained.

### Shell credential placement and tolerant onboarding

Onboarding must work when codeweave-pi extension code is already loaded, deliberately disabled with `--no-extensions`, or not yet active after installation. Loaded code is never a reason to force the user through a second manual setup path: the advisor may inspect and write host-owned machine policy safely, but it never repairs the loaded package runtime or prepares a project. If the package or skill itself is unavailable, ownership returns to `/skill:jeito-setup`.

The advisor detects the active/inherited shell and any user-stated preference. It inspects only shell identity, candidate path existence/type/mode, and exact loader-line presence; it never opens a credential-bearing file or emits environment values. Existing secret-manager or private-file conventions win. If no preference exists, recommend:

| Shell | Default private file | Loader behavior |
|---|---|---|
| fish | `${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/90-jeito-secrets.fish` | Fish loads `conf.d` automatically. |
| zsh | `${XDG_CONFIG_HOME:-$HOME/.config}/jeito/secrets.zsh` | Add one guarded source line to `~/.zshrc`. |
| bash | `${XDG_CONFIG_HOME:-$HOME/.config}/jeito/secrets.bash` | Add one guarded source line to `~/.bashrc`; on login-shell systems, ensure `~/.bash_profile` sources `~/.bashrc` or the same private file. |

After exact preview and approval, the advisor may create the private directory (`0700`), create an absent private file (`0600`), back up and append only the required loader line to a non-symlink startup file, and verify permissions/loader presence without reading secret content. The user performs the single irreducible action: enter the key directly in their editor or a hidden-input terminal prompt, never in chat or a tool argument. The advisor then checks only non-empty presence in a fresh shell, explains that the current Pi process cannot inherit a newly added variable, and requests one restart. It never stores a placeholder, reads an existing secret file, or claims provider validity from presence.

---

# Part 5 — User interaction

## `/skill:jeito-setup` — public setup guide and lifecycle coordinator

`jeito-setup` is for unfamiliar and infrequent users, including machines configured in an earlier session. It teaches and checks the five root-aggregate components—Shell, tooltap, draft-lift, websift, and codeweave-pi—explains the observed state, recommends one next action, and keeps the conversation continuous through preview, approval, verification, and optional preparation of a user-named project. It also owns package install, update, rollback, removal, registration, and package recovery. “Package installed” is completion only for an installation-only request.

Normal setup does not run `pi list`: successful skill expansion already identifies the loaded guide. Package ownership checks belong only to install, update, rollback, removal, duplicate-owner, missing-resource, or loaded-source diagnosis. That package branch runs `pi list` once and never repeats it for display formatting or copies it through a temporary file.

jeito executes one efficient read-only advisor snapshot on every `/skill:jeito-setup` invocation before describing readiness, configuration, provider availability, or a recommendation; a prior invocation’s snapshot cannot be reused, and an answer produced without the current snapshot is invalid. It reads the root five-extension identity plus codeweave-pi and websift specialists once, batch-reads current provider/default/model/link authorities, then invokes `extensions/codeweave-pi/scripts/machine-snapshot.mjs` once with source-derived non-secret JSON. Snapshot schema version 1 reports inherited/login shell metadata; ten fixed common macOS/Linux zsh/fish/bash config locations; the effective Pi agent directory, `settings.json` declared-version status, and navigation/websift/APPEND/tool files; exact policy/version state; recognized credential-name presence; Shell/codeweave-pi runtime and local-model/loader markers; and the current-root project marker. It imports no TypeScript owners, lists no directories, scans no HOME tree, enumerates no environment names, reads no secret values, creates no temporary files, calls no provider, and interprets no policy. Missing files and symlinks are facts, while existing policy loaders remain authoritative for parse, precedence, migration, and effective behavior. Missing/unsupported snapshot machinery blocks the overview and recommendation; it never permits improvised discovery.

The setup answer teaches the complete observed system in layers:

1. what all five aggregate components do and which ones have machine/provider policy;
2. a component-health table based on bounded calls rather than manifest/key/file guesses, followed by effective websift routing, codeweave-pi policy, shell credential transport, local models, and current-project preparation;
3. why websift does or does not need a policy change, including operation coverage, credential-backed adapters, live-test limits, and gains/losses of retaining package defaults;
4. what every present credential and model can coherently unlock, grouped by user benefit with supported lanes, advisory models, unsupported uses, cloud egress, cost/rate-limit class, downloads, and evidence strength;
5. **⭐ Recommended setup** selected from actual present capability. The unfamiliar user is ambitious by default: choose the strongest coherent, reliable QMD/Graphify lane models — the code lane is package-local and needs no credential — rather than the fewest credentials, then disclose complexity, evidence strength, privacy, cost, rate limits, downloads, and exact losses against balanced and private profiles. OpenRouter wins only when its proven one-key coverage materially beats the available specialized combination for the user’s goals;
6. a small outcome-based profile comparison covering gain, loss, egress, likely cost, downloads, reliability, and proof limits;
7. official account/key, models, pricing/limits, and documentation URLs for displayed profiles;
8. **👉 What would you like to do?** offering live verification, exact preview, deeper comparison, privacy setup, or explanation.

The answer never begins with package progress, owner count, registration paths, `result:`, or internal routing narration. It uses plain language before backend/provider names but never hides observed credentials, exact models, stronger/private alternatives, risks, costs, or evidence debt to make setup appear simple. Existing configuration receives an active-versus-available explanation and justified keep/change recommendation; “no `web.yaml`” is explained as active package defaults, not no configuration.

Policy state changes safe action: fresh means detected capability is unselected; current means explain active policy and compare available unused capability; legacy preserves predecessor semantics; conflict preserves both and requires intended-policy selection; malformed disables automatic work and previews repair only after inspection.

Snapshot and configuration facts do not prove tool operation. Before recommending, setup performs bounded local checks: the snapshot proves Shell `bash`, `jobs` must answer one empty listing, Stow `tool_search` must return a non-error runtime/version discovery, a known-root exact `grep` proves codeweave-pi’s exact tool surface, and prepared current folders receive one read-only `docs_search` plus `explore` query. draft-lift is only declaration-checked because a real check changes the editor and invokes a model; it requires explicit approval. websift authentication/quota and provider-backed codeweave-pi model access also require grouped explicit approval that discloses provider, operation/query, egress, possible cost, attempt bound, and returned fields. Declined checks are reported as configured-not-tested, never ready.

`deep-navigation-onboard` owns machine policy. It reads current provider/model authorities once, consumes or runs snapshot schema 1 once, reads existing policy only when present, and uses all observed viable capability in its recommendation. With `ZEROENTROPY_API_KEY` present, `zembed-1` plus `zerank-2` is the default QMD recommendation unless its bounded check fails, active policy/user privacy says otherwise, or comparative evidence supports another choice; Voyage must not displace it from `docs_search` merely because Voyage is described as specialized. OpenRouter remains a balanced whole-stack comparator, not an automatic winner.

Provider pages are grounded in installed catalogs when available or fetched only from official sites for displayed profiles. Page/key presence never proves service health. Shell persistence is diagnosed by bounded name/loader metadata without exposing content; secret entry stays directly with the user.

Before mutation, preview shell plumbing and policy separately, including models, behavior, egress, downloads, files, backups, permissions, and rollback. Apply only approved changes, verify non-secret identifiers, and restart only when inherited environment or loaded code changed. Machine policy never prepares a folder or changes the Pi conversation model; after verification, separately explain and offer `/skill:navigation-setup` for one user-selected project.

Machine configuration never prepares a project or changes the user’s Pi conversation model. Loaded-versus-disabled extension state changes only observable runtime facts, not the guidance or safety contract.

Opt-in auto-create is the sole exception to consent-gated project setup: with `automation.auto_prepare_unprepared_git_roots: true` in machine policy, a session opened at a git project root (session working directory equals the detected root) may create `.pi-navigation.json` and prepare Core+QMD in the background. Graphify is never auto-created; nested git projects discovered under the root are written to `scope.exclude` and filtered from both Core and QMD corpora; preflight hard limits (`scoping.maxAutoFiles`/`maxAutoBytes`), unsafe-root blockers, and dry-run read-only behavior still gate every run. The flag is an explicit privacy decision because prepared content leaves the machine per the approved provider policy; advisors must disclose it before enabling it.

## `/skill:navigation-setup` — per project

Running `/skill:navigation-setup` is the only normal way to prepare a folder. It inherits global defaults, inspects the intended root, and previews corpus, likely independent children, providers/models, cloud egress, writes, and undo. After confirmation it writes one `.pi-navigation.json`, prepares all enabled lanes, and publishes ready state only when artifact and corpus-policy identities agree. No per-folder key entry is needed.

`/skill:navigation-debug` owns read-only project symptoms and returns `classification`, `recommended owner`, `verified evidence`, and `proof limit`. Local project state may proceed to `/skill:navigation-setup` after approval; package/runtime/registration failures return to `/skill:jeito-setup`; machine-policy conflict or change remains in `/skill:deep-navigation-onboard`; a source-supported shared defect may offer a redacted issue draft but is never filed automatically.

## Explicit nested-project behavior

- A child becomes independent only after the user selects it during `/skill:navigation-setup`; detection is advice and declining is healthy.
- The parent lists every independent descendant as a normalized project-relative `scope.exclude` prefix. Each child owns its config, three backend artifacts, state, locks, and health.
- Ordinary folders remain in the nearest parent's corpus. External siblings are independent and need no parent exclusion.
- When a monorepo or workspace root is explicitly prepared, it is itself one project whose corpus is the whole root minus user-selected independent children. Automatic preparation under an approved policy indexes that root rather than skipping it as “ambiguous.” Package/workspace ambiguity may guide child selection but never silently creates independent projects. Core may prepare the approved root without an LLM or credential; Graphify semantic extraction may defer for provider/cost approval, which is separate from project selection.
- A child config without a covering-parent exclusion is invalid because it creates overlapping corpora. Setup must detect and repair this before publishing ready state.
- Adding a child is fail-closed: lock parent and child; publish the parent exclusion so stale parent lanes become unavailable; prepare the child; rebuild the parent without it; publish matching states; release locks. Temporary unavailability is acceptable, overlapping evidence is not.
- Removing isolation rebuilds the parent to admit the child before removing the child boundary. Child artifacts are preserved unless deletion is separately approved.
- Missing, disabled, malformed, excluded, or policy-mismatched nearest lanes fail closed and never fall through to an ancestor.
- Post-query filtering, a central catalog, automatic package scanning, and cross-project federation are forbidden.

---

# Part 6 — Backend update and failure policy

- **Core — incremental-owned:** `index.ts::registerCandidateAnalysisLifecycle` owns admission, scheduling and writer selection for the package-owned indexed code graph, and `native/analysis/maintenance.ts::maintainAdmittedProject` reuses CodeGraph initialization and incremental sync inside the supervised maintenance child. Queries read ready evidence only: they never index, repair, adopt a store, or start maintenance. A root is claimed once under the consent keys `architecture.enabled/autoPrepare` plus scope; a refused or revoked root keeps its previous ownership state, and a queued refresh cannot resume prepared work. No watcher daemon and no periodic scheduler are registered. Failed or interrupted maintenance leaves the lane unavailable — automatic recovery is not implemented — and prepared queries keep useful live source instead. Retired CRG stores and bindings are neither adopted nor migrated and never prove or block ownership.
- **QMD — edit-owned plus bounded reconciliation:** successful Markdown edit/write/delete/move operations enqueue one coalesced project-local projection and embedding update. Approved automation may reconcile an already prepared docs lane at bounded lifecycle checkpoints; every ten completed tool calls is crash/external-change recovery, and shutdown waits for pending QMD work. QMD has no filesystem watcher, and a cold unprepared open performs no QMD mutation.
- **Graphify — dirty and coalesced:** edits mark only the owning project dirty. The completed mutation tool result may start one owned native update for that project; the project lock coalesces concurrent requests. There is no heavy `agent_end` refresh. Every-ten-tool cadence is crash recovery, and session shutdown enumerates explicit dirty projects for the final bounded drain. Code changes use native local AST update; changed semantic sources use native incremental extraction/cache. Automatic work never performs an unrequested full semantic rebuild.
- **On demand:** the navigation procedure refreshes one selected project immediately without changing provider policy.
- **Last good:** provider failure, partial output, process death, or verification failure never replaces a verified artifact. The lane reports maintenance failure and one bounded retry path.
- **Worker ownership:** one process/lock owner per project/backend; concurrent requests coalesce. Shutdown waits for the actual worker or a timeout and cleans its process group/lock. A wrapper exit is not worker completion; Linux `setsid` without `--wait` cannot satisfy this contract.
- Every backend excludes `.pi/` and its own generated/runtime state from its corpus. Public query tools acquire no nested intelligence, provider policy, or indexing behavior.

---

# Part 7 — Upgrade, removal, release, and never

This section defines release acceptance; it does not claim the current checkout has passed. Current readiness and open blockers belong in [`current-truth.md`](current-truth.md) and the evidence-backed baseline in [`testing-redesign.md`](testing-redesign.md). No local tarball, copied checkout, source test suite, or single-host journey may be promoted as public release evidence.

## Upgrade, removal, and rollback

- Stop Pi before changing the currently loaded jeito source or runtime.
- **Managed Git update:** run `pi install git:github.com/<owner>/<repository>@<new-immutable-ref>`. Pi updates the configured source and reconciles its managed clone. `pi update --extensions` only reconciles the already configured pinned ref; it never advances to a newer tag or commit.
- **Editable contributor update:** in the registered checkout, fetch and check out an explicit tag or commit, run `npm install`, verify the owned runtime, and restart Pi. Do not prescribe an unbounded `git pull` as a reproducible update.
- **Owner replacement:** when moving between local and managed Git sources, prepare and register the new source first, remove the old source before restart, then verify exactly one jeito owner. Never load both copies together.
- Updating preserves `~/.pi/agent/navigation.yaml`, project `.pi-navigation.json`, prepared indexes, last-good artifacts, optional shared QMD models, unrelated packages, global tools, and foreign workers.
Before package removal, the documented removal flow stops only jeito-owned workers and removes only jeito-owned registration; Pi then removes the exact package source. Project configs/indexes and shared local QMD models are preserved by default. Deletion requires a separate preview and confirmation naming every path.
- **Rollback:** reinstall the prior immutable Git ref, or check out the prior explicit contributor ref and rerun `npm install`. Incompatible state remains preserved but unavailable until explicitly migrated.

## Real-user protocol and definition of done

The Mac mini and Linux container are disposable representative hosts, never product targets. Both use the same immutable Git ref and documented steps:

1. Start with normal user tools, packages, caches, and private environment intact; remove only a duplicate jeito registration when proving first install rather than update.
2. Install the exact Git ref, restart Pi, onboard with one OpenRouter key, and verify only approved global policy was written.
3. Prepare an ordinary project and prove Core, QMD, Graphify, `docs_search`, `explore`, and `trace` select only it and use package-local backends despite unrelated global tools.
4. Exercise Markdown/code edits, a completed agent turn, ten-tool checkpoint, shutdown, on-demand refresh, provider failure, restart, and stale-lock recovery.
5. Add and remove an independent nested child; prove parent exclusion, three child artifacts, nearest-project selection, lifecycle updates, and negative cross-project queries.
6. Update to a newer immutable ref, roll back to the prior ref, remove, and reinstall; verify preserved user state, exactly one active package owner, and no unmanaged jeito worker.
7. Repeat on the other supported platform. A failure is fixed in the shared package path, committed to a new immutable ref, then retested through Git—not by copying a working tree or cleaning unrelated host state.

Delivery requires an accessible GitHub repository, an immutable tested ref, both platform journeys, one-key semantic operation, honest zero-key lexical/AST behavior, correct fail-closed selection, package-local backend ownership, last-good preservation, reliable update/rollback, and a green extension release suite. Each lifecycle/backend contract gets one focused falsifying proof; test volume is not a goal.

## Out of scope — never

- Automatic nested-folder/package indexing; result filtering as isolation; central catalogs or query-time federation.
- A universal ignore grammar or backend parser wrapper.
- Custom Graphify detection, extraction, merge, cache, lock, or publication logic already owned by Graphify.
- A code-graph scheduler, QMD filesystem watcher, second hierarchy, or raw Markdown cache.
- Provider-tolerance code that silently repairs invalid public tool calls.
- Query-time setup, indexing provider calls, downloads, repair, or mutation.
- Unconfirmed provider fallback or weaker publication after semantic failure.
- Machine-specific fixes or platform behavior that changes the user-visible contract.
- New machinery without a named real-user need that existing backend primitives cannot satisfy.
