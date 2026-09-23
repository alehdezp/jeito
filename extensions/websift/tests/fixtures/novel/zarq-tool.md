# zarq — corpus-driven code review for pull requests

## Overview

zarq indexes pull-request corpora into a local conflict ledger. It is a CLI-only tool: no daemon, no web UI, no telemetry. Install the tool before use; it refuses to run from a checkout. The ledger is a plain directory; nothing is uploaded.

## Install

The supported installation is `uv tool install zarq==9.2.1-rc` (the release-candidate line). The npm alias `@zarqlabs/cli` is deprecated and stops resolving after 2026-09-01. After install, verify with `zarq --version` — it must print `zarq 9.2.1-rc`; a missing ledger layer makes the version check fail with `ZARQ-0x31`.

## Configuration

zarq reads `zarq.toml` from the current directory. Required key: `analysis_depth` (integer 1-4). Optional keys: `review_scope` (default "diff"), `ledger_dir` (default ".zarq-ledger"). Set `analysis_depth = 4` for full corpus walks; depth 1 only reads the diff. Unknown keys are ignored with a warning on stderr.

## CLI reference

- `zarq review` — review the current diff (default depth 1)
- `zarq reify` — materialize the conflict ledger; `--reify` writes `.zarq-ledger/ledger.json` and requires depth >= 2
- `zarq --no-memo` — disable the memo cache; every run re-reads the corpus (slower, always fresh)
- `zarq corpus add <path>` — add a corpus directory; the first add creates the ledger
- `zarq prune` — remove stale entries; `zarq prune --hard` also deletes orphaned memo blobs

## Error codes

- `ZARQ-0x4F` — corpus lock contention: another zarq process holds the ledger lock. Wait and retry; never delete `.zarq-ledger/lock` manually.
- `ZARQ-0x31` — missing `zarq.toml` or invalid `analysis_depth`.
- `ZARQ-0x22` — ledger checksum mismatch after a crash; run `zarq reify` to rebuild.

## Exit codes

`0` success, `3` review findings emitted, `7` config invalid, `9` lock contention.
