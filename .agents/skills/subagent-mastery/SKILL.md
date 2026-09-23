---
name: subagent-mastery
description: "Operate @tintinweb/pi-subagents safely and continuously: choose ephemeral versus durable agents, create named resumable teammates, distinguish Agent IDs from transcripts, persisted Pi sessions, and memory, resume or recover without fabricating continuity, steer running agents, and verify persistence. Use when delegating substantial work, coordinating interviewer/reviewer/implementer teammates, recovering an expired Agent ID, or configuring custom agents for work spanning user turns."
disable-model-invocation: false
---

# Master Pi subagents without losing continuity

Use Pi's `Agent`, `get_subagent_result`, and `steer_subagent` tools. Never spawn a raw `pi` process to simulate an agent, and never use `pi --no-session`.

## Choose the continuity level before spawning

- **One bounded turn with no expected follow-up:** an ordinary foreground or background agent is enough. Keep its `.output` transcript as the audit record.
- **Any teammate likely to receive another user answer, correction, review round, or delayed continuation:** use a named custom agent with `persist_session: true`, `output_transcript: true`, and an explicit `memory` scope.
- **Project-specific identity across isolated worktrees:** prefer `memory: user` when the durable state must survive worktree creation. `memory: local` and `memory: project` resolve from the agent working directory and therefore do not automatically appear inside a temporary worktree.

`@tintinweb/pi-subagents` 0.14.3 has no `subagents.json` setting that makes arbitrary agent types persistent by default. Achieve resumability through named custom-agent frontmatter; do not claim a global default exists.

## Understand the four different persistence identities

1. **Agent ID** — an in-memory manager record. `Agent({resume:id})` works while that record and its live `AgentSession` remain. Completed records are cleaned after roughly ten minutes and consumed records may be cleared on parent-session lifecycle events.
2. **`.output` transcript** — complete JSONL conversation logging under the operating-system temp directory. It supports inspection and reconstruction, not `Agent({resume:id})`, and is cleared on reboot.
3. **Persisted Pi session** — `persist_session: true` uses a normal on-disk Pi session. It preserves the session for inspection or manual Pi resumption independently of the temporary `.output` transcript.
4. **Agent memory** — `memory: project|local|user` injects durable identity and current state into fresh instances of the same named custom agent. Keep `MEMORY.md` self-contained; relative Markdown links are not automatically expanded into the prompt.

Do not call an expired manager record or a surviving transcript “the same process.” Preserve identity and state honestly; disclose a new runtime ID when recovery creates a new instance.

## Minimal custom-agent template

Create a named file under `.pi/agents/<name>.md` for project authority or `~/.pi/agent/agents/<name>.md` for global reuse:

```markdown
---
description: Persistent reviewer for one owned responsibility.
model: <provider/model>
thinking: high
max_turns: 30
tools: read, grep, find, ls
extensions: false
skills: false
memory: user
persist_session: true
output_transcript: true
prompt_mode: replace
inherit_context: false
run_in_background: true
isolated: true
---

You are the persistent reviewer for <responsibility>.
Read the injected memory before acting. Stay read-only. Preserve explicit user decisions,
report disproven assumptions, and return only the requested review artifact.
```

Use `memory: user` for a named identity that must survive isolated worktrees. Seed `~/.pi/agent/agent-memory/<name>/MEMORY.md` with current decisions, corrections, evidence limits, and absolute paths to detailed state or recovered transcripts. Keep the index below 200 lines.

## Spawn, continue, and recover

1. Before the call, define the objective, role, exact boundary, exclusions, expected artifact, proof budget, and stop conditions. Reuse the same named agent for the same responsibility.
2. Run independent agents together with `run_in_background:true`. Continue unrelated work; do not poll. Use `get_subagent_result(wait:true)` once the result is required.
3. Record the Agent ID and `.output` path returned by the tool. A successful result retrieval does not preserve the manager record indefinitely.
4. For the next round, call `Agent` with the current `resume` ID first and provide the new user answer plus peer corrections. `steer_subagent` applies only while status is running or queued.
5. If resume returns `Agent not found`, inspect the durable memory, prior `.output` transcript, and persisted Pi session. Start the same named custom agent, provide the changed context, disclose the new runtime ID, and continue. Never silently substitute an unrelated fresh agent.
6. After a consequential user answer, update the named agent's durable memory before the next invocation. Store the current decision, rejected alternatives, evidence limits, and next unresolved question—not a chronological dump.

## Smallest proof that persistence works

Before relying on a new persistent agent path:

1. Seed a distinctive fact in its `MEMORY.md`.
2. Start a fresh instance and require the exact fact without project inspection.
3. Resume that Agent ID once and require it to recall its immediately previous response.
4. Confirm a normal Pi session JSONL was created when `persist_session:true`.
5. Confirm the `.output` transcript exists and contains the conversation.

This proves memory injection, immediate ID resume, persisted-session creation, and transcript logging separately. It does not prove an Agent ID survives the manager cleanup window or a machine reboot; durable memory owns continuation after those boundaries.
