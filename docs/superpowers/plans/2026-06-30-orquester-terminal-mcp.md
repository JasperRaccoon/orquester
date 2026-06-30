# Terminal-control MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-daemon `/mcp` endpoint that lets an external MCP client observe and drive Orquester's terminal/agent sessions, addressed as `(workspace, project, tab)`.

**Architecture:** Two thin layers over existing session machinery. A pure, testable `TerminalControl` module (resolve/read/write/wait/create/close/list) takes `ISessionManager` + `RegistryService` + the workspaces/fsRoot dirs + injected `listWorkspaces`/`listProjects` as dependencies. A thin MCP server maps 11 MCP tools onto those functions and mounts on the daemon's existing Fastify HTTP transport at `/mcp` (Streamable-HTTP, stateless), gated by the existing bearer auth — **HTTP-only, never on the unauthenticated unix socket**. One backend addition (`captureText`) provides clean rendered text.

**Tech Stack:** TypeScript 5.8 ESM, Fastify 4, `@modelcontextprotocol/sdk` + `zod`, tmux `capture-pane`, node-pty, `tsx` (runtime + `node:test`).

**Spec:** `docs/superpowers/specs/2026-06-30-orquester-terminal-mcp-design.md` (read it first — this plan implements it section-by-section).

## Global Constraints

Every task's requirements implicitly include these:

- **Daemon safety (AGENTS.md, non-negotiable):** This repo is checked out *inside a running Orquester instance*. **Never** launch/restart/stop the daemon, run `pnpm dev*`, or bind `127.0.0.1:47831` / `daemon.sock` from this checkout. The in-checkout verification gate is **`pnpm check`** (typecheck) + code review. Drive a real daemon (the protocol spike, the manual checklist) **only in a SEPARATE checkout**, or have the user run it.
- **Commits:** commit to the **current branch as-is**. Do **NOT** create a new branch (even on `main`).
- **TS:** `strict`, `moduleResolution: Bundler`, `noEmit: true` — the daemon runs `.ts` via `tsx`; there is no daemon `dist`. `pnpm check` = `pnpm -r typecheck` (`tsc --noEmit`).
- **Test runner (deliberate spec exception — flag to maintainer):** the repo has no test runner; this plan adds `node:test` via `tsx` (no new runtime dep) for the pure/logic-heavy units only. If the maintainer declines, convert those test steps to manual-checklist items.
- **`/mcp` is HTTP-only** — registered only when `mode:"remote"`; it must 404 on the unix socket.
- **Secrets never leak:** error messages returned over `/mcp` must never echo absolute paths/usernames/stacks. `FsSandboxError` → generic message; unknown errors → fixed string + server-side log only.
- **Exactly 11 MCP tools:** `list_workspaces`, `list_projects`, `list_tabs`, `list_launchers`, `read_terminal`, `write_input`, `send_keys`, `send_and_wait`, `wait_for_idle`, `create_tab`, `close_tab`.
- **zod major must match** between `@modelcontextprotocol/sdk` and `@orquester/config` (avoids a dual-zod `instanceof` footgun). Pin accordingly (Task 1).
- **Named constants** (verbatim): `DEFAULT_IDLE_MS = 1000`, `DEFAULT_TIMEOUT_MS = 120_000`, `MAX_TIMEOUT_MS = 600_000`, `SCREEN_ROWS = 50`, `MAX_TEXT = 64 * 1024`, `MAX_TABS_PER_PROJECT = 24`, `MCP_BODY_LIMIT = 8 * 1024 * 1024`.

---

## File Structure

```
apps/daemon/
  package.json            ← MODIFY: + @modelcontextprotocol/sdk, zod; + "test" script
  src/
    tmux.ts               ← MODIFY: capturePane(id, {escapes?, lines?}) — back-compatible
    sessions.ts           ← MODIFY: + captureText(id,{lines?}) on ISessionManager + both backends
    index.ts              ← MODIFY: build TerminalControl + registerMcp (mode:"remote" only);
                            reserve /mcp in auth gate (:378) AND not-found handler (:1843);
                            import isValidName/assertInsideFsRoot/FsSandboxError from @orquester/config
    mcp/
      text.ts             ← NEW (leaf, imports nothing): stripAnsi/trimTrailingBlankLines/tailLines/cap/renderText
      text.test.ts        ← NEW
      keys.ts             ← NEW (leaf): encodeKey + NAMED table
      keys.test.ts        ← NEW
      terminal-control.ts ← NEW: resolve/read/write/wait/create/close/list + typed errors
      terminal-control.test.ts ← NEW
      server.ts           ← NEW: registerMcp(app, control) — 11 tools, hijack, stateless, teardown+abort
      server.test.ts      ← NEW (toSafeToolError only)
  scripts/mcp-spike.ts    ← NEW (one-off protocol validation; standalone, no daemon import)
packages/config/src/
  index.ts                ← MODIFY: + isValidName, assertInsideFsRoot, FsSandboxError (moved from index.ts)
  index.test.ts           ← NEW
```

**Layering note (keeps the config move safe):** `@orquester/config` is transitively imported by the browser-bundled UI, but **only via `import type`** (verified across `packages/ui` + `packages/api`). The new `node:fs`/`node:path` *value* imports in config are therefore erased from the web bundle. Keep every browser-side import of `@orquester/config` type-only.

**Cycle note:** `terminal-control.ts` has **no runtime import of `sessions.ts`** — it imports `ISessionManager`/`SessionSummary` **type-only** (erased, so no `node-pty` load in unit tests) and throws its own `ToolError` instead of `sessions.ts`'s `SessionError`. `text.ts` is a leaf used by `sessions.ts` (not by `terminal-control.ts`), so no `sessions.ts ⇄ terminal-control.ts` cycle exists. `server.ts` *does* value-import `SessionError` from `sessions.ts` (for `instanceof`), which is fine — `server.ts` runs only in the daemon.

---

## Task 1: Dependencies + protocol validation spike

**The verify-before-build gate.** The spec's v1 picks a **stateless** Streamable-HTTP mount with `enableJsonResponse:true`; that is an *assumption to verify* against the real client before any `server.ts` code is written. This task installs the SDK and proves (a) a stateless server answers `initialize` + `tools/list` over plain JSON with the dual `Accept` header, and (b) the real target client (mcp-inspector and/or Claude Code/Desktop) connects to it. If stateless fails, Task 10 switches to the stateful session-map mount (a real rework, decided *here*, not later).

**Files:**
- Modify: `apps/daemon/package.json`
- Create: `apps/daemon/scripts/mcp-spike.ts`

**Interfaces:**
- Produces: the SDK import paths + transport options the rest of the plan relies on — `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`, `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js`, `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })`. **The installed SDK's actual API is authoritative — record any drift here so Tasks 7-11 match it.**

- [ ] **Step 1: Check the SDK's zod major before pinning**

Run: `npm view @modelcontextprotocol/sdk version peerDependencies dependencies`
Expected: note the latest version and which **zod major** it depends on. `@orquester/config` uses `zod ^3.25.67`. If the SDK requires zod 4, either pin `zod` in the daemon to the SDK's major **and** align `@orquester/config`, or accept that the daemon's zod differs from config's (acceptable only because `FsSandboxError` is a plain `Error` subclass shared via one `@orquester/config` copy — no zod `instanceof` crosses the boundary). Record the chosen version.

- [ ] **Step 2: Add the dependencies + a `test` script**

Edit `apps/daemon/package.json` — add to `dependencies` (use the versions resolved in Step 1; zod major matching the SDK):

```json
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.25.67"
```

And add to `scripts`:

```json
    "test": "node --import tsx --test src/**/*.test.ts"
```

- [ ] **Step 3: Install (non-interactive)**

Run: `cd /var/lib/orquester/workspaces/appsstats/orquester && CI=1 pnpm install --frozen-lockfile=false </dev/null`
Expected: installs `@modelcontextprotocol/sdk` + `zod`; lockfile updates; no prompts. (Postinstall re-fixes the node-pty exec bit.)

- [ ] **Step 4: Confirm the test runner discovers files**

Run: `cd apps/daemon && pnpm test`
Expected: node:test runs and reports **0 tests** (no `*.test.ts` yet) and exits 0. If it errors on the glob (older Node 20), change the script to an explicit space-separated file list and re-run. Record the working form.

- [ ] **Step 5: Write the standalone spike server**

`apps/daemon/scripts/mcp-spike.ts` — does **not** import the daemon; binds a throwaway port (never `47831`). Mounts a stateless MCP server with one trivial tool:

```ts
import Fastify from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.SPIKE_PORT ?? 47999); // NOT the daemon port
const app = Fastify();

app.post("/mcp", async (request, reply) => {
  const server = new McpServer({ name: "spike", version: "0.0.0" });
  server.registerTool(
    "ping",
    { description: "returns pong", inputSchema: { msg: z.string().optional() } },
    async (args) => ({ content: [{ type: "text", text: `pong ${args.msg ?? ""}` }] })
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  reply.hijack();
  reply.raw.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(request.raw, reply.raw, request.body);
});

await app.listen({ host: "127.0.0.1", port: PORT });
console.log(`mcp-spike on http://127.0.0.1:${PORT}/mcp`);
```

- [ ] **Step 6: Run the spike + smoke-test it (SEPARATE checkout or user-run)**

**Do not run a long-lived server in this live checkout.** In a separate checkout (or ask the user to run it), start `node --import tsx apps/daemon/scripts/mcp-spike.ts`, then from another shell:

```bash
curl -sS -X POST http://127.0.0.1:47999/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

Expected: a `200` JSON-RPC result (server info/capabilities). Then send `{"method":"tools/list","id":2,...}` → expect the `ping` tool. **Also confirm the 406 contract:** repeat the `initialize` call **without** the `Accept: …text/event-stream` part → expect **406**.

- [ ] **Step 7: Connect the real target client**

Point **mcp-inspector** (`npx @modelcontextprotocol/inspector`) and/or **Claude Code/Desktop** at `http://127.0.0.1:47999/mcp` and confirm it lists + calls `ping`. **Record the outcome:**
- ✅ stateless works against the target → proceed with the stateless mount in Task 10.
- ❌ target demands an `Mcp-Session-Id` handshake → Task 10 implements the **stateful** session-map mount instead (note it in this task's record).

- [ ] **Step 8: Typecheck + commit**

Run: `pnpm check`
Expected: clean (the spike + new deps typecheck).

```bash
git add apps/daemon/package.json pnpm-lock.yaml apps/daemon/scripts/mcp-spike.ts
git commit -m "chore(daemon): add MCP SDK + protocol validation spike"
```

---

## Task 2: `mcp/text.ts` — leaf text helpers (TDD)

Pure functions for clean-text rendering, imported by `sessions.ts` (Task 6). No imports → no cycle, fully unit-testable.

**Files:**
- Create: `apps/daemon/src/mcp/text.ts`
- Test: `apps/daemon/src/mcp/text.test.ts`

**Interfaces:**
- Produces: `stripAnsi(s)`, `trimTrailingBlankLines(s)`, `tailLines(s, lines)`, `cap(s, max?)`, `renderText(captured, buffer, opts?)`, consts `SCREEN_ROWS = 50`, `MAX_TEXT = 64*1024`. `renderText(captured: string, buffer: string, opts?: { lines?: number }): string` = clean text: the tmux capture if present, else the ANSI-stripped, tail-bounded ring.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/mcp/text.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripAnsi, trimTrailingBlankLines, tailLines, cap, renderText, SCREEN_ROWS, MAX_TEXT } from "./text.ts";

test("stripAnsi removes CSI, private CSI, and OSC", () => {
  assert.equal(stripAnsi("a\x1b[31mb\x1b[0mc"), "abc");
  assert.equal(stripAnsi("x\x1b[?25ly"), "xy");                 // private param
  assert.equal(stripAnsi("t\x1b]0;title\x07u"), "tu");          // OSC (BEL)
  assert.equal(stripAnsi("t\x1b]0;title\x1b\\u"), "tu");        // OSC (ST)
});

test("trimTrailingBlankLines drops trailing empty/whitespace lines only", () => {
  assert.equal(trimTrailingBlankLines("a\nb\n\n  \n"), "a\nb");
  assert.equal(trimTrailingBlankLines("a\n\nb"), "a\n\nb");     // internal blanks kept
});

test("tailLines keeps the last N lines; <=0 returns all", () => {
  assert.equal(tailLines("1\n2\n3\n4", 2), "3\n4");
  assert.equal(tailLines("1\n2", 5), "1\n2");
  assert.equal(tailLines("1\n2\n3", 0), "1\n2\n3");
});

test("cap keeps the tail and prefixes a marker when over the limit", () => {
  const big = "x".repeat(MAX_TEXT + 10);
  const out = cap(big);
  assert.ok(out.startsWith("…[truncated]"));
  assert.ok(out.length < big.length);
  assert.equal(cap("short"), "short");
});

test("renderText prefers the capture; falls back to stripped, bounded ring", () => {
  assert.equal(renderText("clean screen", "ignored", {}), "clean screen");
  // empty capture (exited tmux pane) → strip + tail the ring
  const ring = Array.from({ length: SCREEN_ROWS + 5 }, (_, i) => `line${i}`).join("\n");
  const out = renderText("", `\x1b[32m${ring}\x1b[0m`, {});
  assert.ok(!out.includes("\x1b"));
  assert.equal(out.split("\n").length, SCREEN_ROWS);            // default bound
  assert.equal(renderText("", "1\n2\n3\n4", { lines: 2 }), "3\n4");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/daemon && pnpm test`
Expected: FAIL — `Cannot find module './text.ts'`.

- [ ] **Step 3: Implement `text.ts`**

`apps/daemon/src/mcp/text.ts`:

```ts
/** Leaf text helpers for clean (no-ANSI) rendered reads. Imports nothing. */

export const SCREEN_ROWS = 50;
export const MAX_TEXT = 64 * 1024;

/** Strip ANSI: CSI (incl. private/intermediate params) + OSC (BEL or ST terminated). */
export function stripAnsi(input: string): string {
  return input
    // OSC: ESC ] ... (BEL | ST)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    // CSI: ESC [ params intermediates final
    .replace(/\x1b\[[0-9;?>=]*[ -/]*[@-~]/g, "")
    // any stray single-char escape left over
    .replace(/\x1b[@-Z\\-_]/g, "");
}

/** Remove trailing blank/whitespace-only lines (keeps internal structure). */
export function trimTrailingBlankLines(s: string): string {
  const lines = s.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  return lines.join("\n");
}

/** Keep the last `lines` lines; `lines <= 0` (or non-finite) returns the input unchanged. */
export function tailLines(s: string, lines: number): string {
  if (!Number.isFinite(lines) || lines <= 0) {
    return s;
  }
  const arr = s.split("\n");
  return arr.length <= lines ? s : arr.slice(arr.length - lines).join("\n");
}

/** Bound the returned text; keep the most-recent `max` chars behind a head marker. */
export function cap(s: string, max = MAX_TEXT): string {
  return s.length <= max ? s : `…[truncated]\n${s.slice(s.length - max)}`;
}

/**
 * Clean rendered text for an agent read. `captured` is a tmux capture-pane result
 * (already clean when taken with escapes:false) — used as-is when non-empty. When
 * empty (exited/destroyed pane, transient empty capture, or non-tmux host) fall
 * back to the ANSI-stripped hot ring, bounded to `opts.lines` (default SCREEN_ROWS).
 */
export function renderText(captured: string, buffer: string, opts?: { lines?: number }): string {
  const body = captured || tailLines(stripAnsi(buffer), opts?.lines ?? SCREEN_ROWS);
  return cap(trimTrailingBlankLines(body));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/daemon && pnpm test`
Expected: PASS (all `text.test.ts` cases).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm check`
Expected: clean.

```bash
git add apps/daemon/src/mcp/text.ts apps/daemon/src/mcp/text.test.ts
git commit -m "feat(daemon/mcp): leaf clean-text helpers (stripAnsi/renderText)"
```

---

## Task 3: `mcp/keys.ts` — key encoder (TDD)

**Files:**
- Create: `apps/daemon/src/mcp/keys.ts`
- Test: `apps/daemon/src/mcp/keys.test.ts`

**Interfaces:**
- Produces: `encodeKey(name: string): string` — named keys + `C-<letter>` control codes; throws `Error("Unknown key …")` on miss.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/mcp/keys.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeKey } from "./keys.ts";

test("named keys map to bytes", () => {
  assert.equal(encodeKey("Enter"), "\r");
  assert.equal(encodeKey("Escape"), "\x1b");
  assert.equal(encodeKey("Up"), "\x1b[A");
  assert.equal(encodeKey("Space"), " ");
  assert.equal(encodeKey("Tab"), "\t");
  assert.equal(encodeKey("BackTab"), "\x1b[Z");
});

test("C-<letter> maps to a control code (case-insensitive)", () => {
  assert.equal(encodeKey("C-c"), "\x03");
  assert.equal(encodeKey("C-d"), "\x04");
  assert.equal(encodeKey("C-J"), "\n");          // Ctrl-J == newline
});

test("unknown keys throw", () => {
  assert.throws(() => encodeKey("Frobnicate"), /Unknown key/);
  assert.throws(() => encodeKey("C-1"), /Unknown key/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/daemon && pnpm test`
Expected: FAIL — `Cannot find module './keys.ts'`.

- [ ] **Step 3: Implement `keys.ts`**

`apps/daemon/src/mcp/keys.ts`:

```ts
/** Key-name → PTY bytes, so callers stay out of the ANSI-escaping business. */
const NAMED: Record<string, string> = {
  Enter: "\r", Tab: "\t", BackTab: "\x1b[Z", Escape: "\x1b", Backspace: "\x7f",
  Space: " ", Delete: "\x1b[3~",
  Up: "\x1b[A", Down: "\x1b[B", Right: "\x1b[C", Left: "\x1b[D",
  Home: "\x1b[H", End: "\x1b[F", PageUp: "\x1b[5~", PageDown: "\x1b[6~",
};

/** Encode one key name to bytes. `C-<a-z>` → its control code. Throws on miss. */
export function encodeKey(name: string): string {
  if (NAMED[name]) {
    return NAMED[name];
  }
  const m = /^C-([a-z])$/i.exec(name);
  if (m) {
    return String.fromCharCode(m[1].toLowerCase().charCodeAt(0) & 0x1f);
  }
  throw new Error(`Unknown key "${name}".`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/daemon && pnpm test`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm check`
Expected: clean.

```bash
git add apps/daemon/src/mcp/keys.ts apps/daemon/src/mcp/keys.test.ts
git commit -m "feat(daemon/mcp): key-name encoder"
```

---

## Task 4: Move `isValidName` / `assertInsideFsRoot` / `FsSandboxError` to `@orquester/config`

So `terminal-control.ts` can validate names + sandbox `create_tab`'s `cwd` without importing the 2000-line `index.ts`. Pure relocation + re-import; behavior unchanged.

**Files:**
- Modify: `packages/config/src/index.ts` (add the three; add `node:fs`/`node:path` value imports)
- Create: `packages/config/src/index.test.ts`
- Modify: `apps/daemon/src/index.ts` (delete the private defs at `:1878`, `:2079`, `:2114`; import from `@orquester/config`)

**Interfaces:**
- Produces: `isValidName(name: string | undefined): name is string`, `assertInsideFsRoot(root: string, target: string): Promise<string>`, `class FsSandboxError extends Error` — all exported from `@orquester/config`.
- Consumes (unchanged): index.ts's ~8 `isValidName` call sites, ~9 `assertInsideFsRoot` call sites, ~10 `FsSandboxError` `instanceof` checks.

- [ ] **Step 1: Write the failing tests**

`packages/config/src/index.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isValidName, assertInsideFsRoot, FsSandboxError } from "./index.ts";

test("isValidName rejects traversal and empties", () => {
  assert.equal(isValidName("project"), true);
  assert.equal(isValidName(".hidden"), false);
  assert.equal(isValidName("a/b"), false);
  assert.equal(isValidName("a\\b"), false);
  assert.equal(isValidName(""), false);
  assert.equal(isValidName(undefined), false);
});

test("assertInsideFsRoot allows in-root paths and rejects escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "fsroot-"));
  await mkdir(join(root, "ws"), { recursive: true });
  assert.equal(await assertInsideFsRoot(root, join(root, "ws")), join(root, "ws"));
  // not-yet-existing child still passes (deepest existing ancestor is realpath'd)
  assert.equal(await assertInsideFsRoot(root, join(root, "ws", "new")), join(root, "ws", "new"));
  await assert.rejects(() => assertInsideFsRoot(root, join(root, "..", "escape")), FsSandboxError);
  await assert.rejects(() => assertInsideFsRoot(root, "/etc"), FsSandboxError);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/config && node --import tsx --test src/index.test.ts`
Expected: FAIL — `isValidName`/`assertInsideFsRoot`/`FsSandboxError` are not exported from `@orquester/config`.

- [ ] **Step 3: Add the helpers to `@orquester/config`**

At the top of `packages/config/src/index.ts`, add (next to the existing `import { z } from "zod"`):

```ts
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join as pathJoin, relative, resolve, sep } from "node:path";
```

> Note: config already has a POSIX `joinPath`; import node:path's `join` **as `pathJoin`** to avoid a name clash.

At the end of the file, add (copied verbatim from `index.ts`, with `join` → `pathJoin`, and `export`ed):

```ts
/** Reject names that would escape the workspaces directory. */
export function isValidName(name: string | undefined): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    !name.startsWith(".") &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

/** Thrown when a path escapes its sandbox root. */
export class FsSandboxError extends Error {}

/**
 * Resolve `target` to a realpath and confirm it is inside `root` (also a
 * realpath). Rejects `..` traversal and symlink escapes. For not-yet-existing
 * targets the deepest existing ancestor is realpath'd, then the remaining
 * segments are appended. Throws FsSandboxError when outside the root.
 */
export async function assertInsideFsRoot(root: string, target: string): Promise<string> {
  const realRoot = await realpath(root).catch(() => resolve(root));
  const resolved = resolve(target);
  let ancestor = resolved;
  for (;;) {
    try {
      await realpath(ancestor);
      break;
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        break;
      }
      ancestor = parent;
    }
  }
  const realAncestor = await realpath(ancestor).catch(() => ancestor);
  const tail = relative(ancestor, resolved);
  const finalPath = tail ? pathJoin(realAncestor, tail) : realAncestor;
  const rel = relative(realRoot, finalPath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new FsSandboxError(`Path is outside the sandbox: ${target}`);
  }
  return finalPath;
}
```

- [ ] **Step 4: Run the config tests to verify they pass**

Run: `cd packages/config && node --import tsx --test src/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Re-point `index.ts` at the moved helpers**

In `apps/daemon/src/index.ts`:
1. **Delete** the three private definitions: `isValidName` (`:1878`), `assertInsideFsRoot` (`:2079`), and `class FsSandboxError` (`:2114`).
2. Add them to the existing `@orquester/config` import (find the line `import { … } from "@orquester/config";` near the top and extend its named list):

```ts
import { /* …existing… */, isValidName, assertInsideFsRoot, FsSandboxError } from "@orquester/config";
```

All ~8 `isValidName`, ~9 `assertInsideFsRoot`, and ~10 `instanceof FsSandboxError` call sites are unchanged (same names, single class identity across modules → `instanceof` still works).

- [ ] **Step 6: Typecheck (the real gate for this task)**

Run: `pnpm check`
Expected: clean — no "duplicate identifier", no "cannot find name `isValidName`/`assertInsideFsRoot`/`FsSandboxError`". If `tsc` flags an unused import in config (e.g. `pathJoin`), it is used by `assertInsideFsRoot` — re-check the rename.

- [ ] **Step 7: Commit**

```bash
git add packages/config/src/index.ts packages/config/src/index.test.ts apps/daemon/src/index.ts
git commit -m "refactor(config): move isValidName/assertInsideFsRoot/FsSandboxError to @orquester/config"
```

---

## Task 5: `tmux.ts` — `capturePane` options (back-compatible)

Let the read path ask for **plain** text and a bounded line range, keeping the existing zero-arg behavior (full history, with colors) for the xterm replay path.

**Files:**
- Modify: `apps/daemon/src/tmux.ts` (`capturePane` at `:213`)
- Test: `apps/daemon/src/tmux.test.ts` (new — argv builder only)

**Interfaces:**
- Produces: `capturePane(id: string, opts?: { escapes?: boolean; lines?: number | "all" }): Promise<string>` and a pure exported `captureArgs(name: string, opts?): string[]` (so the argv logic is unit-testable without tmux).
- Consumes: existing caller `scrollback()` (`sessions.ts:298`) passes no opts → unchanged.

- [ ] **Step 1: Write the failing test (pure argv builder)**

`apps/daemon/src/tmux.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureArgs } from "./tmux.ts";

test("default args: colors + full history (back-compatible)", () => {
  assert.deepEqual(captureArgs("orq-x"), ["capture-pane", "-p", "-e", "-J", "-S", "-", "-t", "orq-x"]);
});

test("escapes:false drops -e (plain text)", () => {
  assert.deepEqual(captureArgs("orq-x", { escapes: false, lines: "all" }),
    ["capture-pane", "-p", "-J", "-S", "-", "-t", "orq-x"]);
});

test("lines:0 → current screen (-S 0); lines:N → -S -N", () => {
  assert.deepEqual(captureArgs("orq-x", { escapes: false, lines: 0 }),
    ["capture-pane", "-p", "-J", "-S", "0", "-t", "orq-x"]);
  assert.deepEqual(captureArgs("orq-x", { escapes: false, lines: 40 }),
    ["capture-pane", "-p", "-J", "-S", "-40", "-t", "orq-x"]);
});
```

> Note: `captureArgs` takes the **already-prefixed** tmux name (`orq-<id>`), matching how `capturePane` calls `tmuxName(id)`. The test passes `"orq-x"` directly.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/daemon && pnpm test`
Expected: FAIL — `captureArgs` is not exported.

- [ ] **Step 3: Implement the options + extract `captureArgs`**

Replace `capturePane` (`apps/daemon/src/tmux.ts:213-218`) with:

```ts
  /**
   * Visible + scrollback text of a session's pane (empty if gone).
   * Defaults preserve the xterm replay path: colors (-e) + full history (-S -).
   * For agent reads pass { escapes:false } (plain text) and { lines } to bound
   * the range: lines:0 ⇒ current screen (-S 0), lines:N ⇒ last N rows (-S -N).
   */
  async capturePane(
    id: string,
    opts: { escapes?: boolean; lines?: number | "all" } = {}
  ): Promise<string> {
    const result = await this.run(captureArgs(tmuxName(id), opts));
    return result.code === 0 ? result.stdout : "";
  }
```

And add a module-level **exported** pure helper (top-level, not a class method — e.g. just below the existing `tmuxName` export):

```ts
/** Build the `capture-pane` argv. Pure (testable without tmux). `name` is the full orq-<id>. */
export function captureArgs(
  name: string,
  opts: { escapes?: boolean; lines?: number | "all" } = {}
): string[] {
  const { escapes = true, lines = "all" } = opts;
  const start = lines === "all" ? "-" : String(-Math.max(0, lines)); // "-" | "0" | "-N"
  const args = ["capture-pane", "-p", "-J", "-S", start, "-t", name];
  if (escapes) {
    args.splice(2, 0, "-e"); // colors only when asked
  }
  return args;
}
```

> `-Math.max(0, lines)` yields `"0"` for `lines:0` and `"-N"` for `lines:N` (`String(-0)` is `"0"`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/daemon && pnpm test`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm check`
Expected: clean (the existing `scrollback()` caller still type-checks — `opts` is optional).

```bash
git add apps/daemon/src/tmux.ts apps/daemon/src/tmux.test.ts
git commit -m "feat(daemon/tmux): capturePane options (plain text + line range)"
```

---

## Task 6: `sessions.ts` — `captureText` on the backend

Add a clean-text read to the `ISessionManager` contract + both backends, so the MCP layer never imports tmux. Mirrors `scrollback()`'s `!session` guard + `captured || buffer` fallback, delegating the pure composition to `renderText` (Task 2).

**Files:**
- Modify: `apps/daemon/src/sessions.ts` (interface `:37`, `SessionManager`, `LocalSessionManager`)

**Interfaces:**
- Produces: `captureText(id: string, opts?: { lines?: number }): Promise<string>` on `ISessionManager` and both implementations.
- Consumes: `renderText` from `./mcp/text.ts`; `capturePane(id, { escapes, lines })` from Task 5.

- [ ] **Step 1: Add the import + interface method**

In `apps/daemon/src/sessions.ts`, add to the imports:

```ts
import { renderText } from "./mcp/text.ts";
```

In `interface ISessionManager` (after `scrollback`, `:44`), add:

```ts
  /** Clean (no-ANSI) rendered text: current screen + last `lines` of scrollback. */
  captureText(id: string, opts?: { lines?: number }): Promise<string>;
```

- [ ] **Step 2: Implement on the tmux `SessionManager`**

Add a method to `SessionManager` (next to `scrollback`, after `:304`):

```ts
  /**
   * Clean rendered text for an agent read. A running tmux pane renders cleanly via
   * capture-pane (escapes:false); an exited pane is destroyed (remain-on-exit off)
   * and a running capture can transiently return "" — both fall back to the
   * ANSI-stripped hot ring, bounded by `lines`. Mirrors scrollback()'s !session
   * guard so a close() mid-call returns "" instead of throwing.
   */
  async captureText(id: string, opts?: { lines?: number }): Promise<string> {
    const session = this.sessions.get(id);
    if (!session) {
      return "";
    }
    const captured =
      session.summary.status === "running"
        ? await this.tmux.capturePane(id, { escapes: false, lines: opts?.lines ?? 0 })
        : "";
    return renderText(captured, session.buffer, opts);
  }
```

- [ ] **Step 3: Implement on the `LocalSessionManager`**

Add to `LocalSessionManager` (next to its `scrollback`, after `:669`):

```ts
  /** No tmux here — always the ANSI-stripped hot ring (bounded by `lines`). */
  async captureText(id: string, opts?: { lines?: number }): Promise<string> {
    const session = this.sessions.get(id);
    if (!session) {
      return "";
    }
    return renderText("", session.buffer, opts);
  }
```

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: clean. Both backends now satisfy `ISessionManager` (the new method is implemented on each). If `tsc` reports `LocalSessionManager`/`SessionManager` missing a member, the method was added to the wrong class — verify both.

> Behavioral coverage: `renderText`'s fallback/bounding is already unit-tested (Task 2); the `!session` guard + tmux wiring are verified by `pnpm check` here and the manual checklist (Task 12). The `TerminalControl` tests (Tasks 7-9) exercise `captureText` through a fake manager.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/sessions.ts
git commit -m "feat(daemon/sessions): captureText clean-text read on both backends"
```

---

## Task 7: `terminal-control.ts` — resolve + read + write + list (TDD)

The core module's foundation: the constructor/deps, typed errors, `resolveTab` (name-first, id fallback, prefer-running, ambiguity is fatal), and the simple `readTerminal`/`writeInput`/`sendKeys`/`listTabs`/`listLaunchers`. Tested against a fake `ISessionManager`.

**Files:**
- Create: `apps/daemon/src/mcp/terminal-control.ts`
- Test: `apps/daemon/src/mcp/terminal-control.test.ts`

**Interfaces:**
- Produces:
  - `class TabNotFound extends Error`, `class AmbiguousTab extends Error`, `class ToolError extends Error`
  - `interface TerminalControlDeps { sessions: ISessionManager; registry: RegistryService; workspacesDir: string; fsRoot: string; listWorkspaces: () => Promise<WorkspaceSummary[]>; listProjects: (workspace: string) => Promise<ProjectSummary[]>; }`
  - `class TerminalControl` with `resolveTab(sel)`, `readTerminal(sel, opts?)`, `writeInput(sel, data, opts?)`, `sendKeys(sel, keys)`, `listTabs(sel)`, `listLaunchers()` (this task) + `waitForIdle`/`sendAndWait` (Task 8) + `createTab`/`closeTab` (Task 9).
  - `type TabSelector = { workspace?: string; project?: string; tab?: string; tabId?: string }`
- Consumes: `isValidName` (`@orquester/config`), `encodeKey` (`./keys.ts`), type-only `ISessionManager` (`../sessions`), type-only `RegistryService` (`../registry`), type-only `SessionSummary`/`WorkspaceSummary`/`ProjectSummary` (`@orquester/api`).

- [ ] **Step 1: Write the failing tests (incl. the fake manager harness)**

`apps/daemon/src/mcp/terminal-control.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CreateSessionRequest, SessionSummary } from "@orquester/api";
import type { ISessionManager } from "../sessions.ts";
import { TerminalControl, TabNotFound, AmbiguousTab, ToolError, type TerminalControlDeps } from "./terminal-control.ts";

// A drivable fake ISessionManager: in-memory sessions + a per-id output/exit emitter.
export class FakeManager implements Partial<ISessionManager> {
  tabs: SessionSummary[] = [];
  inputs: { id: string; data: string }[] = [];
  closed: string[] = [];
  created: CreateSessionRequest[] = [];
  texts = new Map<string, string>();
  private subs = new Map<string, { out: (d: string) => void; exit: (c: number) => void }[]>();

  add(s: Partial<SessionSummary> & { id: string; title: string; projectPath: string }): SessionSummary {
    const full: SessionSummary = {
      kind: "shell", refId: "bash", cwd: "", cols: 80, rows: 24, status: "running",
      order: this.tabs.length, createdAt: new Date(2026, 0, 1).toISOString(), ...s,
    } as SessionSummary;
    this.tabs.push(full);
    return full;
  }
  list(projectPath?: string) {
    return projectPath === undefined ? [...this.tabs] : this.tabs.filter((t) => t.projectPath === projectPath);
  }
  get(id: string) { return this.tabs.find((t) => t.id === id); }
  input(id: string, data: string) { this.inputs.push({ id, data }); }
  close(id: string) { this.closed.push(id); return true; }
  async captureText(id: string) { return this.texts.get(id) ?? ""; }
  subscribe(id: string, out: (d: string) => void, exit: (c: number) => void) {
    const arr = this.subs.get(id) ?? [];
    arr.push({ out, exit });
    this.subs.set(id, arr);
    return () => { this.subs.set(id, (this.subs.get(id) ?? []).filter((s) => s.out !== out)); };
  }
  emitOutput(id: string, data: string) { (this.subs.get(id) ?? []).forEach((s) => s.out(data)); }
  emitExit(id: string, code = 0) { (this.subs.get(id) ?? []).forEach((s) => s.exit(code)); }
  subscriberCount(id: string) { return (this.subs.get(id) ?? []).length; }
}

function make(fake: FakeManager, extra?: Partial<TerminalControlDeps>) {
  const deps: TerminalControlDeps = {
    sessions: fake as unknown as ISessionManager,
    registry: { get: () => undefined, list: () => ({ shells: [], agents: [], ides: [], fileExplorers: [], browsers: [] }) } as any,
    workspacesDir: "/ws",
    fsRoot: "/ws",
    listWorkspaces: async () => [],
    listProjects: async () => [],
    ...extra,
  };
  return new TerminalControl(deps);
}

test("resolveTab: by tabId", () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  assert.equal(make(f).resolveTab({ tabId: "a" }).id, "a");
  assert.throws(() => make(f).resolveTab({ tabId: "nope" }), TabNotFound);
});

test("resolveTab: name match is case-insensitive", () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  assert.equal(make(f).resolveTab({ workspace: "w", project: "p", tab: "claude" }).id, "a");
});

test("resolveTab: missing selector pieces → ToolError", () => {
  assert.throws(() => make(new FakeManager()).resolveTab({ workspace: "w" }), ToolError);
});

test("resolveTab: invalid names → TabNotFound", () => {
  assert.throws(() => make(new FakeManager()).resolveTab({ workspace: "..", project: "p", tab: "x" }), TabNotFound);
});

test("resolveTab: no match lists open tabs", () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "bash", projectPath: "/ws/w/p" });
  assert.throws(() => make(f).resolveTab({ workspace: "w", project: "p", tab: "zsh" }), /Open tabs: bash/);
});

test("resolveTab: prefers the single running tab over exited duplicates", () => {
  const f = new FakeManager();
  f.add({ id: "old", title: "bash", projectPath: "/ws/w/p", status: "exited" });
  f.add({ id: "live", title: "bash", projectPath: "/ws/w/p", status: "running" });
  assert.equal(make(f).resolveTab({ workspace: "w", project: "p", tab: "bash" }).id, "live");
});

test("resolveTab: ambiguous among running → AmbiguousTab with ids", () => {
  const f = new FakeManager();
  f.add({ id: "r1", title: "bash", projectPath: "/ws/w/p", status: "running" });
  f.add({ id: "r2", title: "bash", projectPath: "/ws/w/p", status: "running" });
  assert.throws(() => make(f).resolveTab({ workspace: "w", project: "p", tab: "bash" }), AmbiguousTab);
});

test("readTerminal returns clean text + status", async () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  f.texts.set("a", "hello");
  const r = await make(f).readTerminal({ tabId: "a" });
  assert.equal(r.text, "hello");
  assert.equal(r.status, "running");
});

test("writeInput appends CR only when submit", () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  const tc = make(f);
  tc.writeInput({ tabId: "a" }, "ls");
  tc.writeInput({ tabId: "a" }, "ls", { submit: true });
  assert.deepEqual(f.inputs, [{ id: "a", data: "ls" }, { id: "a", data: "ls\r" }]);
});

test("sendKeys encodes; unknown key → ToolError", () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  const tc = make(f);
  tc.sendKeys({ tabId: "a" }, ["C-c", "Enter"]);
  assert.deepEqual(f.inputs.at(-1), { id: "a", data: "\x03\r" });
  assert.throws(() => tc.sendKeys({ tabId: "a" }, ["Nope"]), ToolError);
});

test("listLaunchers returns only enabled shells+agents", () => {
  const f = new FakeManager();
  const registry = { get: () => undefined, list: () => ({
    shells: [{ id: "bash", name: "bash", kind: "shell", enabled: true }],
    agents: [{ id: "claude", name: "Claude", kind: "agent", enabled: true, version: "1.2.3" },
             { id: "off", name: "Off", kind: "agent", enabled: false }],
    ides: [{ id: "code", name: "VS Code", kind: "ide", enabled: true }],
    fileExplorers: [], browsers: [],
  }) } as any;
  const out = make(f, { registry }).listLaunchers();
  assert.deepEqual(out.map((l) => l.id), ["bash", "claude"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/daemon && pnpm test`
Expected: FAIL — `Cannot find module './terminal-control.ts'`.

- [ ] **Step 3: Implement the foundation of `terminal-control.ts`**

`apps/daemon/src/mcp/terminal-control.ts`:

```ts
import { join } from "node:path";
import { statSync } from "node:fs";
import type { ProjectSummary, SessionSummary, WorkspaceSummary } from "@orquester/api";
import { assertInsideFsRoot, FsSandboxError, isValidName } from "@orquester/config";
import type { ISessionManager } from "../sessions.ts";
import type { RegistryService } from "../registry.ts";
import { encodeKey } from "./keys.ts";

/** A tab is addressed by (workspace,project,tab) name, or by opaque tabId. */
export type TabSelector = { workspace?: string; project?: string; tab?: string; tabId?: string };

/** No such tab/project (message includes the available titles). */
export class TabNotFound extends Error {}
/** Name resolves to >1 running tab (message includes the {title=id} list). */
export class AmbiguousTab extends Error {}
/** Generic tool-level reject with a safe, surfaceable message (bad selector, launcher kind, tab limit). */
export class ToolError extends Error {}

export const MAX_TABS_PER_PROJECT = 24;

export interface TerminalControlDeps {
  sessions: ISessionManager;
  registry: RegistryService;
  /** (workspace,project) → projectPath via join (matches how sessions are created). */
  workspacesDir: string;
  /** Sandbox root for create_tab's cwd (resolved.fsRoot — may differ from workspacesDir). */
  fsRoot: string;
  listWorkspaces: () => Promise<WorkspaceSummary[]>;
  listProjects: (workspace: string) => Promise<ProjectSummary[]>;
}

/** node:fs statSync that returns undefined instead of throwing on ENOENT. */
function statSafe(p: string) {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
}

export class TerminalControl {
  constructor(private readonly deps: TerminalControlDeps) {}

  /** Name-first, id fallback. Prefers a running match; ambiguity is fatal (never guesses). */
  resolveTab(sel: TabSelector): SessionSummary {
    const { sessions, workspacesDir } = this.deps;
    if (sel.tabId) {
      const s = sessions.get(sel.tabId);
      if (!s) {
        throw new TabNotFound(`No tab with id ${sel.tabId}.`);
      }
      return s;
    }
    if (!sel.workspace || !sel.project || !sel.tab) {
      throw new ToolError("Provide tabId, or all of workspace+project+tab.");
    }
    if (!isValidName(sel.workspace) || !isValidName(sel.project)) {
      throw new TabNotFound("Invalid workspace/project name.");
    }
    const projectPath = join(workspacesDir, sel.workspace, sel.project);
    const tabs = sessions.list(projectPath);
    let matches = tabs.filter((t) => t.title.toLowerCase() === sel.tab!.toLowerCase());
    if (matches.length === 0) {
      throw new TabNotFound(
        `No tab "${sel.tab}". Open tabs: ${tabs.map((t) => t.title).join(", ") || "(none)"}.`
      );
    }
    // Exited tabs linger until close(), so prefer running to avoid permanent ambiguity.
    const running = matches.filter((m) => m.status === "running");
    if (running.length === 1) {
      return running[0];
    }
    matches = running.length ? running : matches;
    if (matches.length > 1) {
      throw new AmbiguousTab(
        `"${sel.tab}" is ambiguous (${matches.length}). Retry with tabId: ` +
          matches.map((m) => `${m.title}=${m.id} (${m.status})`).join(", ")
      );
    }
    return matches[0];
  }

  async readTerminal(sel: TabSelector, opts?: { lines?: number }) {
    const t = this.resolveTab(sel);
    const text = await this.deps.sessions.captureText(t.id, { lines: opts?.lines ?? 0 });
    return { text, status: t.status, exitCode: t.exitCode, cols: t.cols, rows: t.rows };
  }

  writeInput(sel: TabSelector, data: string, opts?: { submit?: boolean }) {
    const t = this.resolveTab(sel);
    this.deps.sessions.input(t.id, opts?.submit ? `${data}\r` : data); // Enter == CR in a PTY
    return { ok: true as const };
  }

  sendKeys(sel: TabSelector, keys: string[]) {
    const t = this.resolveTab(sel);
    let encoded: string;
    try {
      encoded = keys.map(encodeKey).join("");
    } catch (e) {
      throw new ToolError(e instanceof Error ? e.message : "Unknown key.");
    }
    this.deps.sessions.input(t.id, encoded);
    return { ok: true as const };
  }

  listTabs(sel: { workspace: string; project: string }) {
    if (!isValidName(sel.workspace) || !isValidName(sel.project)) {
      throw new TabNotFound("Invalid workspace/project name.");
    }
    const projectPath = join(this.deps.workspacesDir, sel.workspace, sel.project);
    return this.deps.sessions.list(projectPath).map((t) => ({
      id: t.id, title: t.title, kind: t.kind, refId: t.refId,
      status: t.status, exitCode: t.exitCode, order: t.order,
    }));
  }

  listLaunchers() {
    const r = this.deps.registry.list();
    return [...r.shells, ...r.agents]
      .filter((e) => e.enabled)
      .map((e) => ({ id: e.id, name: e.name, kind: e.kind, version: e.version }));
  }
}
```

> `FsSandboxError`/`assertInsideFsRoot`/`statSafe`/`MAX_TABS_PER_PROJECT` are imported/declared now and used by `createTab` in Task 9; `tsc` will flag them unused until then — that's expected within this task and resolved by Task 9. (If your reviewer fails the build on unused imports, add `createTab`/`closeTab` stubs here; otherwise leave them — `noUnusedLocals` is off in this repo's `tsconfig.base.json`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/daemon && pnpm test`
Expected: PASS (all `terminal-control.test.ts` cases in this task).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm check`
Expected: clean.

```bash
git add apps/daemon/src/mcp/terminal-control.ts apps/daemon/src/mcp/terminal-control.test.ts
git commit -m "feat(daemon/mcp): TerminalControl resolve/read/write/list"
```

---

## Task 8: `terminal-control.ts` — the idle engine (`waitForIdle`/`sendAndWait`) (TDD)

Event-driven debounce with a hard cap and **cancellation cleanup** — the trickiest logic in the feature, and exactly what `node:test` fake timers are for.

**Files:**
- Modify: `apps/daemon/src/mcp/terminal-control.ts`
- Modify: `apps/daemon/src/mcp/terminal-control.test.ts`

**Interfaces:**
- Produces:
  - `type WaitResult = { text: string; settled: boolean; status: SessionSummary["status"]; exitCode?: number; aborted?: boolean }`
  - `waitForIdle(sel, opts?: { idleMs?: number; timeoutMs?: number; lines?: number; signal?: AbortSignal }): Promise<WaitResult>`
  - `sendAndWait(sel, data, opts?: { submit?: boolean; idleMs?: number; timeoutMs?: number; lines?: number; signal?: AbortSignal }): Promise<WaitResult>`
  - consts `DEFAULT_IDLE_MS = 1000`, `DEFAULT_TIMEOUT_MS = 120_000`, `MAX_TIMEOUT_MS = 600_000`

- [ ] **Step 1: Write the failing tests (fake timers + drivable emitter)**

Append to `apps/daemon/src/mcp/terminal-control.test.ts`:

```ts
import { mock } from "node:test";

test("waitForIdle settles after idleMs of quiet, returns captured text", async () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  f.texts.set("a", "done");
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const p = make(f).waitForIdle({ tabId: "a" }, { idleMs: 1000, timeoutMs: 5000 });
    f.emitOutput("a", "working...");
    mock.timers.tick(500);
    f.emitOutput("a", "more");      // re-arms the idle timer
    mock.timers.tick(1000);          // 1000ms quiet → settle
    const r = await p;
    assert.equal(r.settled, true);
    assert.equal(r.text, "done");
    assert.equal(r.status, "running");
    assert.equal(f.subscriberCount("a"), 0); // unsubscribed
  } finally {
    mock.timers.reset();
  }
});

test("waitForIdle: exit settles immediately with status exited", async () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "bash", projectPath: "/ws/w/p" });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const p = make(f).waitForIdle({ tabId: "a" }, { idleMs: 1000 });
    f.tabs[0].status = "exited";
    f.tabs[0].exitCode = 0;
    f.emitExit("a", 0);
    const r = await p;
    assert.equal(r.settled, true);
    assert.equal(r.status, "exited");
  } finally {
    mock.timers.reset();
  }
});

test("waitForIdle: hard cap → settled:false", async () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const p = make(f).waitForIdle({ tabId: "a" }, { idleMs: 10_000, timeoutMs: 2000 });
    f.emitOutput("a", "still going");
    mock.timers.tick(2000);          // cap fires before idle
    const r = await p;
    assert.equal(r.settled, false);
  } finally {
    mock.timers.reset();
  }
});

test("waitForIdle: abort returns aborted, skips capture, cleans up", async () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  const ac = new AbortController();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const p = make(f).waitForIdle({ tabId: "a" }, { idleMs: 10_000, signal: ac.signal });
    ac.abort();
    const r = await p;
    assert.equal(r.aborted, true);
    assert.equal(r.settled, false);
    assert.equal(r.text, "");
    assert.equal(f.subscriberCount("a"), 0);
  } finally {
    mock.timers.reset();
  }
});

test("sendAndWait writes input (with CR on submit) before waiting", async () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  f.texts.set("a", "4");
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const p = make(f).sendAndWait({ tabId: "a" }, "2+2", { submit: true, idleMs: 500 });
    assert.deepEqual(f.inputs.at(-1), { id: "a", data: "2+2\r" }); // wrote before waiting
    mock.timers.tick(500);
    const r = await p;
    assert.equal(r.text, "4");
    assert.equal(r.settled, true);
  } finally {
    mock.timers.reset();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/daemon && pnpm test`
Expected: FAIL — `waitForIdle`/`sendAndWait` are not functions.

- [ ] **Step 3: Implement the idle engine**

Add the consts (top of `terminal-control.ts`, after the imports) and the methods (inside the `TerminalControl` class). First the consts + result type:

```ts
const DEFAULT_IDLE_MS = 1000;
const DEFAULT_TIMEOUT_MS = 120_000; // 2 min
const MAX_TIMEOUT_MS = 600_000;     // 10 min ceiling

export type WaitResult = {
  text: string;
  settled: boolean;
  status: SessionSummary["status"];
  exitCode?: number;
  aborted?: boolean;
};
```

Then, inside the class, a shared private waiter + the two public methods:

```ts
  /** Subscribe → debounce on output → resolve on idle/exit/cap/abort. Shared by both waits. */
  private async runWait(id: string, opts: { idleMs?: number; timeoutMs?: number; signal?: AbortSignal }) {
    const { sessions } = this.deps;
    const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    const timeoutMs = Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const sig = opts.signal;
    return new Promise<boolean>((resolve) => {
      let idleTimer: ReturnType<typeof setTimeout>;
      let resolved = false;
      const done = (ok: boolean) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(idleTimer);
        clearTimeout(hardTimer);
        unsub();
        sig?.removeEventListener("abort", onAbort);
        resolve(ok);
      };
      const arm = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => done(true), idleMs);
      };
      const onAbort = () => done(false);
      const hardTimer = setTimeout(() => done(false), timeoutMs);
      const unsub = sessions.subscribe(id, () => arm(), () => done(true)); // output re-arms; exit settles
      sig?.addEventListener("abort", onAbort, { once: true });
      if (sig?.aborted) {
        done(false);
        return;
      }
      arm(); // start the idle countdown immediately
    });
  }

  /** Pure wait (no write) — the re-invoke path. Inspect `text` for a prompt regardless of `settled`. */
  async waitForIdle(
    sel: TabSelector,
    opts?: { idleMs?: number; timeoutMs?: number; lines?: number; signal?: AbortSignal }
  ): Promise<WaitResult> {
    const t = this.resolveTab(sel);
    const settled = await this.runWait(t.id, opts ?? {});
    if (opts?.signal?.aborted) {
      // Don't fabricate "exited"; don't touch a dead transport.
      return { text: "", settled: false, aborted: true, status: this.deps.sessions.get(t.id)?.status ?? "exited" };
    }
    const after = this.deps.sessions.get(t.id);
    const text = await this.deps.sessions.captureText(t.id, { lines: opts?.lines ?? 0 });
    return { text, settled, status: after?.status ?? "exited", exitCode: after?.exitCode };
  }

  /** Write input, then wait. Subscribes BEFORE writing so the response is never missed. */
  async sendAndWait(
    sel: TabSelector,
    data: string,
    opts?: { submit?: boolean; idleMs?: number; timeoutMs?: number; lines?: number; signal?: AbortSignal }
  ): Promise<WaitResult> {
    const t = this.resolveTab(sel);
    const { sessions } = this.deps;
    const idleMs = opts?.idleMs ?? DEFAULT_IDLE_MS;
    const timeoutMs = Math.min(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const sig = opts?.signal;
    const settled = await new Promise<boolean>((resolve) => {
      let idleTimer: ReturnType<typeof setTimeout>;
      let resolved = false;
      const done = (ok: boolean) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(idleTimer);
        clearTimeout(hardTimer);
        unsub();
        sig?.removeEventListener("abort", onAbort);
        resolve(ok);
      };
      const arm = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => done(true), idleMs);
      };
      const onAbort = () => done(false);
      const hardTimer = setTimeout(() => done(false), timeoutMs);
      const unsub = sessions.subscribe(t.id, () => arm(), () => done(true));
      sig?.addEventListener("abort", onAbort, { once: true });
      if (sig?.aborted) {
        done(false);
        return;
      }
      // Subscribe is in place — now write, then start the idle countdown.
      sessions.input(t.id, opts?.submit ? `${data}\r` : data);
      arm();
    });
    if (sig?.aborted) {
      return { text: "", settled: false, aborted: true, status: sessions.get(t.id)?.status ?? "exited" };
    }
    const after = sessions.get(t.id);
    const text = await sessions.captureText(t.id, { lines: opts?.lines ?? 0 });
    return { text, settled, status: after?.status ?? "exited", exitCode: after?.exitCode };
  }
```

> `sendAndWait` deliberately inlines the waiter (rather than calling `runWait`) so the `sessions.input(...)` write happens *after* `subscribe` but *before* `arm()` — guaranteeing the input's own echo can't be missed. The two waiters are otherwise identical; keep them in sync.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/daemon && pnpm test`
Expected: PASS (idle/exit/cap/abort/sendAndWait cases).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm check`
Expected: clean.

```bash
git add apps/daemon/src/mcp/terminal-control.ts apps/daemon/src/mcp/terminal-control.test.ts
git commit -m "feat(daemon/mcp): event-driven idle engine (waitForIdle/sendAndWait)"
```

---

## Task 9: `terminal-control.ts` — `createTab`/`closeTab` (TDD)

The security-sensitive surface: `cwd` sandboxed to `fsRoot` (awaited, correctly-ordered), `refId` restricted to shell/agent, per-project count cap.

**Files:**
- Modify: `apps/daemon/src/mcp/terminal-control.ts`
- Modify: `apps/daemon/src/mcp/terminal-control.test.ts`

**Interfaces:**
- Produces:
  - `createTab(sel: { workspace: string; project: string }, opts: { refId: string; title?: string; cwd?: string }): Promise<SessionSummary>`
  - `closeTab(sel: TabSelector): { closed: true }`

- [ ] **Step 1: Write the failing tests**

Append to `apps/daemon/src/mcp/terminal-control.test.ts` (uses a real temp dir so `assertInsideFsRoot` realpaths actually run):

```ts
import { tmpdir } from "node:os";
import { mkdtemp, mkdir } from "node:fs/promises";

function registryWith(entries: Record<string, { kind: string; enabled: boolean }>) {
  return {
    get: (id: string) => (entries[id] ? { id, name: id, ...entries[id] } : undefined),
    list: () => ({ shells: [], agents: [], ides: [], fileExplorers: [], browsers: [] }),
  } as any;
}

test("createTab: launches a shell/agent in the project dir", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc-"));
  await mkdir(join(root, "w", "p"), { recursive: true });
  const f = new FakeManager();
  f.create = (req) => { f.created.push(req); return f.add({ id: "new", title: req.title ?? "bash", projectPath: req.projectPath ?? "" }); };
  const tc = make(f, { workspacesDir: root, fsRoot: root, registry: registryWith({ bash: { kind: "shell", enabled: true } }) });
  const s = await tc.createTab({ workspace: "w", project: "p" }, { refId: "bash" });
  assert.equal(s.id, "new");
  assert.equal(f.created[0].projectPath, join(root, "w", "p"));
  assert.equal(f.created[0].cwd, join(root, "w", "p"));
});

test("createTab: rejects a non-existent project (no ghost tab)", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc-"));
  const f = new FakeManager();
  f.create = () => { throw new Error("should not be called"); };
  const tc = make(f, { workspacesDir: root, fsRoot: root, registry: registryWith({ bash: { kind: "shell", enabled: true } }) });
  await assert.rejects(() => tc.createTab({ workspace: "w", project: "missing" }, { refId: "bash" }), TabNotFound);
});

test("createTab: rejects a cwd outside fsRoot", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc-"));
  await mkdir(join(root, "w", "p"), { recursive: true });
  const f = new FakeManager();
  f.create = () => { throw new Error("should not be called"); };
  const tc = make(f, { workspacesDir: root, fsRoot: root, registry: registryWith({ bash: { kind: "shell", enabled: true } }) });
  await assert.rejects(() => tc.createTab({ workspace: "w", project: "p" }, { refId: "bash", cwd: "/etc" }), FsSandboxError);
});

test("createTab: rejects a non-shell/agent refId", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc-"));
  await mkdir(join(root, "w", "p"), { recursive: true });
  const f = new FakeManager();
  const tc = make(f, { workspacesDir: root, fsRoot: root, registry: registryWith({ code: { kind: "ide", enabled: true } }) });
  await assert.rejects(() => tc.createTab({ workspace: "w", project: "p" }, { refId: "code" }), ToolError);
});

test("createTab: rejects past the per-project cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc-"));
  await mkdir(join(root, "w", "p"), { recursive: true });
  const f = new FakeManager();
  for (let i = 0; i < 24; i++) f.add({ id: `t${i}`, title: "bash", projectPath: join(root, "w", "p"), status: "running" });
  const tc = make(f, { workspacesDir: root, fsRoot: root, registry: registryWith({ bash: { kind: "shell", enabled: true } }) });
  await assert.rejects(() => tc.createTab({ workspace: "w", project: "p" }, { refId: "bash" }), ToolError);
});

test("closeTab: closes the resolved tab", () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  make(f).closeTab({ tabId: "a" });
  assert.deepEqual(f.closed, ["a"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/daemon && pnpm test`
Expected: FAIL — `createTab`/`closeTab` are not functions.

- [ ] **Step 3: Implement `createTab`/`closeTab`**

Add to the `TerminalControl` class:

```ts
  /**
   * Launch a new tab (shell/agent) in a project. Async because assertInsideFsRoot
   * realpaths — it MUST be awaited (un-awaited + swapped args would bypass the
   * sandbox AND crash-loop the daemon via an unhandled rejection).
   */
  async createTab(
    sel: { workspace: string; project: string },
    opts: { refId: string; title?: string; cwd?: string }
  ): Promise<SessionSummary> {
    const { sessions, registry, workspacesDir, fsRoot } = this.deps;
    if (!isValidName(sel.workspace) || !isValidName(sel.project)) {
      throw new TabNotFound("Invalid workspace/project name.");
    }
    const projectPath = join(workspacesDir, sel.workspace, sel.project);
    if (!statSafe(projectPath)?.isDirectory()) {
      // A FILE would pass existsSync then fail async in tmux — reject cleanly first.
      throw new TabNotFound(`No project "${sel.project}" in "${sel.workspace}".`);
    }
    // SECURITY: assertInsideFsRoot(ROOT, target), async, awaited, root = fsRoot.
    const cwd = await assertInsideFsRoot(fsRoot, opts.cwd ?? projectPath); // throws FsSandboxError
    // Only launch SESSION kinds: create() checks resolvedBin+enabled but NOT kind,
    // so a bare create() would launch an ide/browser, and claude/codex carry
    // --dangerously-skip-permissions/--yolo. Restrict to what list_launchers shows.
    const entry = registry.get(opts.refId);
    if (!entry?.enabled || (entry.kind !== "shell" && entry.kind !== "agent")) {
      throw new ToolError(`"${opts.refId}" is not a launchable shell or agent.`);
    }
    // Count cap — sessions persist across restart and reattach() re-spawns them all.
    const running = sessions.list(projectPath).filter((s) => s.status === "running").length;
    if (running >= MAX_TABS_PER_PROJECT) {
      throw new ToolError(`Tab limit reached for "${sel.project}" (${MAX_TABS_PER_PROJECT}).`);
    }
    return sessions.create({ kind: entry.kind, refId: opts.refId, projectPath, cwd, title: opts.title });
  }

  closeTab(sel: TabSelector) {
    const t = this.resolveTab(sel); // errors on ambiguity → never kills the wrong tab
    this.deps.sessions.close(t.id);
    return { closed: true as const };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/daemon && pnpm test`
Expected: PASS (all create/close cases; the order check — dir → sandbox → kind → cap — means each rejection test exercises its specific guard).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm check`
Expected: clean (the previously-"unused" `assertInsideFsRoot`/`FsSandboxError`/`statSafe`/`MAX_TABS_PER_PROJECT` are now used).

```bash
git add apps/daemon/src/mcp/terminal-control.ts apps/daemon/src/mcp/terminal-control.test.ts
git commit -m "feat(daemon/mcp): hardened createTab/closeTab (sandbox+kind+cap)"
```

---

## Task 10: `mcp/server.ts` — the MCP server (11 tools)

Maps the 11 tools onto `TerminalControl`, with safe error mapping, per-request transport + teardown, and in-flight-wait cancellation. Only the pure `toSafeToolError` is unit-tested; the transport wiring is verified by `pnpm check` + the manual checklist.

> **Honor Task 1's recording.** The code below is the **stateless + `enableJsonResponse`** mount. If Task 1 found the target client requires `Mcp-Session-Id`, implement the **stateful** variant instead: a module-level `Map<string, { server, transport }>`, create-on-`initialize`, route POST/GET/DELETE by the header, and tear down by session id. The tool registration + `toSafeToolError` below are identical either way.

**Files:**
- Create: `apps/daemon/src/mcp/server.ts`
- Test: `apps/daemon/src/mcp/server.test.ts`

**Interfaces:**
- Produces: `registerMcp(app: FastifyInstance, control: TerminalControl): void`, and `toSafeToolError(err: unknown): { content: { type: "text"; text: string }[]; isError: true }`.
- Consumes: `TerminalControl` + its error classes (`./terminal-control.ts`), `SessionError` (`../sessions.ts`, value import for `instanceof`), `FsSandboxError` (`@orquester/config`), the SDK (Task 1).

- [ ] **Step 1: Write the failing test (error mapping only)**

`apps/daemon/src/mcp/server.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { FsSandboxError } from "@orquester/config";
import { TabNotFound, AmbiguousTab, ToolError } from "./terminal-control.ts";
import { SessionError } from "../sessions.ts";
import { toSafeToolError } from "./server.ts";

test("typed tool errors surface their (safe) message", () => {
  for (const e of [new TabNotFound("no tab x"), new AmbiguousTab("ambiguous: a=1,b=2"), new ToolError("tab limit"), new SessionError("entry not available")]) {
    const r = toSafeToolError(e);
    assert.equal(r.isError, true);
    assert.equal(r.content[0].text, e.message);
  }
});

test("FsSandboxError is generic (never echoes the path)", () => {
  const r = toSafeToolError(new FsSandboxError("Path is outside the sandbox: /etc/shadow"));
  assert.ok(!r.content[0].text.includes("/etc/shadow"));
});

test("unknown errors collapse to a fixed string (no leak)", () => {
  const r = toSafeToolError(new Error("ENOENT: /home/alice/.ssh/id_rsa"));
  assert.ok(!r.content[0].text.includes("/home/alice"));
  assert.equal(r.isError, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/daemon && pnpm test`
Expected: FAIL — `Cannot find module './server.ts'`.

- [ ] **Step 3: Implement `server.ts`**

`apps/daemon/src/mcp/server.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { FsSandboxError } from "@orquester/config";
import { SessionError } from "../sessions.ts";
import { AmbiguousTab, TabNotFound, TerminalControl, ToolError } from "./terminal-control.ts";

const MCP_BODY_LIMIT = 8 * 1024 * 1024;

/** Map any thrown error to an MCP isError result with a SAFE message (no path/stack leak). */
export function toSafeToolError(err: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  let message: string;
  if (err instanceof TabNotFound || err instanceof AmbiguousTab || err instanceof ToolError) {
    message = err.message; // terminal-control's own — crafted safe (titles/ids, limits)
  } else if (err instanceof SessionError) {
    message = err.message; // e.g. 'Registry entry "claude" is not available.' — safe
  } else if (err instanceof FsSandboxError) {
    message = "Path is not allowed (outside the sandbox)."; // NEVER the raw path
  } else {
    console.error("[mcp] unexpected tool error", err); // detail server-side only
    message = "Internal error handling the tool call.";
  }
  return { content: [{ type: "text", text: message }], isError: true };
}

/** JSON text content for a successful tool result. */
function ok(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

const sel = {
  workspace: z.string().optional(),
  project: z.string().optional(),
  tab: z.string().optional(),
  tabId: z.string().optional(),
};
const PROMPT_HINT =
  " For interactive prompts (menus): read the screen regardless of `settled`, prefer a number/letter shortcut via write_input, else send ONE arrow via send_keys and re-read; confirm with Enter.";

/** Build a per-request McpServer with all 11 tools bound to `control`. */
function buildServer(control: TerminalControl, signal: AbortSignal): McpServer {
  const server = new McpServer({ name: "orquester", version: "1.0.0" });
  const tool = (
    name: string,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    run: (args: any) => unknown | Promise<unknown>
  ) =>
    server.registerTool(name, { description, inputSchema: schema }, async (args: any) => {
      try {
        return ok(await run(args));
      } catch (e) {
        return toSafeToolError(e);
      }
    });

  tool("list_workspaces", "List workspaces.", {}, async () =>
    (await control.listWorkspacesProjected()).map((w) => ({ name: w.name, projectCount: w.projectCount }))
  );
  tool("list_projects", "List a workspace's projects.", { workspace: z.string() }, async (a) =>
    (await control.listProjectsProjected(a.workspace)).map((p) => ({ name: p.name, path: p.path }))
  );
  tool("list_tabs", "List a project's tabs (sessions).", { workspace: z.string(), project: z.string() }, (a) =>
    control.listTabs({ workspace: a.workspace, project: a.project })
  );
  tool("list_launchers", "List launchable shells/agents (valid refIds for create_tab).", {}, () =>
    control.listLaunchers()
  );
  tool("read_terminal", "Read a tab's clean rendered screen text." + PROMPT_HINT,
    { ...sel, lines: z.number().int().optional() },
    (a) => control.readTerminal(a, { lines: a.lines })
  );
  tool("write_input", "Type text into a tab; submit:true appends Enter. Use for literal shortcut keys (1, y)." + PROMPT_HINT,
    { ...sel, data: z.string(), submit: z.boolean().optional() },
    (a) => control.writeInput(a, a.data, { submit: a.submit })
  );
  tool("send_keys", "Send named/control keys to a tab (Enter, C-c, Up, Space, Tab, Escape…). One key at a time; read between." + PROMPT_HINT,
    { ...sel, keys: z.array(z.string()) },
    (a) => control.sendKeys(a, a.keys)
  );
  tool("send_and_wait", "Write input, then block until the pane is quiet (or timeout). Inspect `text` for a prompt regardless of `settled`." + PROMPT_HINT,
    { ...sel, data: z.string(), submit: z.boolean().optional(), idleMs: z.number().int().optional(), timeoutMs: z.number().int().optional(), lines: z.number().int().optional() },
    (a) => control.sendAndWait(a, a.data, { submit: a.submit, idleMs: a.idleMs, timeoutMs: a.timeoutMs, lines: a.lines, signal })
  );
  tool("wait_for_idle", "Block until the pane is quiet (no write). The re-invoke path after a settled:false." + PROMPT_HINT,
    { ...sel, idleMs: z.number().int().optional(), timeoutMs: z.number().int().optional(), lines: z.number().int().optional() },
    (a) => control.waitForIdle(a, { idleMs: a.idleMs, timeoutMs: a.timeoutMs, lines: a.lines, signal })
  );
  tool("create_tab", "Launch a new tab (shell/agent from list_launchers) in a project. cwd is sandboxed.",
    { workspace: z.string(), project: z.string(), refId: z.string(), title: z.string().optional(), cwd: z.string().optional() },
    (a) => control.createTab({ workspace: a.workspace, project: a.project }, { refId: a.refId, title: a.title, cwd: a.cwd })
  );
  tool("close_tab", "Close a tab.", sel, (a) => control.closeTab(a));

  return server;
}

/** Mount POST /mcp (Streamable-HTTP, stateless). Caller registers this ONLY on the HTTP transport. */
export function registerMcp(app: FastifyInstance, control: TerminalControl): void {
  app.post("/mcp", { bodyLimit: MCP_BODY_LIMIT }, async (request, reply) => {
    const ctrl = new AbortController(); // cancels in-flight waits on disconnect
    const server = buildServer(control, ctrl.signal);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on("close", () => {
      ctrl.abort();
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      console.error("[mcp] request failed", error);
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
      }
      reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
    }
  });
}
```

> This adds two small projection helpers on `TerminalControl` referenced above (`listWorkspacesProjected`/`listProjectsProjected`) — add them in Step 4.

- [ ] **Step 4: Add the two projection helpers to `TerminalControl`**

In `apps/daemon/src/mcp/terminal-control.ts`, add to the class (they wrap the injected helpers so `server.ts` stays declarative):

```ts
  async listWorkspacesProjected() {
    return this.deps.listWorkspaces();
  }
  async listProjectsProjected(workspace: string) {
    if (!isValidName(workspace)) {
      throw new TabNotFound("Invalid workspace name.");
    }
    return this.deps.listProjects(workspace);
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/daemon && pnpm test`
Expected: PASS (`server.test.ts` — the error mapping). The transport code is typechecked next.

- [ ] **Step 6: Typecheck**

Run: `pnpm check`
Expected: clean. If the SDK's `registerTool`/transport signature differs from Task 1's recording, adjust the `tool()` helper and `StreamableHTTPServerTransport` options to match the **installed** SDK (Task 1 is authoritative). Common drift: `inputSchema` wanting a `ZodRawShape` vs a `z.object(...)`; the handler's `extra` arg carrying `signal` (already threaded via the closure here, so SDK-`extra` differences don't matter).

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/mcp/server.ts apps/daemon/src/mcp/server.test.ts apps/daemon/src/mcp/terminal-control.ts
git commit -m "feat(daemon/mcp): McpServer with 11 tools + safe error mapping"
```

---

## Task 11: `index.ts` — wire `/mcp` into the daemon (HTTP-only)

Build `TerminalControl` from the composition root (injecting the in-scope `listWorkspaces`/`listProjects` + `resolved.fsRoot`), mount `/mcp` **only on the remote transport**, and reserve `/mcp` in **both** the auth gate and the SPA not-found handler.

**Files:**
- Modify: `apps/daemon/src/index.ts` (`createServer`, the `onRequest` gate `:378`, the `setNotFoundHandler` reserved set `:1843`)

**Interfaces:**
- Consumes: `registerMcp` + `TerminalControl` (`./mcp/server.ts`, `./mcp/terminal-control.ts`); module-scope `listWorkspaces`/`listProjects`; `resolved.{workspacesDir,workspacesMetaFile,fsRoot}`; `services.{sessions,registry}`.

- [ ] **Step 1: Import the MCP layer**

Add near the other daemon-local imports in `apps/daemon/src/index.ts`:

```ts
import { TerminalControl } from "./mcp/terminal-control.ts";
import { registerMcp } from "./mcp/server.ts";
```

- [ ] **Step 2: Build + mount in `createServer` (remote only)**

In `createServer`, after the route registrations and **before** the `if (options.serveWeb) { … }` not-found block (around `:1838`), add:

```ts
  // Terminal-control MCP — HTTP-only. The unix socket is unauthenticated, so full
  // terminal drive must never be reachable there; register /mcp only on remote.
  if (options.mode === "remote") {
    const control = new TerminalControl({
      sessions: services.sessions,
      registry: services.registry,
      workspacesDir: resolved.workspacesDir,
      fsRoot: resolved.fsRoot,
      listWorkspaces: () => listWorkspaces(resolved.workspacesDir, resolved.workspacesMetaFile),
      listProjects: (workspace) => listProjects(resolved.workspacesDir, workspace),
    });
    registerMcp(app, control);
  }
```

- [ ] **Step 3: Reserve `/mcp` in the auth gate**

In the `onRequest` hook (`:377-378`), extend `needsAuth`:

```ts
    const needsAuth =
      (url.startsWith("/api") || url.startsWith("/events") || url.startsWith("/mcp")) &&
      url !== "/api/auth/info";
```

- [ ] **Step 4: Reserve `/mcp` in the SPA not-found handler**

In `setNotFoundHandler` (`:1842-1843`), add `/mcp` to the reserved prefixes so `GET /mcp` returns a JSON 404, not the SPA HTML:

```ts
      const isApi =
        url.startsWith("/api") ||
        url.startsWith("/health") ||
        url.startsWith("/events") ||
        url.startsWith("/mcp");
```

- [ ] **Step 5: Typecheck**

Run: `pnpm check`
Expected: clean. (Confirms `TerminalControlDeps` matches the injected shape and the `listWorkspaces`/`listProjects` closures type-check.)

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/index.ts
git commit -m "feat(daemon): mount /mcp on the HTTP transport (auth-gated, HTTP-only)"
```

---

## Task 12: End-to-end verification + client-setup doc

The "run the app" done-criteria (spec §Testing). **Run against a SEPARATE checkout with tmux + HTTP enabled — never this live checkout.** Also write the client-config note.

**Files:**
- Create: `docs/superpowers/specs/2026-06-30-orquester-terminal-mcp-design.md` is the reference; add a short `deploy/` or `docs/` note for client setup if the maintainer wants one (optional — fold into the spec's §7 if preferred).

- [ ] **Step 1: Full typecheck + unit tests**

Run: `pnpm check && (cd apps/daemon && pnpm test) && (cd packages/config && node --import tsx --test src/index.test.ts)`
Expected: typecheck clean; all `node:test` suites pass.

- [ ] **Step 2: Manual checklist (separate daemon, tmux + HTTP on)**

Drive `/mcp` with mcp-inspector / Claude Code/Desktop (bearer = `base64("<user>:<bcryptHash>")`, salt from `/api/auth/info`). Confirm:
- [ ] `list_workspaces` → `list_projects` → `list_tabs` reflect the live UI.
- [ ] Open a `claude` tab in the UI; `read_terminal` returns its clean visible text.
- [ ] `send_and_wait("what is 2+2", submit:true)` returns the settled reply (`settled:true`).
- [ ] `send_keys(["C-c"])` interrupts a running command; `write_input` + `submit` runs one.
- [ ] `create_tab(refId:"bash")` appears as a new tab; `close_tab` removes it.
- [ ] `create_tab(refId:"vscode"/"chrome")` is **rejected** (not shell/agent); `create_tab(cwd:"/etc")` **rejected** (out of fsRoot); creating past the per-project cap **rejected**.
- [ ] Over the unix socket, `/mcp` is **404**; `GET /mcp` over HTTP is a JSON 404/405, **not** the SPA HTML.
- [ ] A disconnect mid-`send_and_wait` leaves no orphaned listener/timer (no `MaxListenersExceededWarning` in logs).
- [ ] Auth: a request without/with a wrong bearer → 401.
- [ ] **Interactive prompts (§8):** drive a real `claude`/`codex` tab into a permission prompt + a multiselect; answer via (a) a number/letter shortcut and (b) verified arrow-nav + `Space` + `Enter`; a free-text prompt via `write_input`. Each selection takes.
- [ ] Ambiguity: two "bash" tabs → `read_terminal` errors with both ids; retry with `tabId` works.
- [ ] **Regression:** existing UI terminals still replay scrollback (unchanged `scrollback()`/default `capturePane()`).

- [ ] **Step 3: Document client setup**

Write a short note (in the spec's §7 or a new `docs/` snippet) covering: HTTP must be enabled (desktop forces it off → target the VPS / an HTTP-enabled daemon); the bearer derivation (`base64("<user>:<bcryptHash>")`, salt from `/api/auth/info`, client-side bcrypt cost 12); the required `Accept: application/json, text/event-stream` header; and the §8 interactive-prompt workflow pointer.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "docs(mcp): client-setup note + verification checklist results"
```

---

## Self-Review

**Spec coverage** (each spec section → task):
- §0 module layout → File Structure + Tasks 2-11.
- §1 captureText + text helpers → Tasks 2 (text.ts), 5 (capturePane opts), 6 (captureText).
- §2 resolveTab → Task 7.
- §3 read/write/keys/createTab/closeTab → Tasks 7 (read/write/keys), 9 (create/close).
- §4 idle engine + cancellation → Task 8.
- §5 keys → Task 3.
- §6 11 tools + error mapping → Task 10.
- §7 Fastify mount/auth/not-found/body-limit/HTTP-only/transport-mode → Tasks 1 (transport validation), 10 (mount/teardown/bodyLimit), 11 (auth gate + not-found + remote-only).
- §8 interactive prompts → tool-description `PROMPT_HINT` (Task 10) + manual checklist (Task 12).
- Security (cwd sandbox, kind allowlist, count cap, generic errors, HTTP-only) → Tasks 9, 10, 11.
- Files-touched list → every file has a task.
- Testing/verification → Task 12 + the per-task `node:test` suites.

**Placeholder scan:** no TBD/TODO; every code step has complete code; every command has an expected result.

**Type consistency:** `captureText(id,{lines?})` (Tasks 6,7,8); `TabSelector`/`TerminalControlDeps`/`WaitResult` defined once (Task 7/8) and reused; `registerMcp(app, control)` + `toSafeToolError` (Task 10) consumed in Task 11; `assertInsideFsRoot(root,target)`/`isValidName`/`FsSandboxError` exported once (Task 4) and imported in Tasks 7/9/10; `captureArgs` (Task 5) consumed by `capturePane`. The deliberately-unused-until-Task-9 imports in Task 7 are called out in that task's note.

**Open risk carried by Task 1 (by design):** the stateless-vs-stateful transport choice and the exact SDK `registerTool`/transport API are *validated before* Tasks 10-11 build on them — the one class of bug spec review can't catch is front-loaded into a runnable spike.

---

## Execution Handoff

(See the bottom of this conversation — the plan author will offer the subagent-driven vs inline choice there.)
