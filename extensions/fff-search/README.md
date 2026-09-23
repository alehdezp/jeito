# fff search

![fff search banner: indexed @file completion for Pi, with a blinking caret and a highlighted file match.](docs/images/v2-banner.svg)

Naming the file in a request lets the agent work from a path you chose rather than one it inferred. Pi already has fuzzy `@file` completion, so fff search is a choice of finder, not a missing feature supplied to Pi. It keeps a project file inventory warm between queries and records the files you select. That costs a native dependency, a watcher and local history databases; there is no comparison showing that it picks better files or finishes tasks faster than Pi's finder.

The integration wraps Pi's autocomplete provider instead of replacing the whole editor. Ordinary completion still goes to Pi. For an `@` query, it searches its maintained project index and offers up to 20 candidates; selecting one inserts an `@path` reference, not file contents. If that search fails or finds nothing after the extension has loaded, the same query falls back to Pi's suggestions. Fallback cannot help if the native library prevents the extension from loading in the first place.

## Let the query set the search boundary

A filename fragment searches the nearest Git repository, or the session directory outside Git. The index warms at session start and a filesystem watcher keeps it current, so repeated queries do not rescan the whole project.

A path beginning `~/`, `/`, `../` or `./` asks a different question: what is directly inside *this* directory? fff search reads only that directory's immediate entries, without indexing a second tree. This makes paths outside the project available without a broad scan. Directories retain a trailing slash so you can descend; dotfiles appear when you type a dot. Descendants are not searched, and a mistyped parent is not repaired by looking elsewhere. Even `./` paths inside the project take this route.

## Finder ownership and persistent state

This autocomplete-only integration is forked from [ShpetimA/pi-fff](https://github.com/ShpetimA/pi-fff), a port of [fff.nvim](https://github.com/dmtrKovalenko/fff.nvim). [FFF](https://github.com/dmtrKovalenko/fff) owns the finder engine and ranking. This package owns the Pi editor integration, explicit-directory routing and fallback. It registers session start/shutdown hooks, but no model tools, commands or skills; the agent's read and search tools are unchanged. If Pi's completion already serves your needs, keep it.

fff search requires `@ff-labs/fff-node` 0.10.6 or newer in the 0.10 line. That minimum avoids repeated Git queries when watcher subscriptions refresh. Selections are recorded in per-project `frecency.db` and `history.db` under `<Pi agent directory>/pi-fff/`. Those databases remain after shutdown, upgrades and removal. Restart Pi after upgrading: replacing a native library on disk does not replace the one loaded in a running process.

## Install from a checkout

Requires Node.js 22.19 or newer, npm, Pi (`@earendil-works/pi-coding-agent`) 0.84.2 or newer and its Pi TUI peer. npm must prepare the native dependency for your platform. FFF 0.10.6 publishes binaries for macOS arm64/x64, Linux arm64/x64 (GNU and musl), Windows arm64/x64 and Android arm64; this integration has not been tested on all of them.

From the monorepo root, prepare dependencies first:

```bash
cd /absolute/path/to/jeito
npm install --omit=dev \
  --workspace @alehdezp/fff-search \
  --include-workspace-root=false
```

Only if npm succeeds, register the prepared checkout:

```bash
pi install "$PWD/extensions/fff-search"
```

Restart Pi after registration. Do not register the extension alongside the jeito aggregate or another copy that installs the same editor integration. Standalone installation does not apply host configuration defaults. See [installation and updates](../../docs/getting-started.md) for the shared workflow.

## Verification

With development dependencies installed:

```bash
npm run check --workspace @alehdezp/fff-search
```

The [runtime test](tests/runtime.test.mjs) exercises initialization, search, selection tracking and explicit paths. The [watcher test](tests/watcher.test.mjs) exercises file creation, renaming and deletion. Neither tests the interactive editor nor measures an improvement over Pi's finder.

MIT licensed; see [`LICENSE`](LICENSE).
