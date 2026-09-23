---
name: jeito-setup
description: Install, register, explain, repair, or remove the jeito extension suite or selected first-party extensions from Git or an editable checkout. Use for live extension setup-contract discovery, npm preparation, Pi package scope, duplicate-owner prevention, extension-owned onboarding handoff, and GitHub HTTPS/SSH access guidance.
disable-model-invocation: true
updated: "2026-09-23 13Z"
---

# jeito setup

Use this skill as the guided front door for package installation and host-owned configuration. Explain the selected path before changing state. npm owns dependency and `postinstall` preparation; Pi owns package registration; extension skills own provider, credential, model, project-index, and destructive-repair choices.

## Safety and ownership boundaries

- Never treat `pi install <local-path>` as dependency installation. Prepare and verify the checkout first.
- Never invoke npm, download artifacts, or repair extension runtimes during normal Pi startup.
- Never write Pi package entries directly. Use `pi install`, `pi remove`, and `pi config`.
- Never register an aggregate and an individual path that expose the same extension unless the aggregate entry explicitly filters that extension out.
- Never reset, clean, replace, or copy over an editable checkout. Preserve user modifications.
- Never request, read, print, copy, or write a private SSH key or API key. Public SSH keys may be displayed only when the user asks.
- Never silently modify `~/.ssh/config`, shell startup files, `APPEND_SYSTEM.md`, `tool.yaml`, `navigation.yaml`, or provider configuration. Preview the exact change, back up an existing file, and obtain explicit confirmation.
- Stop Pi before rebuilding a runtime already loaded by the current Pi process. Give the exact terminal command and resume-after-restart handoff.
- A failed preparation must not be followed by Pi registration.
- Never search the filesystem for a replacement checkout or infer that a missing registration belongs to the currently selected package from its basename. A moved or renamed path needs explicit old-source approval.
- Never remove an unrelated missing registration while repairing another package.

## In-session versus external-terminal boundary

- Assessment, command preview, public-key display on request, and approved host-file edits may run through tools in the current Pi session.
- A new package may be prepared and registered through the current session only when it is not loaded by that process; it becomes active after restart.
- Updating, repairing, removing generated runtime state, or reinstalling a package loaded by the current process requires Pi to stop first. Print one copy-paste terminal transaction plus the exact restart/resume step; do not mutate the loaded tree and then continue as if the current process had reloaded it.
- When the user chooses to execute everything outside Pi, provide the same ordered npm-then-Pi commands and retain the verification/handoff checklist.

## 1. Establish the requested journey without mutation

Identify:

1. **Managed aggregate Git** — one immutable Git ref, installed and prepared by Pi.
2. **Editable aggregate local** — the downloaded repository remains the live source.
3. **Root-selective local** — one or more `extensions/<name>` workspaces from the downloaded repository.
4. **Extension-root local** — the current directory is one contained extension.
5. **Repair, removal, or explanation** — inspect current state before proposing a command.

Ask only for choices evidence cannot determine:

- complete suite or which extensions;
- user-global registration or project-local registration (`-l`);
- GitHub HTTPS or SSH for a managed Git install;
- whether an approved host-owned configuration should be applied after package readiness.

Do not ask for a repository path, package name, current registration, or setup script until checking the checkout and `pi list`.

## 2. Inspect prerequisites and current ownership

From the checkout root or selected extension root, inspect:

```bash
pi --version
node --version
npm --version
git status --short
pi list
```


### Inspect local registration path health

`pi list` does not mark missing local paths. Treat it as a registration inventory, then inspect the applicable settings files read-only: `${PI_CODING_AGENT_DIR:-~/.pi/agent}/settings.json` for user-global registration and the explicitly approved consumer project's `.pi/settings.json` for project-local registration.

For each `packages` entry, use the string entry or an object entry's `source` field. Leave Git, npm, and other non-local sources unchanged. Resolve relative local package entries against the directory containing that `settings.json`, then check whether the resolved path and its package manifest exist. Report every missing path separately. A missing path has no readable manifest identity, so never infer its package name, successor checkout, or removal authority from its old directory name.

Before proposing installation, compare every existing readable manifest's Pi resources with the selected aggregate/contained package. Stop for duplicate owners even when the registrations use different parent directories or historical names.

For a filtered aggregate entry, resolve **effective** extensions and skills after its allowlists; a manifest entry alone does not prove a resource is enabled. The suite needs both `extensions/guidepin/index.ts` and `extensions/guidepin/skills/goal-management/SKILL.md`. A host `skills` allowlist can enable the reminder hook while excluding the skill. Name the missing resource and the proposed allowlist delta, obtain confirmation before opening Pi-owned `pi config` to enable it, then re-resolve and restart before claiming the suite is complete. Never edit `settings.json` directly or assume a newly declared skill bypasses an existing host filter.

A registered old path that still exists but has no manifest or resolvable resources is not an active extension; identify it separately from missing paths. Removal still needs approval for that exact registered source and must follow the stopped-Pi repair flow below. Do not delete its local data as a side effect.

Read the current root and every selected extension `package.json`, installation documentation, and exposed `SKILL.md` metadata. Use their actual workspace names, `pi` resources, lifecycle scripts, readiness commands, and extension-owned setup skills. Do not recall package metadata or setup procedure from this skill.

For each selected extension, build a current delegation record before proposing commands:

1. package and workspace identity;
2. package-manager lifecycle and specialized installer/doctor scripts;
3. documented supported install path and generated state;
4. exposed skills whose current descriptions own setup, onboarding, configuration, diagnosis, or repair;
5. the smallest owning verification command.

The selected extension's manifest, executable scripts, owning tests, documentation, and skill metadata are the evidence boundary—in that order when behavior conflicts. Never copy an extension's internal setup steps into this aggregate skill. If those artifacts disagree, report the conflict and stop before mutation rather than choosing a remembered workflow.

This skill is an integration adapter over evolving extension contracts. Review it whenever a contained extension changes lifecycle scripts, `pi` resources, setup-skill metadata, generated-state ownership, or supported install paths; absence of a hardcoded extension name is deliberate.

Report:

- resolved checkout and extension roots;
- Pi registration scope requested;
- aggregate and individual packages already registered;
- selected workspaces and expected lifecycle/network effects;
- whether setup requires stopping Pi;
- extension-specific onboarding that remains after registration;
- exact rollback command.

If aggregate and individual entries overlap, stop before npm or Pi mutation. Recommend one owner: remove the old entry, use only individual entries, or explicitly filter the aggregate through `pi config`.

## 3. Configure GitHub access only when managed Git needs it

Local-path installation needs no GitHub credential setup. For managed Git, prefer HTTPS for public repositories and SSH when the user explicitly wants SSH or the repository is private.

### HTTPS

Verify repository access without storing credentials in this project:

```bash
git ls-remote https://github.com/alehdezp/jeito.git
```

Use Git Credential Manager or `gh auth login` only if already installed or requested. Do not embed tokens in URLs, commands, files, or Pi settings.

### SSH

First inspect names and public state only:

```bash
ls -la ~/.ssh
ssh-add -l
ssh -T git@github.com
```

GitHub may authenticate successfully while `ssh -T` exits nonzero; evaluate its message, not exit code alone. If no suitable key exists, explain and obtain approval before generating one at an exact path:

```bash
ssh-keygen -t ed25519 -C "user@example.com" -f ~/.ssh/id_ed25519
```

The user enters the passphrase directly. Never handle or display it. Add the key to the current agent only after approval:

```bash
ssh-add ~/.ssh/id_ed25519
```

On macOS, offer the platform-supported keychain form when appropriate:

```bash
ssh-add --apple-use-keychain ~/.ssh/id_ed25519
```

Show only the public key when the user needs to add it to GitHub:

```bash
cat ~/.ssh/id_ed25519.pub
```

Direct the user to GitHub **Settings → SSH and GPG keys**, then verify with `ssh -T git@github.com` and `git ls-remote git@github.com:alehdezp/jeito.git`. A proposed `~/.ssh/config` edit requires exact preview, backup, and confirmation. Never create a permissive host-key policy.

## 4. Preview the exact installation transaction

### Managed aggregate Git

```bash
pi install git:github.com/alehdezp/jeito@<immutable-ref>
```

For SSH:

```bash
pi install git:git@github.com:alehdezp/jeito@<immutable-ref>
```

Pi clones the repository and runs npm because the root contains `package.json`. Do not run a second manual npm install inside Pi's managed clone.

### Editable aggregate local

```bash
cd /absolute/path/to/jeito
npm install --omit=dev
pi install "$PWD"
```

### Root-selective local

Use the package name read from the selected extension manifest:

```bash
cd /absolute/path/to/jeito
npm install --omit=dev \
  --workspace <exact-package-name> \
  --include-workspace-root=false
pi install "$PWD/extensions/<exact-directory>"
```

Multiple explicitly selected workspaces may be prepared in one npm command by repeating `--workspace`. Register each selected extension path separately after the complete preparation succeeds.

guidepin is not a root-selective installation option: its manifest exposes no standalone Pi resources. Register the aggregate to load both its reminder hook and its goal-management skill.

If the root package exposes an extension-owned verified checkout-install script for the selected extension, prefer that script over duplicating its special prerequisites and checks. Read the script and its owning test before use. Do not run both paths.

### Extension-root local

```bash
cd /absolute/path/to/jeito/extensions/<name>
npm install --omit=dev
pi install "$PWD"
```

Within an npm workspace, running npm from the extension root selects that workspace. Verify the current npm version and clean Git diff rather than assuming every package manager behaves identically.

### Project-local registration

`-l` writes `.pi/settings.json` in the command's current project. Do not run it from the suite or extension checkout unless that checkout is intentionally the consuming project. From the approved consumer project:

```bash
cd /absolute/path/to/consumer-project
pi install /absolute/path/to/prepared/package -l --approve
```

Use `--approve` only after the user explicitly trusts that project for this command. npm preparation still runs in the suite/extension checkout first; only Pi registration runs from the consumer project.

Before execution, state network downloads, generated ignored paths, configuration left untouched, expected duration when evidence exists, restart requirement, and removal command. Obtain explicit approval for the shown transaction.

## 5. Execute preparation before registration

Run the approved npm preparation and wait for its real exit status. On failure:

- preserve stdout/stderr needed for diagnosis without exposing secrets;
- confirm Pi did not receive a new registration;
- diagnose the owning package lifecycle;
- do not fall through to `pi install`;
- do not substitute global packages, PATH fallbacks, or startup repair.

After npm succeeds, run only the selected extension's existing readiness check when one exists. Do not create empty setup ceremony for packages with ordinary JavaScript dependencies and no external runtime.

Then invoke `pi install` with the approved scope. Report the exact source Pi persisted and tell the user that local registration points to the editable checkout, which must remain at that path.

## 6. Verify and hand off

Verify only the installed boundary:

- `pi list` contains the approved source and scope;
- selected package resources resolve from the intended checkout or managed clone;
- no unselected extension lifecycle marker/runtime appeared;
- required extension-local readiness files exist when the package owns them;
- aggregate and individual ownership do not overlap;
- the checkout has no unexpected source diff;
- restart guidance is explicit.

After restart, hand off rather than duplicating extension policy. Re-read effective aggregate and selected extension skill resources, setup documentation, and `SKILL.md` descriptions; invoke the exact extension-owned skill whose declared purpose matches the unresolved machine, project, provider, diagnosis, or repair task. Report that source path and purpose. If no extension-specific onboarding remains, say so. Never infer a skill name from an earlier jeito release.

## 7. Repair or remove without deleting user source

For a prepared local checkout, repair repeats the owning npm preparation/readiness check while Pi is stopped, then restarts Pi. Do not add a second package entry.

Remove the exact registered source through Pi:

```bash
pi remove /absolute/path/to/package
pi remove git:github.com/alehdezp/jeito@<immutable-ref>
```

For project-local registration, run `pi remove /absolute/path/to/package -l --approve` from the same trusted consumer project. Local removal changes Pi registration only; it does not delete the checkout, user edits, `node_modules`, or extension-local generated runtimes. Offer generated-state cleanup separately, name every target, and require explicit approval.

### Move or rename an editable checkout

This transaction requires Pi to remain stopped. First inspect both settings scopes and obtain approval for exact old path A and current path B. Fully prepare path B through its current manifest-owned lifecycle and readiness check. After preparation succeeds, execute the Pi-owned registration transaction in this order:

```bash
pi install /absolute/path/B
pi remove /absolute/path/A
pi list
```

For project-local scope, run both commands from the approved consumer project with `-l --approve`. Installing B before removing A preserves recovery if B registration fails; removing A before restarting Pi prevents both copies from loading together. Verify the applicable `settings.json` now resolves to one selected owner, then restart Pi and verify the loaded resource path/version. Never leave A and B registered across restart.

Rollback is available only when path A still exists and passes its preparation/readiness contract. If A is missing, report rollback unavailable instead of recreating a path, symlink, or guessed checkout.

## 8. Host-owned suite configuration

Applying `config/APPEND_SYSTEM.md` or `config/tool.yaml` is separate from package installation. For each requested file:

1. read the shipped and active current files;
2. show the complete proposed change and explain behavior affected;
3. create an exact timestamped backup;
4. obtain explicit confirmation;
5. write atomically with appropriate permissions;
6. verify current bytes and report rollback.

For tooltap work, a change to `config/tool.yaml`, its routing contract, or runtime configuration semantics always includes reconciling the active `~/.pi/agent/tool.yaml` in the same delivery. Repository/template validation alone is not live completion. If the user declines the exact host edit, report the implementation as not yet active; otherwise verify it after restart before calling the migration complete.

Declining is a healthy no-op. Standalone extension installation never applies aggregate defaults.

## Completion report

```text
journey and scope:
checkout or managed source:
selected packages:
preparation command and exit:
registration command and persisted source:
resources/runtime verified:
overlap check:
configuration changed or untouched:
extension skill handoff:
restart required:
rollback/removal command:
remaining unverified platform or release boundary:
```
