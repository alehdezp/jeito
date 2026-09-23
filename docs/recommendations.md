---
title: "jeito third-party package recommendations and rejection record"
description: "Independent third-party packages recommended for a personal setup, optional alternatives, and the reasons for each choice."
tags: [jeito, recommendations, third-party, catalog, decisions, rejection-record]
created: 2026-07-28
updated: "2026-09-23 14Z"
status: active
owns: "Third-party recommendation catalog and rejection record"
audience: mixed
related: [README.md, AGENTS.md, THIRD_PARTY_NOTICES.md]
---

# jeito third-party recommendations

jeito ships its own first-party extensions for the harness core: web research and catalog discovery (`extensions/websift`), navigation/evidence (`extensions/codeweave-pi`), shell (`extensions/shell`), and prompt enhancement (`extensions/draft-lift`). Third-party packages are recommended only where they fill a gap the first-party suite deliberately does not own.

Every recommendation is an **independent third-party Pi package**. jeito never imports, vendors, patches, re-exports, or republishes their code (see [`../AGENTS.md`](../AGENTS.md) "Recommendation ownership"). Install each with `pi install npm:<name>`; `pi update --extensions` owns updates. Declining any recommendation is a healthy state and produces no warning.

## Selection principles: why this stack and not others

- **First-party owns the core.** websift search/fetch/answer, code navigation, shell compression, skill-catalog discovery, and continuation of a run cut short by a stalled provider stream are built by jeito. Any third-party package duplicating those is rejected as redundant.
- **Third-party fills the gaps the suite deliberately leaves open:** theming, provider-side cache economy, provider error classification and stall detection, autonomous sub-agents, and inline skill referencing.
- **Providers are conditional.** Model registries and provider-routing packages are recommended only to users who select that provider — never forced on everyone.
- **Keep the optional list deliberate.** If we cannot state plainly what a package does and why someone would choose it, leave it out.

## Suggested extras for a full personal setup

These packages are separate recommendations. Installing jeito does not install them. Choose and install any you want independently:

| Package | What it does | Why it is recommended |
|---|---|---|
| `@victor-software-house/pi-curated-themes` | A curated collection of Pi color themes. | One maintained theme source ships a good look out of the box. |
| `pi-theme-picker` | Interactive theme selection UI. | Pairs with curated-themes so users can switch themes without hand-editing settings. |
| `pi-cache-optimizer` | Improves provider-side KV/prompt cache hit rates: keeps stable system-prompt content at the front, adds an OpenAI-compatible `prompt_cache_key` fallback, warns on proxy cache-routing gaps, and shows footer cache stats. | Direct token-cost and latency savings on every session; low-risk and best-effort. |
| `@narumitw/pi-retry` | Treats transient provider failures as retryable — empty-detail errors, Codex websocket-limit and explicitly-retryable backend errors, and stalled streams — feeding Pi's built-in retry path. | Makes long sessions resilient to upstream flakes the user cannot control. |
| `@tintinweb/pi-subagents` | Claude Code-style autonomous sub-agents (`Agent`, `get_subagent_result`, `steer_subagent`): parallel background agents, fleet view, custom agent types, mid-run steering, git-worktree isolation. | First-class parallel/delegated work; the suite does not otherwise provide sub-agents. |
| `pi-skillrefs` | Adds `$skill` autocomplete in the editor and injects referenced skill bodies as visible turn context. | Makes the skill system usable inline; maintained as an independent external package. |

Install individually:

```bash
pi install npm:@victor-software-house/pi-curated-themes
pi install npm:pi-theme-picker
pi install npm:pi-cache-optimizer
pi install npm:@narumitw/pi-retry
pi install npm:@tintinweb/pi-subagents
pi install npm:pi-skillrefs
```

## Recommend actively, not auto-installed

Genuinely valuable, but a behavior layer the user should opt into rather than have forced.

| Package | What it actually does | Why recommend-only |
|---|---|---|
| `@dietrichgebert/ponytail` | Injects the "lazy senior developer / YAGNI ladder" system-prompt layer that biases the agent toward the smallest working change. | Load-bearing for maintainers who want restraint, but it reshapes agent behavior globally — an opinion the user must choose. |

```bash
pi install npm:@dietrichgebert/ponytail
```

## Conditional / provider-specific

Recommend only when the user selects the matching provider. Silent otherwise.

| Package | What it actually does | Condition |
|---|---|---|
| `pi-alibaba-models` | Registers Alibaba/Qwen model definitions. | User runs an Alibaba/Qwen provider. |
| `pi-clinepass-provider` | Provider routing through Clinepass. | User routes through Clinepass. |
| `@estebanforge/pi-glm-tweaks` | Tuning tweaks for GLM models. | User runs GLM models. |

## Development profile (proposed — recommend-only, not default)

For users authoring Pi extensions, skills, themes, or packages — not for end-users of the harness.

| Package | What it actually does | Why recommend-only |
|---|---|---|
| `@gaodes/pi-dev-kit` | Extension-authoring toolkit (MIT fork of `@aliou/pi-dev-kit`). Introspection tools `pi_version`, `pi_docs`, `pi_changelog`, `pi_changelog_versions`, `pi_ext_benchmark`, `loaded_tools`, `detect_package_manager`; the `/tools` command; and the `pi-extension` (12 API reference docs) and `demo-setup` skills. | Useful only when building Pi packages. A typical jeito user never needs it; the suite maintainer keeps it installed locally. |

```bash
pi install npm:@gaodes/pi-dev-kit
```

## Open decisions

These are installed on the maintainer host but not yet assigned a final recommendation tier:

| Package | Current understanding | What is needed |
|---|---|---|
| `pi-blackhole` | Unknown surface; it appeared in an early `core-workflow` draft. | Confirm what it does before keep/reject. Not documented here as a recommendation yet. |
| `pi-experiences` | Provides the `agent-experience` habit system (`agent_experience_*` tools) that stores short "When/Do" habits after discussing a pattern. Loaded and active. | Decide default vs recommend-only vs reject. Leaning recommend-only (a behavior layer not everyone wants). |

## Ignored / rejected packages — do not re-litigate

This is the durable rejection record. Packages below were evaluated and deliberately excluded. Do not re-recommend, re-install, or re-open these without new evidence; a future session reading this section should treat the decision as closed.

| Package | Verdict | Reason |
|---|---|---|
| `@capyup/pi-exa` | Reject | websift search is owned by first-party `extensions/websift`. Redundant. |
| `@weihan28/pi-tavily` | Reject | Same — superseded by `extensions/websift`. |
| `@aliou/pi-linkup` | Reject | Same — third web-search provider already dropped. |
| `@pi-lab/xsearch` | Reject | Niche X/Twitter search; not day-to-day. |
| `pi-web-access` | Reject | First-party `extensions/websift` owns web access. |
| `@dreki-gg/pi-context7` | Reject | Library-docs lookup already has the dedicated first-party `context7` tool in `extensions/websift`. Redundant. |
| `pi-package-search` | Reject | Pi-package discovery is already provided by first-party `web_lookup` in `extensions/websift`. Redundant. |
| `@juicesharp/rpiv-ask-user-question` | Reject | Overlaps Pi's built-in steering / ask-user flow. |
| `@juicesharp/rpiv-todo` | Reject | Removed. Note: this provided the `todo` task-list tool; removing it drops that tool. |
| `@narumitw/pi-goal` | Reject | `/goal` autonomous loop removed (independent of `@narumitw/pi-retry`, which is kept). |
| `@ogulcancelik/pi-herdr` | Reject | Terminal-multiplexer pane control; not day-to-day for the recommended stack. |
| `harpy-theme` | Reject | Redundant with the recommended `pi-curated-themes` and `pi-theme-picker` pairing. |
| `pi-terminal-theme` | Reject | Same — redundant theme pack. |
| `@tifan/pi-rename` | Reject | Unneeded; no clear day-to-day role. |
| `@mrclrchtr/supi-context` | Reject | Unknown surface; no justifiable default role. |
| `pi-prompt-control` | Reject | Unknown surface; no justifiable default role. |
| `@diegopetrucci/pi-context-inspector` | Reject | Development-only context debugging; not for end-users. |
