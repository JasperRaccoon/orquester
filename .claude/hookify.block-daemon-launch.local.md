---
name: block-daemon-launch
enabled: true
event: bash
action: block
pattern: pnpm\s+(run\s+)?dev\b|npm\s+run\s+dev\b|daemon/src/cli\.(ts|js)|systemctl\s+(start|restart|stop|reload)\s+orquester|--appdir\s+/var/lib/orquester(\s|$)
---

⛔ **BLOCKED: this command would start/restart/stop an Orquester daemon.**

This checkout runs INSIDE a live Orquester instance — a daemon is already serving
this very workspace. A second daemon collides with it (port 127.0.0.1:47831 /
daemon.sock already held) and crashes or disrupts the user's live sessions.

Never run `pnpm dev*`, `apps/daemon/src/cli.ts`, or `systemctl … orquester` here.

Verify changes with `pnpm check` (typecheck) and pure-logic spot checks
(`node --import tsx -e '…'` importing modules directly) instead. Drive a real
daemon ONLY if the user explicitly asks — and then only against a separate
checkout with a scratch appdir, never this one.
