# stall-guard

**stall-guard turns a verified transport stall back into progress.** The settled harness behavior leaves a false choice: a watchdog must abort a silent request, but that abort defeats Pi's ordinary retry, so the turn dies and someone has to type `continue`. stall-guard waits until Pi settles and resumes only the watchdog-tagged stall, only while nothing newer exists — a user abort, a reply or a newer turn is never touched.

The watchdog marks the failure like this:

```
Error: Request was aborted

[stall-watchdog-retry] provider returned error; treating stalled provider stream as retryable.
```

## How it resumes safely

One continuation is requested only after Pi settles and only while the stalled message is still the newest message on the active branch. This prevents a late recovery from interrupting a user reply or another turn.

Bounds and resets:

- At most **3 consecutive resumes**. After the cap it stops and notifies `stall-guard: 3 resumes in a row made no progress; waiting for your input`, so a permanently dead provider cannot burn tokens in a loop.
- A completed turn (any assistant message that is not a tagged stall) resets the bound.
- Input that did not come from an extension — a human typing, or an RPC client — resets the bound. The guard's own continuation is `source: "extension"` and deliberately does not.
- A new session resets the bound.
- If anything was appended after the stall (the user replied, a tool result landed, a newer turn started), the guard does nothing.

## What it deliberately does not do

- It never resumes a user-initiated abort. A user abort carries no watchdog tag, and resuming one would fight the escape key.
- It does not implement retries and reads no retry settings. Pi's retry scheduling cannot act on a watchdog abort, so this guard — not Pi's retry — is what recovers a stalled turn; the `pi-retry` watchdog is the piece that stays silent when `retry.enabled` is false.
- It does not detect stalls. The watchdog tag is the classification input; without a stall watchdog installed, no tag is produced and this guard stays silent.

## Install from an editable checkout

```bash
cd /absolute/path/to/jeito
npm install --omit=dev \
  --workspace @alehdezp/stall-guard \
  --include-workspace-root=false &&
pi install "$PWD/extensions/stall-guard"
```

Register it through the aggregate manifest or standalone, never both.

## Verification

```bash
cd extensions/stall-guard
npm install --omit=dev
npm test
```

The suite drives the extension with fake harness events and asserts classification, the single resume, staleness, the three-resume cap, and each reset condition.
