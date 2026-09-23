# beluga-bridge changelog

## 0.5.0 (2026-11-02) — breaking

- `--listen` renamed to `--attach`. Old flag errors with `BELUGA-E2`.
- Version 0.5.0 drops the legacy frame codec; old frames replay as `BELUGA-E9`.
- The bifrost reconnect timeout dropped from 2s to 400ms; flaky peers now fail faster.
- Removed the `--mirror` mode; use `beluga sync --mirrorless` instead.
- Messages over 64KB are rejected with `BELUGA-E7` instead of silently truncated.

## 0.4.2 (2026-10-12)

- Fixed the wisp handshake race that dropped the first frame.
- `beluga status` now shows the queue depth in frames.

## 0.4.1 (2026-09-28)

- Log lines now carry the `beluga.trace_id` field.

## 0.4.0 (2026-09-01)

- First release with the bifrost transport enabled by default.
- The queue is now persisted to disk; crash recovery replays the tail.
