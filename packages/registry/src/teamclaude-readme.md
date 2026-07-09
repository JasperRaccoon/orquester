# TeamClaude (Orquester addon)

Multi-account Claude proxy with automatic quota-based rotation for Claude Code.

When **enabled**, Orquester routes new Claude Code tabs through a local TeamClaude proxy on this host. The proxy pools multiple Claude accounts and switches when one approaches its session (5h) or weekly (7d) quota limit.

## Install

Use **Install** above (runs `npm install -g @karpeleslab/teamclaude`). Requires Node.js 18+ on the daemon host.

## Enable

1. Install TeamClaude.
2. Add at least one account (see below).
3. Flip the **Active** toggle. Orquester starts a headless `teamclaude server` and injects proxy env into new Claude Code tabs.

Disable the toggle to stop routing (existing tabs keep their original env).

## Add accounts (no browser OAuth)

Browser OAuth (`teamclaude login`) is not available from this UI. Use one of:

### Import from Claude Code (recommended)

1. On the daemon host, log into Claude Code for the account you want:
   `claude /login`
2. Click **Import from Claude Code** below (or set a custom credentials path).

Re-importing the same account refreshes credentials.

Custom daemon-host paths are read by the daemon user and are intended for trusted local credential files only.

### Anthropic API key

Use **Add API key** for Console-billed API accounts.

## Configuration

- **Port** — local proxy port (default `3456`). Bound to loopback only.
- **Switch threshold** — fraction of quota (0–1) at which TeamClaude rotates accounts (default `0.98`).

Account enable/disable, priority, and removal are managed in the **Accounts** list below.

## How Claude tabs change

With the addon **Active**, launching Claude Code sets:

- `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`

Claude Code keeps using its normal OAuth/subscription credentials locally; TeamClaude accepts loopback traffic and injects the selected account token upstream. If the proxy is not healthy when you open a tab, creation fails closed (no silent bypass).

## Usage widget

When TeamClaude is active and accounts are present, the top-bar Usage widget can show **aggregated** 5h/weekly quota across accounts, or a **per-account** breakdown (Settings → Usage).

## Security notes

- Only install from the official package: `@karpeleslab/teamclaude`.
- OAuth/API tokens live in TeamClaude's own config (`~/.config/teamclaude.json` / `$XDG_CONFIG_HOME`), never returned by the Orquester API.
- The proxy API key is local-loopback only; Orquester never exposes raw tokens to the browser.
- Daemon-host path imports are post-auth local file reads by the daemon user; prefer upload unless you know the exact host path.

## Upstream

https://github.com/KarpelesLab/teamclaude
