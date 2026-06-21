# CLAUDE.md

Orientation for Claude Code (and other AI coding agents) working in this repo.

## Read [AGENTS.md](./AGENTS.md) first

`AGENTS.md` is the source of truth: what Orquester is, the monorepo layout, the daemon
architecture, how to run it locally, the conventions/gotchas, and the full VPS deploy + update
runbook. Everything below is just the short version.

## The things that bite you

- **No build for the daemon.** It runs as TypeScript via `tsx` in dev *and* production
  (`node --import tsx …/apps/daemon/src/cli.ts`). There is no daemon `dist/`. `pnpm build` only
  produces the web SPA (`apps/web/dist`) and the desktop app.
- **No test runner.** The gate is `pnpm check` (`tsc --noEmit`). "Done" means `pnpm check` is
  clean **and** you ran the app to verify — drive the real surface (daemon API over the
  socket/HTTP at `127.0.0.1:47831`, the terminal, Playwright for the SPA), don't just typecheck.
- **ESM everywhere** (`"type":"module"`); the only CJS is the Electron `main.cjs`/`preload.cjs`.
- **tmux ≥ 3.2** is required for session persistence; otherwise the daemon silently falls back to
  a no-persistence backend. `$TMUX`/`$TMUX_PANE` are stripped before tmux calls (so the daemon can
  run inside a tmux pane).
- **node-pty** has a postinstall (`scripts/fix-node-pty-perms.mjs`) that restores its exec bit —
  if PTYs fail with `posix_spawnp failed`, re-run `pnpm install`.
- **Secrets:** plaintext passwords are bcrypt-hashed at rest; SSH keys and GitHub PATs are never
  returned by any API; `?token=` is redacted from logs. Don't print secrets, the real VPS
  domain/IP, or `daemon.env` values. The dev `.stage` password is `123456` (dev only).

## Working agreement

- Run `pnpm check` before claiming a change is done, then **verify by running the app**.
- Follow your process skills (systematic-debugging for bugs, verification before completion).
- The default branch for PRs is `main`. Production deploys from `origin/main`; restarts are
  graceful and preserve tmux sessions (see the runbook in `AGENTS.md`).
