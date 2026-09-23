---
updated: "2026-09-23 12Z"
---
# Canonical research-folder template

Copy this directory into `<selected-research-root>/<group>/<subgroup>/<verb>-<object>-<discriminator>/`. The default research root is the current Git project's `.research/`; an existing independent root may be selected explicitly with an absolute `JEITO_RESEARCH_ROOT` (see [`../../references/folder-system.md`](../../references/folder-system.md#canonical-location-and-identity)). Before copying, inspect any existing root, group and subgroup `AGENTS.md`, search for the objective, and decide whether this is a resume, pass, experiment, reference or genuinely new investigation. Do not overwrite existing research.

After copying:

1. replace every `<Objective title>` placeholder;
2. fill only what framing establishes—use `unknown / next action` instead of invented detail;
3. add the investigation to an existing subgroup `AGENTS.md` if that file indexes objectives; do not require one in a fresh research root;
4. delete this template `README.md` unless the investigation needs a custom landing page;
5. create optional `passes/`, `experiments/`, `raw/`, `archive/`, `agents/`, `OPEN.md`, or `ORIGIN.md` only when useful.

Use unique descriptive H1s and relative Markdown links so `docs` and `explore.map` can recover the objective and its relationships.
