# Orquester MCP v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the tmux-oriented MCP server under `apps/daemon/src/mcp/` with 29 chat-native tools that mirror the agent chat GUI one-to-one, plus two host fixes the spec depends on (permission modes honoured by every adapter; non-image attachments delivered as path lines).

**Architecture:** Every tool is *argument mapping → daemon calls → projection*. Daemon calls go through one seam, `DaemonApi`, whose production implementation runs the daemon's own Fastify routes in-process (`app.inject`) with the caller's bearer, so gates, validation and error codes are the GUI's by construction. Waits subscribe to the daemon `Broadcaster` (the same bus the Attention Center reads); nothing sleeps or polls PTYs. Tools are plain `ToolDef` objects registered by one `server.ts`, and are unit-tested against a `FakeDaemonApi`.

**Tech Stack:** TypeScript 5.8 (ESM, `noEmit`, run by tsx), Fastify 4 (`app.inject`), `@modelcontextprotocol/sdk` 1.29 (`McpServer`, `StreamableHTTPServerTransport`, stateless), zod 3.25, `node:test` + `node:assert/strict` (run: `pnpm --filter @orquester/daemon test`, or a single file with `node --import tsx --test <file>` from `apps/daemon`).

**Spec:** `docs/superpowers/specs/2026-09-22-orquester-mcp-v2-design.md` — every task cites the section it implements. Read the spec first; this plan argues from it.

## Global Constraints

- **Never start, restart or stop a daemon or the agent host** (AGENTS.md). Verify with tests and `pnpm check` only.
- **Each task runs in its own git worktree and commits there** (one branch per task; the controller merges into `main`). Commit at the end of each task with a conventional message; never push. Run `bash /var/lib/orquester/workspaces/jaspersito/orquester2/.superpowers/sdd/2026-09-22-orquester-mcp-v2/wt-link-node-modules.sh` inside the worktree before anything else so tests and `pnpm check` work there.
- **Subagents never run on Sonnet/Haiku** (host CLAUDE.md).
- **File ownership is strict**: a task edits only the files listed under its **Files**. Waves: A = {1, 2, 14, 15} in parallel; B = {3, 4, 5, 6} after A merges; C = {7, 8, 9, 10, 11} after B merges; then 12, then 13, then 16.
- Tests live beside sources as `*.test.ts` under `src/`; no sleeps — wait on promises, fake timers or emitted events.
- Naming (spec §5): tools `verb_noun`; params/fields camelCase; the same concept has the same name everywhere: `sessionId`, `project`, `workspace`, `agent`, `accountId`, `model`, `options`, `runtimeMode`, `planMode`, `requestId`, `timeoutMs`, `wait`, `after`, `path`, `attachments`.
- Results (spec §4.5): every tool returns one JSON **object**; lists are wrapped (`{sessions: [...]}`); mutations return `session`; errors are `ToolError(code, message)`; result text ≤ 60 000 UTF-8 bytes; every parameter has `.describe()`; every tool has `title` + `annotations`; descriptions ≤ ~400 chars and carry no TUI guidance; `SERVER_INSTRUCTIONS` ≤ 2048 chars.
- Values (spec §5): `runtimeMode` ∈ `approval-required | auto-accept-edits | auto | full-access` (default `full-access`); `effort` is the canonical option alias mapped to `effort` (claude, codex) / `variant` (opencode) / `reasoningEffort` (grok); approval `decision` ∈ `accept | acceptForSession | acceptAlways | decline | cancel`.
- No lazy dynamic `import()` under `apps/daemon/src/agent-host/` (Tasks 14–15).
- **Turns are numbered by START ORDER** (`startedTurns()` in `packages/api/src/agent-chat/turns.ts`, landed on `origin/main` after the spec was written): `targetTurnCount` on `/revert` means "keep the first N started turns", checkpoints are keyed by that ordinal and are sparse. Every turn number the MCP reports or accepts (`turnCount`, `keepTurns`, `get_turn_diff.turn`, transcript `turn`) is that ordinal.
- `pnpm check` must be clean at the end of every task.

## Review Focus

1. **A chat tab whose host is restarting** (`503 HOST_UNAVAILABLE`): every command must retry the same `commandId` ≤ 3× with backoff, then surface `HOST_UNAVAILABLE`; reads surface it once. Pinned in Task 2 (`sendCommand` retry test).
2. **`wait_for_session` called in a loop without acting**: with the cursor from the previous result it must block, never return the same `finished` session twice. Pinned in Task 5 (cursor tests).
3. **A `send_message` into a session that is `stopped` or `error`**: `stopped` resumes on the next turn (allowed); `error` must be refused with a message naming `stop_session`. Pinned in Task 9.
4. **`answer_question` with a label that is neither an option nor allowed as custom text** (`allowCustomAnswer:false`) and an `isSecret` question with attachments: both refused before any daemon call. Pinned in Task 10.
5. **A `create_session` with an `accountId` of the wrong family** (the daemon would silently fall back to the system home): refused with `INVALID_ARGUMENT` listing the family's accounts. Pinned in Task 8.

---

## File structure

```
packages/api/src/agent-chat/plan.ts                 PLAN_IMPLEMENTATION_PROMPT_PREFIX, buildPlanImplementationPrompt, isPlanImplementationMessage (Task 1)
packages/api/src/cliproxy-launch-models.ts          proxyLaunchModels() — the claudex/claudemix launch catalogue (Task 1)
apps/daemon/src/terminal-text.ts                    (moved from mcp/text.ts, unchanged) (Task 2)
apps/daemon/src/mcp/
  errors.ts          ToolError, daemonError(), expectOk()                                   (Task 2)
  result.ts          ok(), toSafeToolError(), capText(), MAX_RESULT_BYTES                    (Task 2)
  tool.ts            ToolDef, ToolContext, defineTool()                                       (Task 2)
  daemon-api.ts      DaemonApi, DaemonResponse, InjectDaemonApi                               (Task 2)
  testing.ts         FakeDaemonApi (test helper, imported by *.test.ts)                       (Task 2)
  addressing.ts      resolveProject(), projectNamesFor()                                      (Task 2)
  reads.ts           listSessions(), findSession(), requireChatSession(), readThread(), sendCommand() (Task 2)
  views.ts           SessionView, SessionDetail, pending/subagent views, sessionReason(), buildViewContext() (Task 3)
  agents.ts          AgentView, loadAgents(), findAgent(), resolveModelSelection(), validateAccountId() (Task 3)
  transcript.ts      TranscriptEntry, transcriptEntries()                                     (Task 4)
  usage-view.ts      usageView(), formatResetsIn()                                            (Task 4)
  wait.ts            watchSessions(), waitForTurn(), waitForAttention()                        (Task 5)
  attachments.ts     attachmentInputSchema, uploadInlineAttachments()                          (Task 6)
  tools/catalog.ts   list_projects, list_agents, list_conversations                            (Task 7)
  tools/sessions.ts  list_sessions, get_session, get_turn_diff, create_session, update_session,
                     interrupt_session, stop_session, close_session, revert_session, compact_session (Task 8)
  tools/messages.ts  send_message, implement_plan, read_transcript                             (Task 9)
  tools/requests.ts  answer_question, dismiss_question, resolve_approval                       (Task 10)
  tools/watch.ts     wait_for_session                                                          (Task 11)
  tools/usage.ts     get_usage, get_cost                                                       (Task 11)
  tools/todos.ts     the five todo tools over TodoTools                                         (Task 12)
  tools/files.ts     list_files, read_file over FsTools                                        (Task 12)
  todo-tools.ts      kept; imports ToolError from ./errors.ts                                  (Task 2/12)
  fs-tools.ts        kept; imports ToolError from ./errors.ts                                  (Task 2)
  server.ts          SERVER_INSTRUCTIONS, allTools(), buildServer(), registerMcp()             (Task 12)
docs/orquester-mcp.md, AGENTS.md, README.md                                                    (Task 13)
apps/daemon/src/agent-host/**  permission fix (Task 14) · attachment path lines (Task 15)
```

Deleted in Task 2: `apps/daemon/src/mcp/{terminal-control,keys}.ts` and their tests, the old `server.test.ts`, `apps/daemon/scripts/mcp-spike.ts` (`text.ts` moves). Deleted in Task 13: `docs/terminal-control-mcp.md`.

---

### Task 1: Shared code moves into `@orquester/api`

Spec §4.4. Two pure pieces the daemon now needs and the UI already has.

**Files:**
- Create: `packages/api/src/agent-chat/plan.ts`, `packages/api/src/agent-chat/plan.test.ts`
- Create: `packages/api/src/cliproxy-launch-models.ts`, `packages/api/src/cliproxy-launch-models.test.ts`
- Modify: `packages/api/src/agent-chat/index.ts` (add `export * from "./plan.ts";`)
- Modify: `packages/api/src/index.ts` (add `export * from "./cliproxy-launch-models.ts";`)
- Modify: `packages/ui/src/lib/agent-chat/entries.logic.ts:69` (delete the local constant; import from `@orquester/api/agent-chat`)
- Modify: `packages/ui/src/lib/agent-chat/plan.logic.ts:193-195` (`buildPlanImplementationPrompt` re-exported from the api copy)
- Modify: `packages/ui/src/components/topbar/NewTabMenu.tsx:58-61, 255-295` (use `proxyLaunchModels`)
- Modify: `apps/daemon/src/agent-host/orchestration/orchestrator.ts` (the `PLAN_IMPLEMENTATION_PROMPT_PREFIX` const near line 3614: delete, import from `@orquester/api/agent-chat`)

**Interfaces:**
- Produces:
  ```ts
  // packages/api/src/agent-chat/plan.ts
  export const PLAN_IMPLEMENTATION_PROMPT_PREFIX = "PLEASE IMPLEMENT THIS PLAN:\n";
  export function buildPlanImplementationPrompt(planMarkdown: string): string; // prefix + planMarkdown.trim()
  export function isPlanImplementationMessage(text: string): boolean;          // text.startsWith(prefix)
  // packages/api/src/cliproxy-launch-models.ts
  export interface ProxyLaunchModel { id: string; providerLabel: string | null; } // providerLabel: keyed router/xAI label, null for the curated list
  export function proxyLaunchModels(status: CliProxyStatus | null, catalog: readonly string[]): ProxyLaunchModel[];
  ```

- [ ] **Step 1: Write the failing tests**

`packages/api/src/agent-chat/plan.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PLAN_IMPLEMENTATION_PROMPT_PREFIX, buildPlanImplementationPrompt, isPlanImplementationMessage } from "./plan.ts";

test("the implementation prompt is the prefix plus the trimmed plan", () => {
  assert.equal(buildPlanImplementationPrompt("  # Plan  "), `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}# Plan`);
  assert.equal(PLAN_IMPLEMENTATION_PROMPT_PREFIX, "PLEASE IMPLEMENT THIS PLAN:\n");
});

test("isPlanImplementationMessage matches only the prefixed message", () => {
  assert.equal(isPlanImplementationMessage(buildPlanImplementationPrompt("x")), true);
  assert.equal(isPlanImplementationMessage("please implement this plan"), false);
});
```

`packages/api/src/cliproxy-launch-models.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CURATED_PROXY_MODEL_IDS, XAI_OAUTH_MODELS } from "@orquester/config";
import type { CliProxyStatus } from "./index.ts";
import { proxyLaunchModels } from "./cliproxy-launch-models.ts";

const base = {
  state: "healthy", reasons: [], detail: null, version: null, defaultModel: "gpt-5.6-sol", backgroundModel: "",
  modelOverrides: {}, providers: [], routerProviders: [], accounts: [], activeSessionCount: 0, testedClaudeCliVersion: null,
  xai: { state: "none", email: null, expiredAt: null, lastQuotaError: null, lastLinkError: null, link: null }
} as unknown as CliProxyStatus;

test("with an empty catalogue every curated pick is offered", () => {
  const ids = proxyLaunchModels(base, []).map((m) => m.id);
  assert.deepEqual(ids, [...CURATED_PROXY_MODEL_IDS]);
});

test("a keyed router provider adds its alias (or name) with its label; an unkeyed one adds nothing", () => {
  const status = { ...base, routerProviders: [
    { id: "r1", label: "OpenRouter", preset: "openrouter", baseUrl: "https://x", keyState: "verified", keyVerifiedAt: null,
      models: [{ name: "moonshot/kimi-k3", alias: "kimi-k3" }, { name: "other/model" }] },
    { id: "r2", label: "Unkeyed", preset: null, baseUrl: "https://y", keyState: "none", keyVerifiedAt: null, models: [{ name: "nope" }] }
  ] } as unknown as CliProxyStatus;
  const models = proxyLaunchModels(status, []);
  assert.deepEqual(models.filter((m) => m.providerLabel === "OpenRouter").map((m) => m.id), ["kimi-k3", "other/model"]);
  assert.ok(!models.some((m) => m.id === "nope"));
});

test("xAI models appear while linked or expired, labelled as the Grok account", () => {
  for (const state of ["linked", "expired"]) {
    const status = { ...base, xai: { ...base.xai, state } } as unknown as CliProxyStatus;
    const ids = proxyLaunchModels(status, []).map((m) => m.id);
    for (const m of XAI_OAUTH_MODELS) assert.ok(ids.includes(m.id), `${m.id} missing while ${state}`);
  }
  assert.ok(!proxyLaunchModels(base, []).some((m) => m.id === XAI_OAUTH_MODELS[0].id));
});

test("a non-empty catalogue filters the picks to what the proxy serves, falling back to all picks when none match", () => {
  const ids = proxyLaunchModels(base, ["gpt-5.6-sol"]).map((m) => m.id);
  assert.deepEqual(ids, ["gpt-5.6-sol"]);
  assert.deepEqual(proxyLaunchModels(base, ["unrelated"]).map((m) => m.id), [...CURATED_PROXY_MODEL_IDS]);
});

test("a null status yields the curated list", () => {
  assert.deepEqual(proxyLaunchModels(null, []).map((m) => m.id), [...CURATED_PROXY_MODEL_IDS]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run from `packages/api`: `node --import tsx --test src/agent-chat/plan.test.ts src/cliproxy-launch-models.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Write the implementations**

`packages/api/src/agent-chat/plan.ts`:
```ts
/**
 * The proposed-plan follow-up contract shared by the UI (Implement button), the
 * host (`hasActionableProposedPlan`) and the MCP (`implement_plan`). One
 * spelling of the prefix, so no surface can drift.
 */
export const PLAN_IMPLEMENTATION_PROMPT_PREFIX = "PLEASE IMPLEMENT THIS PLAN:\n";

/** The turn the client sends when the user clicks Implement. */
export function buildPlanImplementationPrompt(planMarkdown: string): string {
  return `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}${planMarkdown.trim()}`;
}

/** True for a user message that implements a plan (retires the latest proposed plan). */
export function isPlanImplementationMessage(text: string): boolean {
  return text.startsWith(PLAN_IMPLEMENTATION_PROMPT_PREFIX);
}
```

`packages/api/src/cliproxy-launch-models.ts` (the exact derivation lifted from `NewTabMenu.tsx:255-295`):
```ts
import { CURATED_PROXY_MODEL_IDS, XAI_OAUTH_MODELS } from "@orquester/config";
import type { CliProxyStatus } from "./index.ts";

export const XAI_PROVIDER_LABEL = "Grok account";

export interface ProxyLaunchModel {
  id: string;
  /** Label of the keyed router provider / xAI account serving it; null for the curated proxy list. */
  providerLabel: string | null;
}

/**
 * The models a `claudex`/`claudemix` launch may name — what the "+" menu offers:
 * the curated proxy picks, plus every model (alias when there is one) of a KEYED
 * router provider, plus the xAI models while an xAI credential exists (`linked`
 * or `expired`). When the proxy's live catalogue is non-empty the picks are
 * filtered to what it serves; if none survive, all picks are offered so the
 * chips never vanish.
 */
export function proxyLaunchModels(status: CliProxyStatus | null, catalog: readonly string[]): ProxyLaunchModel[] {
  const labelById = new Map<string, string | null>();
  for (const id of CURATED_PROXY_MODEL_IDS) labelById.set(id, null);
  for (const provider of status?.routerProviders ?? []) {
    if (provider.keyState === "none") continue;
    for (const model of provider.models) {
      const id = model.alias ?? model.name;
      if (!labelById.has(id)) labelById.set(id, provider.label);
    }
  }
  if (status?.xai?.state === "linked" || status?.xai?.state === "expired") {
    for (const model of XAI_OAUTH_MODELS) {
      if (!labelById.has(model.id)) labelById.set(model.id, XAI_PROVIDER_LABEL);
    }
  }
  const all = [...labelById.entries()].map(([id, providerLabel]) => ({ id, providerLabel }));
  const served = catalog.length ? all.filter((m) => catalog.includes(m.id)) : all;
  return served.length ? served : all;
}
```

Wire the exports (`packages/api/src/agent-chat/index.ts`: `export * from "./plan.ts";`; `packages/api/src/index.ts`: `export * from "./cliproxy-launch-models.ts";`). In `packages/ui/src/lib/agent-chat/entries.logic.ts` replace the local `PLAN_IMPLEMENTATION_PROMPT_PREFIX` definition with `import { PLAN_IMPLEMENTATION_PROMPT_PREFIX } from "@orquester/api/agent-chat";` and keep re-exporting it (`export { PLAN_IMPLEMENTATION_PROMPT_PREFIX };`) so existing UI imports keep working. In `plan.logic.ts` make `buildPlanImplementationPrompt` a re-export of the api function. In `NewTabMenu.tsx` replace the `keylessInfo` / `pickIds` / `available` / `baseModels` block with `const proxyModels = React.useMemo(() => proxyLaunchModels(cliproxy ?? null, cliproxyModels?.models ?? []), [cliproxy, cliproxyModels]);` and derive `baseModels = proxyModels.map(m => m.id)` and `labelByModel = new Map(proxyModels.filter(m => m.providerLabel).map(m => [m.id, m.providerLabel!]))` from it, deleting the local `DEFAULT_PROXY_MODELS` and `XAI_PROVIDER_LABEL` constants. In the host `orchestrator.ts` delete the local `PLAN_IMPLEMENTATION_PROMPT_PREFIX` and import it from `@orquester/api/agent-chat` (keep its doc comment on the import site); the test that pins the literal (search `PLAN_IMPLEMENTATION_PROMPT_PREFIX` under `apps/daemon/src/agent-host`) keeps passing unchanged.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `node --import tsx --test src/agent-chat/plan.test.ts src/cliproxy-launch-models.test.ts` (from `packages/api`) → PASS; `pnpm --filter @orquester/ui test` → PASS (the UI plan tests still import the same names); `pnpm check` → clean.

---

### Task 2: MCP foundation — errors, results, tool definition, `DaemonApi`, addressing, reads; remove the terminal surface

Spec §4.2, §4.4, §4.5, §5.

**Files:**
- Create: `apps/daemon/src/mcp/errors.ts`, `errors.test.ts`
- Create: `apps/daemon/src/mcp/result.ts`, `result.test.ts`
- Create: `apps/daemon/src/mcp/tool.ts`
- Create: `apps/daemon/src/mcp/daemon-api.ts`, `daemon-api.test.ts`
- Create: `apps/daemon/src/mcp/testing.ts` (FakeDaemonApi)
- Create: `apps/daemon/src/mcp/addressing.ts`, `addressing.test.ts`
- Create: `apps/daemon/src/mcp/reads.ts`, `reads.test.ts`
- Move: `apps/daemon/src/mcp/text.ts` → `apps/daemon/src/terminal-text.ts` (and `text.test.ts` → `terminal-text.test.ts`, import path updated)
- Modify: `apps/daemon/src/sessions.ts:21` (`import { renderText } from "./terminal-text.ts";`)
- Modify: `apps/daemon/src/mcp/fs-tools.ts:5` (`import { ToolError } from "./errors.ts";` — its `new ToolError("…")` calls become `new ToolError("INVALID_ARGUMENT", "…")`)
- Delete: `apps/daemon/src/mcp/terminal-control.ts`, `terminal-control.test.ts`, `keys.ts`, `keys.test.ts`, `apps/daemon/scripts/mcp-spike.ts`
- Note: `todo-tools.ts` still imports `TabNotFound`/`ToolError` from `terminal-control.ts`; Task 11 rewrites its imports. Until then the daemon typecheck fails on that one file — Task 2's implementer temporarily changes that single import line to `import { ToolError } from "./errors.ts";` and replaces `new TabNotFound(` with `new ToolError("PROJECT_NOT_FOUND", ` and `new ToolError(` (message-only) with `new ToolError("INVALID_ARGUMENT", ` in `todo-tools.ts` so `pnpm check` stays green; Task 11 owns the rest of that file.

**Interfaces (produced, used by every later task):**

```ts
// errors.ts
export class ToolError extends Error { readonly code: string; readonly detail?: unknown; constructor(code: string, message: string, detail?: unknown) }
export function daemonError(res: DaemonResponse, fallback?: { code: string; message: string }): ToolError
export function expectOk<T = unknown>(res: DaemonResponse, what: string): T           // returns res.body as T, throws daemonError when status >= 400
// result.ts
export const MAX_RESULT_BYTES = 60_000;
export function ok(value: Record<string, unknown>): { content: [{ type: "text"; text: string }]; structuredContent: Record<string, unknown> }
export function toSafeToolError(err: unknown): { content: [{ type: "text"; text: string }]; structuredContent: { code: string; message: string; detail?: unknown }; isError: true }
export function capText(text: string, maxChars: number): { text: string; truncated: boolean }
// tool.ts
export interface ToolContext { api: DaemonApi; todos: TodoTools; files: FsTools; signal: AbortSignal; now: () => number; }
export interface ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string; title: string; description: string; input: Shape;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run(args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext): Promise<Record<string, unknown>>;
}
export function defineTool<Shape extends z.ZodRawShape>(def: ToolDef<Shape>): ToolDef<Shape>
// daemon-api.ts
export type DaemonMethod = "GET" | "POST" | "PUT" | "DELETE";
export interface DaemonResponse { status: number; body: unknown }
export interface DaemonApi {
  request(method: DaemonMethod, path: string, opts?: { query?: Record<string, string>; body?: unknown }): Promise<DaemonResponse>;
  uploadAttachment(sessionId: string, meta: { name: string; type?: string }, bytes: Readable): Promise<{ status: number; value: unknown }>;
  attachmentPath(sessionId: string, attachmentId: string): Promise<string | null>;
  subscribe(listener: (event: EventMessage) => void): () => void;
  readonly fsRoot: string; readonly workspacesDir: string;
}
export class InjectDaemonApi implements DaemonApi { constructor(opts: { app: FastifyInstance; authorization: string | undefined; agentChat: { uploadAttachment: AgentChatService["uploadAttachment"]; attachmentPath: AgentChatService["attachmentPath"] } | null; broadcaster: Broadcaster; fsRoot: string; workspacesDir: string }) }
// testing.ts
export class FakeDaemonApi implements DaemonApi {
  calls: { method: DaemonMethod; path: string; query?: Record<string, string>; body?: unknown }[];
  uploads: { sessionId: string; meta: { name: string; type?: string }; bytes: Buffer }[];
  on(method: DaemonMethod, path: string, response: DaemonResponse | ((call: { query?: Record<string,string>; body?: unknown }) => DaemonResponse)): this;   // path may end with "*" as a prefix wildcard
  onUpload(handler: (sessionId: string, meta: { name: string; type?: string }, bytes: Buffer) => { status: number; value: unknown }): this;
  emit(event: EventMessage): void;    // fan out to subscribers
  listenerCount(): number;
  fsRoot: string; workspacesDir: string; attachmentPaths: Map<string, string>;
}
// addressing.ts
export interface ProjectRef { workspace: string | null; name: string | null; path: string }
export async function resolveProject(api: Pick<DaemonApi, "fsRoot" | "workspacesDir">, input: string): Promise<ProjectRef>  // throws ToolError PROJECT_NOT_FOUND / PATH_NOT_ALLOWED
export function projectNamesFor(projectPath: string, workspacesDir: string): ProjectRef
// reads.ts
export async function listSessions(api: DaemonApi, projectPath?: string): Promise<SessionSummary[]>
export async function findSession(api: DaemonApi, sessionId: string): Promise<SessionSummary>          // ToolError SESSION_NOT_FOUND
export async function requireChatSession(api: DaemonApi, sessionId: string): Promise<SessionSummary>   // ToolError NOT_A_CHAT_SESSION
export async function readThread(api: DaemonApi, sessionId: string): Promise<ThreadSnapshotPayload>    // GET …/thread, expects {kind:"snapshot"}
export async function sendCommand(api: DaemonApi, sessionId: string, name: AgentChatCommandName | "account", body: Record<string, unknown>, opts?: { retryDelayMs?: (attempt: number) => number }): Promise<{ seq: number }>
export function mintCommandId(): string
```

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/mcp/errors.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolError, daemonError, expectOk } from "./errors.ts";

test("daemonError reads the chat envelope, the flat shape and a bare string", () => {
  const a = daemonError({ status: 409, body: { error: { code: "COMMAND_REJECTED", message: "busy", detail: { x: 1 } } } });
  assert.equal(a.code, "COMMAND_REJECTED"); assert.equal(a.message, "busy"); assert.deepEqual(a.detail, { x: 1 });
  const b = daemonError({ status: 400, body: { code: "RESUME_UNAVAILABLE", message: "bad id" } });
  assert.equal(b.code, "RESUME_UNAVAILABLE"); assert.equal(b.message, "bad id");
  const c = daemonError({ status: 400, body: { error: "model is only valid for claudex/claudemix", entryId: "codex" } });
  assert.equal(c.code, "INVALID_ARGUMENT"); assert.equal(c.message, "model is only valid for claudex/claudemix");
  const d = daemonError({ status: 404, body: "not json" });
  assert.equal(d.code, "NOT_FOUND"); assert.match(d.message, /404/);
  const e = daemonError({ status: 503, body: null });
  assert.equal(e.code, "HOST_UNAVAILABLE");
});

test("expectOk returns the body below 400 and throws above", () => {
  assert.deepEqual(expectOk({ status: 200, body: { seq: 3 } }, "turn"), { seq: 3 });
  assert.throws(() => expectOk({ status: 404, body: { error: { code: "THREAD_NOT_FOUND", message: "no" } } }, "thread"),
    (err: unknown) => err instanceof ToolError && err.code === "THREAD_NOT_FOUND");
});
```

`apps/daemon/src/mcp/result.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { FsSandboxError } from "@orquester/config/fs";
import { ToolError } from "./errors.ts";
import { ok, toSafeToolError, capText, MAX_RESULT_BYTES } from "./result.ts";

test("ok returns the object as text and structuredContent", () => {
  const r = ok({ sessions: [] });
  assert.equal(r.content[0].text, JSON.stringify({ sessions: [] }));
  assert.deepEqual(r.structuredContent, { sessions: [] });
});

test("ok caps oversized text and says so", () => {
  const r = ok({ text: "x".repeat(MAX_RESULT_BYTES + 100) });
  assert.ok(Buffer.byteLength(r.content[0].text, "utf8") <= MAX_RESULT_BYTES);
  assert.equal((r.structuredContent as { truncated?: boolean }).truncated, true);
});

test("ToolError surfaces code and message; sandbox errors never echo the path; unknown errors are generic", () => {
  const a = toSafeToolError(new ToolError("SESSION_NOT_FOUND", "No session abc", { id: "abc" }));
  assert.equal(a.isError, true); assert.equal(a.content[0].text, "SESSION_NOT_FOUND: No session abc");
  assert.deepEqual(a.structuredContent, { code: "SESSION_NOT_FOUND", message: "No session abc", detail: { id: "abc" } });
  const b = toSafeToolError(new FsSandboxError("Path is outside the sandbox: /etc/shadow"));
  assert.ok(!b.content[0].text.includes("/etc/shadow")); assert.equal(b.structuredContent.code, "PATH_NOT_ALLOWED");
  const c = toSafeToolError(new Error("ENOENT /home/alice/.ssh/id_rsa"));
  assert.ok(!c.content[0].text.includes("/home/alice")); assert.equal(c.structuredContent.code, "INTERNAL");
});

test("capText cuts on a character boundary and flags it", () => {
  assert.deepEqual(capText("hello", 10), { text: "hello", truncated: false });
  const r = capText("héllo wörld", 5);
  assert.equal(r.truncated, true); assert.equal(r.text.length, 5);
});
```

`apps/daemon/src/mcp/daemon-api.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { Readable } from "node:stream";
import { Broadcaster } from "../broadcaster.ts";
import { InjectDaemonApi } from "./daemon-api.ts";

test("request runs the app's own route with the caller's bearer and parses JSON", async () => {
  const app = Fastify();
  app.get("/api/echo", async (req) => ({ auth: req.headers.authorization ?? null, q: (req.query as { a?: string }).a ?? null }));
  app.post("/api/echo", async (req, reply) => reply.code(201).send({ got: req.body }));
  const api = new InjectDaemonApi({ app, authorization: "Bearer abc", agentChat: null, broadcaster: new Broadcaster(), fsRoot: "/r", workspacesDir: "/r" });
  assert.deepEqual(await api.request("GET", "/api/echo", { query: { a: "1" } }), { status: 200, body: { auth: "Bearer abc", q: "1" } });
  assert.deepEqual(await api.request("POST", "/api/echo", { body: { x: 1 } }), { status: 201, body: { got: { x: 1 } } });
  await app.close();
});

test("request returns a non-JSON body as text and a 404 for unknown routes", async () => {
  const app = Fastify();
  app.get("/txt", async (_r, reply) => reply.type("text/plain").send("plain"));
  const api = new InjectDaemonApi({ app, authorization: undefined, agentChat: null, broadcaster: new Broadcaster(), fsRoot: "/r", workspacesDir: "/r" });
  assert.deepEqual(await api.request("GET", "/txt"), { status: 200, body: "plain" });
  assert.equal((await api.request("GET", "/nope")).status, 404);
  await app.close();
});

test("subscribe receives every published EventMessage and unsubscribes cleanly", async () => {
  const broadcaster = new Broadcaster();
  const api = new InjectDaemonApi({ app: Fastify(), authorization: undefined, agentChat: null, broadcaster, fsRoot: "/r", workspacesDir: "/r" });
  const seen: string[] = [];
  const off = api.subscribe((e) => seen.push(e.type));
  broadcaster.publish("sessions", "session.updated", { id: "s1" });
  off();
  broadcaster.publish("sessions", "session.updated", { id: "s2" });
  assert.deepEqual(seen, ["session.updated"]);
});

test("uploadAttachment and attachmentPath delegate to the agent chat service", async () => {
  const calls: unknown[] = [];
  const agentChat = {
    uploadAttachment: async (id: string, q: { name?: string; type?: string }, body: Readable) => {
      const chunks: Buffer[] = []; for await (const c of body) chunks.push(Buffer.from(c));
      calls.push([id, q, Buffer.concat(chunks).toString()]);
      return { status: 200, value: { type: "file", id: "a1", name: q.name, sizeBytes: 3 } };
    },
    attachmentPath: async (id: string, a: string) => `/threads/${id}/attachments/${a}`
  };
  const api = new InjectDaemonApi({ app: Fastify(), authorization: undefined, agentChat: agentChat as never, broadcaster: new Broadcaster(), fsRoot: "/r", workspacesDir: "/r" });
  const up = await api.uploadAttachment("s1", { name: "a.txt", type: "text/plain" }, Readable.from([Buffer.from("abc")]));
  assert.equal(up.status, 200); assert.deepEqual(calls[0], ["s1", { name: "a.txt", type: "text/plain" }, "abc"]);
  assert.equal(await api.attachmentPath("s1", "a1"), "/threads/s1/attachments/a1");
});

test("without an agent chat service uploads answer 503 HOST_UNAVAILABLE", async () => {
  const api = new InjectDaemonApi({ app: Fastify(), authorization: undefined, agentChat: null, broadcaster: new Broadcaster(), fsRoot: "/r", workspacesDir: "/r" });
  const up = await api.uploadAttachment("s1", { name: "a" }, Readable.from([]));
  assert.equal(up.status, 503);
  assert.equal(await api.attachmentPath("s1", "x"), null);
});
```

`apps/daemon/src/mcp/addressing.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProject, projectNamesFor } from "./addressing.ts";

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "mcp-addr-"));
  const workspacesDir = join(root, "workspaces");
  await mkdir(join(workspacesDir, "acme", "api"), { recursive: true });
  await mkdir(join(root, "outside"), { recursive: true });
  await symlink(join(root, "outside"), join(workspacesDir, "acme", "escape"));
  return { root, api: { fsRoot: workspacesDir, workspacesDir } };
}

test("workspace/name resolves to the joined path", async (t) => {
  const s = await sandbox(); t.after(() => rm(s.root, { recursive: true, force: true }));
  assert.deepEqual(await resolveProject(s.api, "acme/api"), { workspace: "acme", name: "api", path: join(s.api.workspacesDir, "acme", "api") });
});

test("an absolute path inside the sandbox resolves and is normalised; names are derived", async (t) => {
  const s = await sandbox(); t.after(() => rm(s.root, { recursive: true, force: true }));
  const r = await resolveProject(s.api, join(s.api.workspacesDir, "acme", "api") + "/");
  assert.deepEqual(r, { workspace: "acme", name: "api", path: join(s.api.workspacesDir, "acme", "api") });
});

test("missing project, bad names and escapes are refused with codes", async (t) => {
  const s = await sandbox(); t.after(() => rm(s.root, { recursive: true, force: true }));
  await assert.rejects(resolveProject(s.api, "acme/nope"), (e: { code: string }) => e.code === "PROJECT_NOT_FOUND");
  await assert.rejects(resolveProject(s.api, "../x/y"), (e: { code: string }) => e.code === "PROJECT_NOT_FOUND");
  await assert.rejects(resolveProject(s.api, "acme/escape"), (e: { code: string }) => e.code === "PATH_NOT_ALLOWED");
  await assert.rejects(resolveProject(s.api, "/etc"), (e: { code: string }) => e.code === "PATH_NOT_ALLOWED");
  await assert.rejects(resolveProject(s.api, "acme"), (e: { code: string }) => e.code === "PROJECT_NOT_FOUND");
});

test("projectNamesFor splits a sandbox path and nulls the rest", () => {
  assert.deepEqual(projectNamesFor("/w/acme/api", "/w"), { workspace: "acme", name: "api", path: "/w/acme/api" });
  assert.deepEqual(projectNamesFor("/w/acme/api/sub", "/w"), { workspace: "acme", name: "api", path: "/w/acme/api/sub" });
  assert.deepEqual(projectNamesFor("/elsewhere", "/w"), { workspace: null, name: null, path: "/elsewhere" });
});
```

`apps/daemon/src/mcp/reads.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeDaemonApi } from "./testing.ts";
import { listSessions, findSession, requireChatSession, readThread, sendCommand } from "./reads.ts";

const chat = { id: "c1", kind: "agent-chat", refId: "claude", title: "Claude", projectPath: "/w/a/p", cwd: "/w/a/p", cols: 0, rows: 0, status: "running", order: 1, createdAt: "2026-09-22T00:00:00.000Z" };
const shell = { ...chat, id: "t1", kind: "shell", refId: "bash" };

test("listSessions passes projectPath through and findSession filters the list", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [chat, shell] });
  assert.equal((await listSessions(api, "/w/a/p")).length, 2);
  assert.deepEqual(api.calls[0], { method: "GET", path: "/api/sessions", query: { projectPath: "/w/a/p" } });
  assert.equal((await findSession(api, "t1")).id, "t1");
  await assert.rejects(findSession(api, "zz"), (e: { code: string }) => e.code === "SESSION_NOT_FOUND");
  await assert.rejects(requireChatSession(api, "t1"), (e: { code: string }) => e.code === "NOT_A_CHAT_SESSION");
  assert.equal((await requireChatSession(api, "c1")).kind, "agent-chat");
});

test("readThread unwraps the snapshot and surfaces daemon errors", async () => {
  const snap = { head: { id: "c1" }, items: [], turns: [], checkpoints: [], pending: { approvals: [], userInputs: [] }, roster: [], seq: 4 };
  const api = new FakeDaemonApi().on("GET", "/api/sessions/c1/thread", { status: 200, body: { kind: "snapshot", thread: snap } })
    .on("GET", "/api/sessions/gone/thread", { status: 404, body: { error: { code: "THREAD_NOT_FOUND", message: "No chat session with that id." } } });
  assert.deepEqual(await readThread(api, "c1"), snap);
  await assert.rejects(readThread(api, "gone"), (e: { code: string }) => e.code === "THREAD_NOT_FOUND");
});

test("sendCommand mints a UUID commandId, posts the body and returns the receipt", async () => {
  const api = new FakeDaemonApi().on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 9 } });
  assert.deepEqual(await sendCommand(api, "c1", "turn", { input: "hi" }), { seq: 9 });
  const body = api.calls[0].body as { commandId: string; input: string };
  assert.match(body.commandId, /^[0-9a-f-]{36}$/); assert.equal(body.input, "hi");
  const api2 = new FakeDaemonApi().on("POST", "/api/sessions/c1/session/stop", { status: 200, body: { seq: 1 } });
  await sendCommand(api2, "c1", "session/stop", {});
  assert.equal(api2.calls[0].path, "/api/sessions/c1/session/stop");
  const api3 = new FakeDaemonApi().on("POST", "/api/sessions/c1/account", { status: 200, body: { seq: 2 } });
  await sendCommand(api3, "c1", "account", { accountId: "system" });
  assert.equal(api3.calls[0].path, "/api/sessions/c1/account");
});

test("sendCommand retries HOST_UNAVAILABLE with the SAME commandId up to 3 times, then throws; other errors are final", async () => {
  let n = 0;
  const api = new FakeDaemonApi().on("POST", "/api/sessions/c1/turn", () => (++n < 3
    ? { status: 503, body: { error: { code: "HOST_UNAVAILABLE", message: "restarting" } } }
    : { status: 200, body: { seq: 5 } }));
  assert.deepEqual(await sendCommand(api, "c1", "turn", { input: "x" }, { retryDelayMs: () => 0 }), { seq: 5 });
  const ids = new Set(api.calls.map((c) => (c.body as { commandId: string }).commandId));
  assert.equal(ids.size, 1); assert.equal(api.calls.length, 3);
  const always = new FakeDaemonApi().on("POST", "/api/sessions/c1/turn", { status: 503, body: { error: { code: "HOST_UNAVAILABLE", message: "restarting" } } });
  await assert.rejects(sendCommand(always, "c1", "turn", { input: "x" }, { retryDelayMs: () => 0 }), (e: { code: string }) => e.code === "HOST_UNAVAILABLE");
  assert.equal(always.calls.length, 4);
  const rejected = new FakeDaemonApi().on("POST", "/api/sessions/c1/turn", { status: 409, body: { error: { code: "COMMAND_REJECTED", message: "no" } } });
  await assert.rejects(sendCommand(rejected, "c1", "turn", { input: "x" }), (e: { code: string }) => e.code === "COMMAND_REJECTED");
  assert.equal(rejected.calls.length, 1);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run from `apps/daemon`: `node --import tsx --test src/mcp/errors.test.ts src/mcp/result.test.ts src/mcp/daemon-api.test.ts src/mcp/addressing.test.ts src/mcp/reads.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Write the implementations**

`apps/daemon/src/mcp/errors.ts`:
```ts
import type { DaemonResponse } from "./daemon-api.ts";

/** Every tool failure. `code` is a daemon code passed through or an MCP-level one (spec §4.5). */
export class ToolError extends Error {
  constructor(readonly code: string, message: string, readonly detail?: unknown) {
    super(message);
    this.name = "ToolError";
  }
}

const STATUS_CODES: Record<number, string> = { 400: "INVALID_ARGUMENT", 401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "COMMAND_REJECTED", 413: "UPLOAD_TOO_LARGE", 429: "TOO_MANY_ATTEMPTS", 502: "HOST_UNAVAILABLE", 503: "HOST_UNAVAILABLE" };

/** Map a failed daemon response to a ToolError: chat envelope, flat `{code,message}`, `{error: string}`, else by status. */
export function daemonError(res: DaemonResponse, fallback?: { code: string; message: string }): ToolError {
  const body = res.body as Record<string, unknown> | null;
  if (body && typeof body === "object") {
    const env = body.error;
    if (env && typeof env === "object") {
      const e = env as { code?: unknown; message?: unknown; detail?: unknown };
      if (typeof e.code === "string") return new ToolError(e.code, typeof e.message === "string" ? e.message : e.code, e.detail);
    }
    if (typeof body.code === "string") return new ToolError(body.code, typeof body.message === "string" ? body.message : body.code, body.detail);
    if (typeof env === "string") return new ToolError(STATUS_CODES[res.status] ?? "INVALID_ARGUMENT", env);
    if (typeof body.message === "string") return new ToolError(STATUS_CODES[res.status] ?? "INTERNAL", body.message);
  }
  if (fallback) return new ToolError(fallback.code, fallback.message);
  return new ToolError(STATUS_CODES[res.status] ?? "INTERNAL", `The daemon answered ${res.status}.`);
}

/** The body of a successful response, or a ToolError for a failed one. */
export function expectOk<T = unknown>(res: DaemonResponse, what: string): T {
  if (res.status >= 400) throw daemonError(res, undefined);
  void what;
  return res.body as T;
}
```

`apps/daemon/src/mcp/result.ts`:
```ts
import { FsSandboxError } from "@orquester/config/fs";
import { ToolError } from "./errors.ts";

/** Claude Code discards MCP results above ~25k tokens; stay well under (spec §4.5). */
export const MAX_RESULT_BYTES = 60_000;

type TextContent = { type: "text"; text: string };

export function capText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: Array.from(text).slice(0, maxChars).join(""), truncated: true };
}

/** A successful tool result: the object as text AND as structuredContent, capped. */
export function ok(value: Record<string, unknown>): { content: [TextContent]; structuredContent: Record<string, unknown> } {
  let text = JSON.stringify(value);
  let structured = value;
  if (Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) {
    // Last-resort shed: the tool should have bounded itself; keep the shape honest.
    const capped = { ...value, truncated: true, truncationNote: `Result exceeded ${MAX_RESULT_BYTES} bytes; narrow the request (fewer turns, smaller maxChars).` };
    text = JSON.stringify(capped);
    structured = capped;
    if (Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) {
      text = Buffer.from(text, "utf8").subarray(0, MAX_RESULT_BYTES - 3).toString("utf8").replace(/�+$/u, "") + "...";
    }
  }
  return { content: [{ type: "text", text }], structuredContent: structured };
}

/** Map any thrown error to an isError result with a SAFE message (no path/stack leak). */
export function toSafeToolError(err: unknown): { content: [TextContent]; structuredContent: { code: string; message: string; detail?: unknown }; isError: true } {
  let code = "INTERNAL";
  let message = "Internal error handling the tool call.";
  let detail: unknown;
  if (err instanceof ToolError) {
    ({ code, message, detail } = err);
  } else if (err instanceof FsSandboxError) {
    code = "PATH_NOT_ALLOWED";
    message = "Path is not allowed (outside the sandbox).";
  } else {
    console.error("[mcp] unexpected tool error", err);
  }
  const structured: { code: string; message: string; detail?: unknown } = { code, message };
  if (detail !== undefined) structured.detail = detail;
  return { content: [{ type: "text", text: `${code}: ${message}` }], structuredContent: structured, isError: true };
}
```

`apps/daemon/src/mcp/tool.ts`:
```ts
import type { z } from "zod";
import type { DaemonApi } from "./daemon-api.ts";
import type { TodoTools } from "./todo-tools.ts";
import type { FsTools } from "./fs-tools.ts";

export interface ToolContext {
  api: DaemonApi;
  todos: TodoTools;
  files: FsTools;
  /** Aborted when the MCP request closes; every wait must honour it. */
  signal: AbortSignal;
  now: () => number;
}

export interface ToolAnnotations { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }

export interface ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: Shape;
  annotations: ToolAnnotations;
  run(args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext): Promise<Record<string, unknown>>;
}

export function defineTool<Shape extends z.ZodRawShape>(def: ToolDef<Shape>): ToolDef<Shape> {
  return def;
}

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, idempotentHint: true };
export const MUTATING: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
export const MUTATING_IDEMPOTENT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true };
```

`apps/daemon/src/mcp/daemon-api.ts`:
```ts
import type { FastifyInstance } from "fastify";
import type { Readable } from "node:stream";
import type { EventMessage } from "@orquester/api";
import type { Broadcaster } from "../broadcaster.ts";
import type { AgentChatService } from "../agent-chat/service.ts";

export type DaemonMethod = "GET" | "POST" | "PUT" | "DELETE";
export interface DaemonResponse { status: number; body: unknown }

/**
 * The one seam between the MCP tools and the daemon (spec §4.2). Production
 * runs the daemon's own routes in-process with the caller's bearer, so every
 * gate, validation and error code is the GUI's by construction.
 */
export interface DaemonApi {
  request(method: DaemonMethod, path: string, opts?: { query?: Record<string, string>; body?: unknown }): Promise<DaemonResponse>;
  uploadAttachment(sessionId: string, meta: { name: string; type?: string }, bytes: Readable): Promise<{ status: number; value: unknown }>;
  attachmentPath(sessionId: string, attachmentId: string): Promise<string | null>;
  subscribe(listener: (event: EventMessage) => void): () => void;
  readonly fsRoot: string;
  readonly workspacesDir: string;
}

type ChatUploads = Pick<AgentChatService, "uploadAttachment" | "attachmentPath">;

export class InjectDaemonApi implements DaemonApi {
  readonly fsRoot: string;
  readonly workspacesDir: string;
  constructor(private readonly opts: { app: FastifyInstance; authorization: string | undefined; agentChat: ChatUploads | null; broadcaster: Broadcaster; fsRoot: string; workspacesDir: string }) {
    this.fsRoot = opts.fsRoot;
    this.workspacesDir = opts.workspacesDir;
  }

  async request(method: DaemonMethod, path: string, opts?: { query?: Record<string, string>; body?: unknown }): Promise<DaemonResponse> {
    const qs = opts?.query ? new URLSearchParams(opts.query).toString() : "";
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.opts.authorization) headers.authorization = this.opts.authorization;
    if (opts?.body !== undefined) headers["content-type"] = "application/json";
    const res = await this.opts.app.inject({
      method,
      url: qs ? `${path}?${qs}` : path,
      headers,
      payload: opts?.body === undefined ? undefined : JSON.stringify(opts.body)
    });
    let body: unknown = null;
    if (res.body) {
      try { body = JSON.parse(res.body); } catch { body = res.body; }
    }
    return { status: res.statusCode, body };
  }

  async uploadAttachment(sessionId: string, meta: { name: string; type?: string }, bytes: Readable): Promise<{ status: number; value: unknown }> {
    if (!this.opts.agentChat) return { status: 503, value: { code: "HOST_UNAVAILABLE", message: "The agent host is restarting." } };
    return this.opts.agentChat.uploadAttachment(sessionId, { name: meta.name, type: meta.type }, bytes);
  }

  async attachmentPath(sessionId: string, attachmentId: string): Promise<string | null> {
    if (!this.opts.agentChat) return null;
    return this.opts.agentChat.attachmentPath(sessionId, attachmentId);
  }

  subscribe(listener: (event: EventMessage) => void): () => void {
    // `Broadcaster.publish` drops a sink whose `send` throws — never throw here.
    const sink = { send: (data: string) => { try { listener(JSON.parse(data) as EventMessage); } catch { /* ignore */ } } };
    this.opts.broadcaster.add(sink);
    return () => this.opts.broadcaster.remove(sink);
  }
}
```

`apps/daemon/src/mcp/testing.ts`:
```ts
import type { Readable } from "node:stream";
import type { EventMessage } from "@orquester/api";
import type { DaemonApi, DaemonMethod, DaemonResponse } from "./daemon-api.ts";

type Call = { method: DaemonMethod; path: string; query?: Record<string, string>; body?: unknown };
type Responder = DaemonResponse | ((call: { query?: Record<string, string>; body?: unknown }) => DaemonResponse);

/** In-memory DaemonApi for tool tests: canned responses by `METHOD path` (a trailing `*` is a prefix match). */
export class FakeDaemonApi implements DaemonApi {
  calls: Call[] = [];
  uploads: { sessionId: string; meta: { name: string; type?: string }; bytes: Buffer }[] = [];
  attachmentPaths = new Map<string, string>();
  fsRoot = "/w";
  workspacesDir = "/w";
  private routes: { method: DaemonMethod; path: string; responder: Responder }[] = [];
  private listeners = new Set<(event: EventMessage) => void>();
  private uploadHandler: ((sessionId: string, meta: { name: string; type?: string }, bytes: Buffer) => { status: number; value: unknown }) | null = null;

  on(method: DaemonMethod, path: string, responder: Responder): this {
    this.routes.unshift({ method, path, responder });
    return this;
  }
  onUpload(handler: (sessionId: string, meta: { name: string; type?: string }, bytes: Buffer) => { status: number; value: unknown }): this {
    this.uploadHandler = handler;
    return this;
  }
  emit(event: EventMessage): void { for (const l of [...this.listeners]) l(event); }
  listenerCount(): number { return this.listeners.size; }

  async request(method: DaemonMethod, path: string, opts?: { query?: Record<string, string>; body?: unknown }): Promise<DaemonResponse> {
    const call: Call = { method, path };
    if (opts?.query) call.query = opts.query;
    if (opts?.body !== undefined) call.body = opts.body;
    this.calls.push(call);
    const route = this.routes.find((r) => r.method === method && (r.path.endsWith("*") ? path.startsWith(r.path.slice(0, -1)) : r.path === path));
    if (!route) return { status: 404, body: { code: "NOT_FOUND", message: `no fake route for ${method} ${path}` } };
    return typeof route.responder === "function" ? route.responder({ query: opts?.query, body: opts?.body }) : route.responder;
  }
  async uploadAttachment(sessionId: string, meta: { name: string; type?: string }, bytes: Readable): Promise<{ status: number; value: unknown }> {
    const chunks: Buffer[] = [];
    for await (const c of bytes) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    const buf = Buffer.concat(chunks);
    this.uploads.push({ sessionId, meta, bytes: buf });
    if (this.uploadHandler) return this.uploadHandler(sessionId, meta, buf);
    const image = /^image\//.test(meta.type ?? "");
    return { status: 200, value: { type: image ? "image" : "file", id: `${sessionId}-att-${this.uploads.length}`, name: meta.name, mimeType: meta.type, sizeBytes: buf.length } };
  }
  async attachmentPath(sessionId: string, attachmentId: string): Promise<string | null> {
    return this.attachmentPaths.get(attachmentId) ?? `/appdir/daemon/agent/threads/${sessionId}/attachments/${attachmentId}`;
  }
  subscribe(listener: (event: EventMessage) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

/** A bus event as the daemon publishes it. */
export function busEvent(type: string, payload: unknown, channel = "sessions"): EventMessage {
  return { id: `${type}-${Math.random()}`, channel, type, createdAt: new Date().toISOString(), payload } as EventMessage;
}
```

`apps/daemon/src/mcp/addressing.ts`:
```ts
import { stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isValidName } from "@orquester/config";
import { assertInsideFsRoot, FsSandboxError } from "@orquester/config/fs";
import { ToolError } from "./errors.ts";

export interface ProjectRef { workspace: string | null; name: string | null; path: string }

/** `<workspacesDir>/<ws>/<name>[/…]` → names; anything else → nulls (spec §5). */
export function projectNamesFor(projectPath: string, workspacesDir: string): ProjectRef {
  const rel = relative(workspacesDir, projectPath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return { workspace: null, name: null, path: projectPath };
  const [workspace, name] = rel.split(sep);
  if (!workspace || !name) return { workspace: null, name: null, path: projectPath };
  return { workspace, name, path: projectPath };
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

/**
 * Resolve a `project` argument: an absolute path inside the sandbox, or
 * `"<workspace>/<project>"`. The canonical path is the plain joined path (names)
 * or `path.resolve(input)` (path) — the exact string the GUI uses.
 */
export async function resolveProject(api: { fsRoot: string; workspacesDir: string }, input: string): Promise<ProjectRef> {
  const raw = input.trim();
  if (!raw) throw new ToolError("PROJECT_NOT_FOUND", "project is required: an absolute path or \"<workspace>/<project>\".");
  let path: string;
  if (isAbsolute(raw)) {
    path = resolve(raw);
  } else {
    const parts = raw.split("/");
    if (parts.length !== 2 || !isValidName(parts[0]) || !isValidName(parts[1])) {
      throw new ToolError("PROJECT_NOT_FOUND", `"${raw}" is not a "<workspace>/<project>" name pair or an absolute path.`);
    }
    path = join(api.workspacesDir, parts[0], parts[1]);
  }
  try {
    await assertInsideFsRoot(api.fsRoot, path);
  } catch (error) {
    if (error instanceof FsSandboxError) throw new ToolError("PATH_NOT_ALLOWED", "Path is not allowed (outside the sandbox).");
    throw new ToolError("PROJECT_NOT_FOUND", `No project at "${raw}".`);
  }
  if (!(await isDirectory(path))) throw new ToolError("PROJECT_NOT_FOUND", `No project directory at "${raw}". Use list_projects.`);
  const names = projectNamesFor(path, api.workspacesDir);
  if (!names.name) throw new ToolError("PROJECT_NOT_FOUND", `"${raw}" is a workspace, not a project. Use "<workspace>/<project>".`);
  return names;
}
```
(Note: `assertInsideFsRoot` realpaths its target; a symlink escaping `fsRoot` throws `FsSandboxError`, a missing path throws an ENOENT-shaped error — map each as above. If `assertInsideFsRoot` throws a non-`FsSandboxError` for a missing path, the `PROJECT_NOT_FOUND` branch covers it.)

`apps/daemon/src/mcp/reads.ts`:
```ts
import { randomUUID } from "node:crypto";
import type { SessionSummary } from "@orquester/api";
import type { AgentChatCommandName, ThreadReadResponse, ThreadSnapshotPayload } from "@orquester/api/agent-chat";
import { agentChatCommandPath, agentChatRoutes } from "@orquester/api/agent-chat";
import type { DaemonApi } from "./daemon-api.ts";
import { ToolError, daemonError, expectOk } from "./errors.ts";

export async function listSessions(api: DaemonApi, projectPath?: string): Promise<SessionSummary[]> {
  const res = await api.request("GET", "/api/sessions", projectPath ? { query: { projectPath } } : undefined);
  return expectOk<SessionSummary[]>(res, "sessions");
}

export async function findSession(api: DaemonApi, sessionId: string): Promise<SessionSummary> {
  const found = (await listSessions(api)).find((s) => s.id === sessionId);
  if (!found) throw new ToolError("SESSION_NOT_FOUND", `No session with id "${sessionId}". Use list_sessions.`);
  return found;
}

export async function requireChatSession(api: DaemonApi, sessionId: string): Promise<SessionSummary> {
  const session = await findSession(api, sessionId);
  if (session.kind !== "agent-chat") {
    throw new ToolError("NOT_A_CHAT_SESSION", `Session "${sessionId}" is a ${session.kind === "shell" ? "terminal" : "legacy terminal agent"} tab; this tool needs a chat session.`);
  }
  return session;
}

export async function readThread(api: DaemonApi, sessionId: string): Promise<ThreadSnapshotPayload> {
  const res = await api.request("GET", agentChatRoutes.thread(sessionId));
  const body = expectOk<ThreadReadResponse>(res, "thread");
  if (body.kind !== "snapshot") throw new ToolError("INTERNAL", "Expected a thread snapshot.");
  return body.thread;
}

export function mintCommandId(): string {
  return randomUUID();
}

const defaultRetryDelay = (attempt: number): number => Math.min(4_000, 250 * 2 ** attempt);
const RETRIES = 3;

/**
 * POST a chat command with a fresh commandId; retry 503 HOST_UNAVAILABLE (and
 * a thrown transport error) with the SAME id up to 3 times — the GUI's rule.
 */
export async function sendCommand(api: DaemonApi, sessionId: string, name: AgentChatCommandName | "account", body: Record<string, unknown>, opts?: { retryDelayMs?: (attempt: number) => number }): Promise<{ seq: number }> {
  const path = name === "account" ? agentChatRoutes.account(sessionId) : agentChatCommandPath(sessionId, name);
  const delay = opts?.retryDelayMs ?? defaultRetryDelay;
  const payload = { commandId: mintCommandId(), ...body };
  let last: ToolError | null = null;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    let res;
    try {
      res = await api.request("POST", path, { body: payload });
    } catch (error) {
      last = new ToolError("HOST_UNAVAILABLE", `The daemon call failed: ${(error as Error).message}`);
      await new Promise((r) => setTimeout(r, delay(attempt)));
      continue;
    }
    if (res.status < 400) return expectOk<{ seq: number }>(res, name);
    const err = daemonError(res);
    if (err.code !== "HOST_UNAVAILABLE") throw err;
    last = err;
    if (attempt < RETRIES) await new Promise((r) => setTimeout(r, delay(attempt)));
  }
  throw last ?? new ToolError("HOST_UNAVAILABLE", "The agent host is restarting.");
}
```

Then: `git mv apps/daemon/src/mcp/text.ts apps/daemon/src/terminal-text.ts && git mv apps/daemon/src/mcp/text.test.ts apps/daemon/src/terminal-text.test.ts` (fix the test's import to `./terminal-text.ts`), update `sessions.ts:21`, delete `terminal-control.ts`, `terminal-control.test.ts`, `keys.ts`, `keys.test.ts`, `apps/daemon/scripts/mcp-spike.ts`; fix `fs-tools.ts` (`import { ToolError } from "./errors.ts";` and its two `new ToolError("…")` calls → `new ToolError("INVALID_ARGUMENT", "…")`); apply the temporary `todo-tools.ts` import fix described under **Files**. `server.ts` will not compile until Task 11 rewrites it: to keep `pnpm check` green in the meantime, replace its whole body with a stub that keeps `registerMcp(app, deps)` compiling — `export interface McpDeps {}` and `export function registerMcp(_app: FastifyInstance, _deps: McpDeps): void {}` — and update `apps/daemon/src/index.ts:4627-4645` to `if (options.mode === "remote") { registerMcp(app, {}); }` (delete the `TerminalControl` construction and the now-unused `TerminalControl`/`listWorkspaces`-for-MCP imports if they become unused; keep `TodoTools`/`FsTools` imports for Task 11). Also delete the old `apps/daemon/src/mcp/server.test.ts` now (its harness targets the deleted tools; Task 11 writes the new one).

- [ ] **Step 3b: Add the shared test fixture builders** (`apps/daemon/src/mcp/fixtures.ts` — not a test file; imported by later tasks' tests)

```ts
import type { SessionSummary } from "@orquester/api";
import type { ThreadActivityItem, ThreadHead, ThreadMessageItem, ThreadSnapshotPayload, Turn } from "@orquester/api/agent-chat";

let counter = 0;
/** Deterministic, strictly increasing ISO stamps: 2026-09-22T00:00:<n>Z. */
export const stamp = (n: number): string => new Date(Date.UTC(2026, 8, 22, 0, 0, n)).toISOString();

export function chatSummary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "c1", kind: "agent-chat", refId: "claude", title: "Claude Code", projectPath: "/w/acme/api", cwd: "/w/acme/api",
    cols: 0, rows: 0, status: "running", order: 1, createdAt: stamp(0),
    activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(1) },
    chatSessionStatus: "ready", latestTurn: { turnId: "t1", state: "completed", startedAt: stamp(0), completedAt: stamp(1) },
    hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false, backgroundLiveness: null,
    ...over
  } as SessionSummary;
}

export function shellSummary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "t1", kind: "shell", refId: "bash", title: "bash", projectPath: "/w/acme/api", cwd: "/w/acme/api",
    cols: 80, rows: 24, status: "running", order: 2, createdAt: stamp(0),
    activity: { state: "idle", attention: null, lastOutputAt: null, needsAttentionAt: null },
    ...over
  } as SessionSummary;
}

export function head(over: Partial<ThreadHead> = {}): ThreadHead {
  return {
    id: "c1", projectPath: "/w/acme/api", cwd: "/w/acme/api", title: "Claude Code", adapter: "claude", refId: "claude",
    accountId: "", home: "system", modelSelection: { model: "claude-fable-5-1[1m]", options: [{ id: "effort", value: "high" }] },
    runtimeMode: "full-access", session: { status: "ready", activeTurnId: null }, turnCount: 1, seq: 10,
    createdAt: stamp(0), updatedAt: stamp(1), ...over
  };
}

export function message(role: ThreadMessageItem["role"], text: string, over: Partial<ThreadMessageItem> = {}): ThreadMessageItem {
  counter += 1;
  return { kind: "message", id: `${role}:${counter}`, role, text, turnId: "t1", streaming: false, createdAt: stamp(counter), updatedAt: stamp(counter), ...over };
}

export function activity(activityKind: string, payload: unknown, over: Partial<ThreadActivityItem> = {}): ThreadActivityItem {
  counter += 1;
  return { kind: "activity", id: `${activityKind}:${counter}`, tone: "info", activityKind, summary: activityKind, payload, turnId: "t1", createdAt: stamp(counter), updatedAt: stamp(counter), ...over };
}

export function turn(over: Partial<Turn> = {}): Turn {
  return { turnId: "t1", state: "completed", turnCount: 1, requestedAt: stamp(0), startedAt: stamp(0), completedAt: stamp(1), assistantMessageId: null, ...over };
}

export function snapshot(over: Partial<ThreadSnapshotPayload> = {}): ThreadSnapshotPayload {
  return { head: head(), items: [], turns: [turn()], checkpoints: [], pending: { approvals: [], userInputs: [] }, roster: [], seq: 10, ...over };
}
```

- [ ] **Step 4: Run the tests, the whole daemon suite, and the typecheck**

Run from `apps/daemon`: `node --import tsx --test src/mcp/errors.test.ts src/mcp/result.test.ts src/mcp/daemon-api.test.ts src/mcp/addressing.test.ts src/mcp/reads.test.ts src/terminal-text.test.ts` → PASS. Then `pnpm --filter @orquester/daemon test` → PASS. Then `pnpm check` → clean.

---

### Task 3: Session views and the agent catalogue (`views.ts`, `agents.ts`)

Spec §6.1, §6.2, §6.3, §5 (option ids). Runs in parallel with Tasks 4, 5, 6 after Task 2.

**Files:**
- Create: `apps/daemon/src/mcp/views.ts`, `views.test.ts`
- Create: `apps/daemon/src/mcp/agents.ts`, `agents.test.ts`

**Interfaces:**
- Consumes (Task 2): `DaemonApi`, `ToolError`, `expectOk`, `capText`, `projectNamesFor`, fixtures.
- Produces:
  ```ts
  // views.ts
  export const VIEW_TEXT_CAP = 16_384;
  export const SETTLED_TURN_STATES: ReadonlySet<string>;   // completed | failed | interrupted | cancelled
  export const DEFAULT_APPROVAL_DECISIONS: readonly ApprovalOption[];
  export type SessionReason = ChatActivityRung | "new" | "exited";
  export interface SessionView { id: string; kind: "chat" | "terminal"; agent: string; adapter?: AgentAdapterId; title: string; project: ProjectRef; cwd: string; createdAt: string; order: number;
    status: "working" | "waiting" | "idle"; attention: "needs-input" | "finished" | "bell" | null; needsAttentionAt: string | null; reason: SessionReason | null;
    chat?: { sessionStatus: ThreadSessionStatus; accountId: string; latestTurn: LatestTurnSummary | null; pending: { approvals: boolean; questions: boolean }; planReady: boolean; backgroundLiveness: "working" | "monitoring" | null };
    terminal?: { status: "running" | "exited"; exitCode?: number; legacyAgent?: boolean } }
  export interface PendingApprovalView { requestId: string; kind: ProviderRequestKind; createdAt: string; detail?: string; appName?: string; tool?: { name: string; input: unknown }; decisions: { decision: ApprovalDecision; label: string; warning?: string }[] }
  export interface PendingQuestionView { requestId: string; createdAt: string; turnId?: string; responseMode: "blocking" | "message"; dismissible: boolean;
    questions: { index: number; id: string; header: string; question: string; options: { label: string; description: string; value?: string }[]; multiSelect: boolean; allowCustomAnswer: boolean; isSecret?: boolean; isOther?: boolean }[] }
  export interface SubagentView { id: string; kind: string; agentKind: "agent" | "background"; title: string | null; status: string; model?: string; effort?: string; progress?: string; lastToolName?: string; startedAt: string | null; completedAt: string | null; error?: string }
  export interface PlanView { planId: string; markdown: string; truncated: boolean; actionable: boolean }
  export interface SessionDetail extends SessionView { chat: SessionView["chat"] & { model: string; options: Record<string, string | boolean>; runtimeMode: RuntimeMode; home: AccountHomeKind; accountLabel?: string; activeTurnId: string | null; turnCount: number; lastError?: string; continueAfterRestart: boolean;
      contextWindow?: { usedTokens: number; maxTokens?: number; percentUsed?: number; compactsAutomatically?: boolean }; supports: { planMode: boolean; rollback: boolean; compaction: boolean; backgroundTasks: boolean } };
    pending: { approvals: PendingApprovalView[]; questions: PendingQuestionView[] }; plan?: PlanView; subagents: SubagentView[]; lastReply?: { turnId: string; text: string; truncated: boolean; completedAt: string | null } }
  export interface ViewContext { workspacesDir: string; adapterByRefId: ReadonlyMap<string, AgentAdapterId>; accountLabelById: ReadonlyMap<string, string>; capabilitiesByAdapter: ReadonlyMap<string, AdapterCapabilities> }
  export async function buildViewContext(api: DaemonApi): Promise<ViewContext>;   // GET /api/registry, /api/agent-accounts, /api/agent/providers — each failure tolerated (empty map)
  export function sessionReason(s: SessionSummary): SessionReason | null;
  export function sessionView(s: SessionSummary, ctx: ViewContext): SessionView;
  export function sessionDetail(s: SessionSummary, snap: ThreadSnapshotPayload, ctx: ViewContext): SessionDetail;
  export function pendingApprovalViews(snap: ThreadSnapshotPayload): PendingApprovalView[];
  export function pendingQuestionViews(snap: ThreadSnapshotPayload): PendingQuestionView[];
  export function planView(snap: ThreadSnapshotPayload, s: SessionSummary): PlanView | null;
  export function latestSettledTurn(turns: readonly Turn[]): Turn | null;
  export function assistantTextForTurn(items: readonly ThreadItem[], turnId: string): string;
  export function lastReply(snap: ThreadSnapshotPayload): SessionDetail["lastReply"] | null;
  export function optionsObject(options: readonly ProviderOptionSelection[] | undefined): Record<string, string | boolean>;
  export async function chatDetail(api: DaemonApi, sessionId: string): Promise<SessionDetail>;   // requireChatSession + readThread + buildViewContext → sessionDetail (used by Tasks 8, 9, 10)
  // agents.ts
  export const EFFORT_OPTION_IDS: Record<AgentAdapterId, string>;   // claude:"effort", codex:"effort", opencode:"variant", grok:"reasoningEffort"
  export interface AgentModelOptionView { id: string; label: string; type: "select" | "boolean"; description?: string; values?: { id: string; label: string; description?: string; isDefault?: boolean }[] }
  export interface AgentModelView { slug: string; name: string; shortName?: string; isDefault: boolean; isLegacy?: boolean; providerLabel?: string; options: AgentModelOptionView[] }
  export interface AgentAccountView { id: string; label: string; email: string | null; plan: string | null; needsReauth: boolean; isDefault: boolean }
  export interface AgentView { id: string; name: string; adapter: AgentAdapterId; enabled: boolean; installed: boolean; version: string | null; status: string; message?: string; auth: { status: string; label?: string; email?: string };
    models: AgentModelView[]; effortOptionId: string; runtimeModes: readonly RuntimeMode[]; defaultRuntimeMode: RuntimeMode; supports: { planMode: boolean; rollback: boolean; compaction: boolean; backgroundTasks: boolean; contextWindow: boolean }; accounts: AgentAccountView[]; defaultAccountId: string }
  export async function loadAgents(api: DaemonApi, opts?: { includeLegacyModels?: boolean }): Promise<AgentView[]>;
  export function findAgent(agents: readonly AgentView[], refId: string): AgentView;                       // ToolError INVALID_ARGUMENT listing ids
  export function isProxyAgent(refId: string): boolean;                                                    // claudex | claudemix
  export interface ResolvedSelection { model: string; options: { id: string; value: string | boolean }[] }
  export function resolveModelSelection(agent: AgentView, input: { model?: string; options?: Record<string, string | boolean>; current?: ModelSelection }): ResolvedSelection;
  export function validateAccountId(agent: AgentView, accountId: string | undefined): string | undefined;  // "system" | a family account id | undefined; ToolError INVALID_ARGUMENT otherwise
  ```

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/mcp/views.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeDaemonApi } from "./testing.ts";
import { activity, chatSummary, head, message, shellSummary, snapshot, stamp, turn } from "./fixtures.ts";
import { buildViewContext, chatDetail, lastReply, optionsObject, pendingApprovalViews, pendingQuestionViews, planView, sessionDetail, sessionReason, sessionView, type ViewContext } from "./views.ts";

const ctx: ViewContext = { workspacesDir: "/w", adapterByRefId: new Map([["claude", "claude"], ["codex", "codex"]]), accountLabelById: new Map([["acc-1", "jasperclaude"]]),
  capabilitiesByAdapter: new Map([["claude", { sessionModelSwitch: "in-session", supportsConversationRollback: true, showPlanModeToggle: true, reportsContextWindow: true, compaction: { type: "slash-command", command: "/compact" }, supportsBackgroundTasks: true }]]) };

test("sessionReason: every ladder rung, plus new and exited", () => {
  assert.equal(sessionReason(chatSummary({ hasPendingApprovals: true })), "approval");
  assert.equal(sessionReason(chatSummary({ hasPendingUserInput: true })), "question");
  assert.equal(sessionReason(chatSummary({ chatSessionStatus: "error" })), "error");
  assert.equal(sessionReason(chatSummary({ chatSessionStatus: "starting" })), "starting");
  assert.equal(sessionReason(chatSummary({ chatSessionStatus: "running", latestTurn: { turnId: "t2", state: "running", startedAt: stamp(2), completedAt: null } })), "running");
  assert.equal(sessionReason(chatSummary({ hasActionableProposedPlan: true })), "plan-ready");
  assert.equal(sessionReason(chatSummary({ backgroundLiveness: "working" })), "background-working");
  assert.equal(sessionReason(chatSummary({ backgroundLiveness: "monitoring" })), "monitoring");
  assert.equal(sessionReason(chatSummary()), "completed");
  assert.equal(sessionReason(chatSummary({ chatSessionStatus: "idle", latestTurn: null })), "new");
  assert.equal(sessionReason(shellSummary({ status: "exited", exitCode: 0 })), "exited");
  assert.equal(sessionReason(shellSummary()), null);
});

test("sessionView projects a chat summary and a terminal summary", () => {
  const chat = sessionView(chatSummary({ accountId: "acc-1" }), ctx);
  assert.equal(chat.kind, "chat"); assert.equal(chat.adapter, "claude"); assert.equal(chat.agent, "claude");
  assert.deepEqual(chat.project, { workspace: "acme", name: "api", path: "/w/acme/api" });
  assert.equal(chat.status, "idle"); assert.equal(chat.attention, "finished"); assert.equal(chat.needsAttentionAt, stamp(1)); assert.equal(chat.reason, "completed");
  assert.deepEqual(chat.chat, { sessionStatus: "ready", accountId: "acc-1", latestTurn: { turnId: "t1", state: "completed", startedAt: stamp(0), completedAt: stamp(1) }, pending: { approvals: false, questions: false }, planReady: false, backgroundLiveness: null });
  assert.equal(chat.terminal, undefined);
  const system = sessionView(chatSummary(), ctx);
  assert.equal(system.chat?.accountId, "system");
  const term = sessionView(shellSummary({ kind: "agent", status: "exited", exitCode: 1 }), ctx);
  assert.equal(term.kind, "terminal"); assert.deepEqual(term.terminal, { status: "exited", exitCode: 1, legacyAgent: true }); assert.equal(term.chat, undefined);
});

test("sessionDetail merges the head, context window, pending requests, plan, roster and last reply", () => {
  const snap = snapshot({
    head: head({ accountId: "acc-1", home: "account", session: { status: "ready", activeTurnId: null, lastError: "boom" }, turnCount: 2, continueAfterRestart: { turnId: "t1" } }),
    turns: [turn(), turn({ turnId: "t2", turnCount: 2, requestedAt: stamp(2), startedAt: stamp(2), completedAt: stamp(3) })],
    items: [
      message("user", "hi", { turnId: "t1" }), message("assistant", "first", { turnId: "t1" }),
      message("user", "again", { turnId: "t2" }), message("assistant", "part one", { turnId: "t2" }), message("assistant", "sub text", { turnId: "t2", agentId: "task-9" }), message("assistant", "part two", { turnId: "t2" }),
      activity("context-window.updated", { usedTokens: 50_000, maxTokens: 200_000, compactsAutomatically: true }),
      activity("approval.requested", { requestId: "r1", requestKind: "command", requestType: "command_execution_approval", dismissible: false, detail: "rm -rf build", args: { toolName: "Bash", input: { command: "rm -rf build" } } }, { tone: "approval" }),
      activity("user-input.requested", { requestId: "q1", dismissible: false, questions: [{ id: "Which db?", header: "DB", question: "Which db?", options: [{ label: "Postgres", description: "pg" }], isSecret: true }] }),
      activity("turn.proposed.completed", { planId: "p1", planMarkdown: "# Plan\n\ndo x" })
    ],
    pending: { approvals: [{ requestId: "r1", requestKind: "command", createdAt: stamp(5), detail: "rm -rf build" }],
      userInputs: [{ requestId: "q1", createdAt: stamp(6), dismissible: false, turnId: "t2", questions: [{ id: "Which db?", header: "DB", question: "Which db?", options: [{ label: "Postgres", description: "pg" }], multiSelect: false, allowCustomAnswer: true }] }] },
    roster: [{ id: "task-9", kind: "subagent", agentKind: "agent", title: "Explore", role: null, model: "sonnet", effort: null, status: "completed", activationCount: 1, usage: null, progress: null, lastToolName: "Read", result: null, error: null, outputFile: null, exitCode: null, isBackgrounded: false, parentAgentId: null, agentIndex: null, phaseIndex: null, phaseTitle: null, attempt: 1, workflowName: null, phases: [], runHandles: [], recentActivity: [], firstSeenAt: stamp(2), startedAt: stamp(2), completedAt: stamp(3), updatedAt: stamp(3) } as never]
  });
  const d = sessionDetail(chatSummary({ accountId: "acc-1", hasPendingApprovals: true, hasPendingUserInput: true, hasActionableProposedPlan: true }), snap, ctx);
  assert.equal(d.chat.model, "claude-fable-5-1[1m]"); assert.deepEqual(d.chat.options, { effort: "high" }); assert.equal(d.chat.runtimeMode, "full-access");
  assert.equal(d.chat.home, "account"); assert.equal(d.chat.accountLabel, "jasperclaude"); assert.equal(d.chat.lastError, "boom"); assert.equal(d.chat.turnCount, 2, "two started turns (t1, t2) — counted by order, not by head.turnCount or checkpoints"); assert.equal(d.chat.continueAfterRestart, true);
  assert.deepEqual(d.chat.contextWindow, { usedTokens: 50_000, maxTokens: 200_000, percentUsed: 25, compactsAutomatically: true });
  assert.deepEqual(d.chat.supports, { planMode: true, rollback: true, compaction: true, backgroundTasks: true });
  assert.equal(d.pending.approvals[0].requestId, "r1"); assert.deepEqual(d.pending.approvals[0].tool, { name: "Bash", input: { command: "rm -rf build" } });
  assert.deepEqual(d.pending.approvals[0].decisions.map((x) => x.decision), ["accept", "acceptForSession", "decline", "cancel"]);
  assert.equal(d.pending.questions[0].responseMode, "blocking"); assert.equal(d.pending.questions[0].questions[0].index, 1); assert.equal(d.pending.questions[0].questions[0].isSecret, true); assert.equal(d.pending.questions[0].questions[0].allowCustomAnswer, true);
  assert.deepEqual(d.plan, { planId: "p1", markdown: "# Plan\n\ndo x", truncated: false, actionable: true });
  assert.equal(d.subagents[0].id, "task-9"); assert.equal(d.subagents[0].status, "completed"); assert.equal(d.subagents[0].lastToolName, "Read");
  assert.deepEqual(d.lastReply, { turnId: "t2", text: "part one\n\npart two", truncated: false, completedAt: stamp(3) });
});

test("pending views: advertised decisions win over the default four; a message-mode question is dismissible", () => {
  const snap = snapshot({ pending: { approvals: [{ requestId: "r2", requestKind: "permission", createdAt: stamp(1), options: [{ decision: "accept", label: "Allow once" }, { decision: "decline", label: "Deny", warning: "w" }] }],
    userInputs: [{ requestId: "q2", createdAt: stamp(2), dismissible: true, responseMode: "message", questions: [{ id: "x", header: "H", question: "X?", options: [], multiSelect: true, allowCustomAnswer: true }] }] } });
  assert.deepEqual(pendingApprovalViews(snap)[0].decisions, [{ decision: "accept", label: "Allow once" }, { decision: "decline", label: "Deny", warning: "w" }]);
  const q = pendingQuestionViews(snap)[0];
  assert.equal(q.responseMode, "message"); assert.equal(q.dismissible, true); assert.equal(q.questions[0].multiSelect, true);
});

test("planView caps the markdown, lastReply skips subagent text and unsettled turns, optionsObject flattens", () => {
  const long = "x".repeat(20_000);
  const snap = snapshot({ items: [activity("turn.proposed.completed", { planId: "p", planMarkdown: long })] });
  const p = planView(snap, chatSummary())!;
  assert.equal(p.truncated, true); assert.equal(p.markdown.length, 16_384); assert.equal(p.actionable, false);
  assert.equal(planView(snapshot(), chatSummary()), null);
  const running = snapshot({ turns: [turn({ turnId: "t1", state: "running", completedAt: null })], items: [message("assistant", "partial", { turnId: "t1" })] });
  assert.equal(lastReply(running), null);
  assert.deepEqual(optionsObject([{ id: "effort", value: "high" }, { id: "thinking", value: true }]), { effort: "high", thinking: true });
  assert.deepEqual(optionsObject(undefined), {});
});

test("chatDetail refuses a terminal session and builds a detail for a chat", async () => {
  const api = new FakeDaemonApi()
    .on("GET", "/api/sessions", { status: 200, body: [chatSummary(), shellSummary()] })
    .on("GET", "/api/sessions/c1/thread", { status: 200, body: { kind: "snapshot", thread: snapshot() } })
    .on("GET", "/api/registry", { status: 200, body: { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [] } })
    .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [], defaults: {} } })
    .on("GET", "/api/agent/providers", { status: 503, body: null });
  await assert.rejects(chatDetail(api, "t1"), (e: { code: string }) => e.code === "NOT_A_CHAT_SESSION");
  const d = await chatDetail(api, "c1");
  assert.equal(d.chat.model, "claude-fable-5-1[1m]"); assert.equal(d.chat.accountId, "system");
});

test("buildViewContext reads registry, accounts and providers and tolerates a failing providers call", async () => {
  const api = new FakeDaemonApi()
    .on("GET", "/api/registry", { status: 200, body: { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [{ id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } }, { id: "deepseek", kind: "agent", name: "DeepSeek", bin: ["deepseek"], enabled: false, installState: "idle" }] } })
    .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [{ id: "acc-1", agent: "claude", label: "jasperclaude", email: null, plan: null, needsReauth: false, createdAt: stamp(0), importedAt: stamp(0) }], defaults: { claude: "acc-1", codex: null, grok: null } } })
    .on("GET", "/api/agent/providers", { status: 503, body: { error: { code: "HOST_UNAVAILABLE", message: "restarting" } } });
  const c = await buildViewContext(api);
  assert.deepEqual([...c.adapterByRefId], [["claude", "claude"]]);
  assert.equal(c.accountLabelById.get("acc-1"), "jasperclaude");
  assert.equal(c.capabilitiesByAdapter.size, 0);
  assert.equal(c.workspacesDir, "/w");
});
```

`apps/daemon/src/mcp/agents.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeDaemonApi } from "./testing.ts";
import { stamp } from "./fixtures.ts";
import { EFFORT_OPTION_IDS, findAgent, isProxyAgent, loadAgents, resolveModelSelection, validateAccountId, type AgentView } from "./agents.ts";

const registry = { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [
  { id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", version: "2.1.280", chat: { adapter: "claude" } },
  { id: "claudex", kind: "agent", name: "Claude Code × GPT/Kimi/Grok", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } },
  { id: "grok", kind: "agent", name: "Grok Build", bin: ["grok"], enabled: false, installState: "idle", chat: { adapter: "grok" } },
  { id: "deepseek", kind: "agent", name: "DeepSeek", bin: ["deepseek"], enabled: false, installState: "idle" }
] };
const providers = { hostInstanceId: "h1", providers: [
  { id: "claude", refIds: ["claude", "claudex", "claudemix"], installed: true, version: "2.1.280", status: "ready", auth: { status: "authenticated", label: "system" }, checkedAt: stamp(0), slashCommands: [], skills: [],
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: true, showPlanModeToggle: true, reportsContextWindow: true, compaction: { type: "slash-command", command: "/compact" }, supportsBackgroundTasks: true },
    models: [
      { slug: "default", name: "Default · Opus", isDefault: true, capabilities: { optionDescriptors: [{ id: "effort", label: "Effort", type: "select", options: [{ id: "medium", label: "Medium", isDefault: true }, { id: "high", label: "High" }] }, { id: "thinking", label: "Thinking", type: "boolean" }] } },
      { slug: "haiku", name: "Haiku", capabilities: { optionDescriptors: [] } },
      { slug: "old", name: "Old", isLegacy: true, capabilities: null }
    ] },
  { id: "grok", refIds: ["grok"], installed: false, version: null, status: "unknown", auth: { status: "unknown" }, checkedAt: stamp(0), slashCommands: [], skills: [],
    capabilities: { sessionModelSwitch: "in-session", showPlanModeToggle: false, reportsContextWindow: true, compaction: { type: "slash-command", command: "/compact" } },
    models: [{ slug: "grok-4.6", name: "Grok 4.6", isDefault: true, capabilities: { optionDescriptors: [{ id: "reasoningEffort", label: "Reasoning", type: "select", options: [{ id: "high", label: "High", isDefault: true }, { id: "low", label: "Low" }] }] } }] }
] };
const accounts = { accounts: [
  { id: "acc-1", agent: "claude", label: "jasperclaude", email: null, plan: "max", needsReauth: false, createdAt: stamp(0), importedAt: stamp(0) },
  { id: "acc-2", agent: "codex", label: "eduard@x.io", email: "eduard@x.io", plan: null, needsReauth: true, createdAt: stamp(0), importedAt: stamp(0) },
  { id: "acc-3", agent: "codex", label: "unseeded@x.io", email: "unseeded@x.io", plan: null, needsReauth: false, createdAt: stamp(0), importedAt: stamp(0) }
], defaults: { claude: "acc-1", codex: "acc-2", grok: null } };
const cliproxy = { state: "healthy", reasons: [], detail: null, version: null, defaultModel: "gpt-5.6-sol", backgroundModel: "", modelOverrides: {}, providers: [], routerProviders: [], accounts: [{ id: "acc-2", provider: "codex", label: "eduard@x.io" }], activeSessionCount: 0, testedClaudeCliVersion: null, xai: { state: "none", email: null, expiredAt: null, lastQuotaError: null, lastLinkError: null, link: null } };

function api() {
  return new FakeDaemonApi().on("GET", "/api/registry", { status: 200, body: registry }).on("GET", "/api/agent/providers", { status: 200, body: providers })
    .on("GET", "/api/agent-accounts", { status: 200, body: accounts }).on("GET", "/api/cliproxy", { status: 200, body: cliproxy }).on("GET", "/api/cliproxy/models", { status: 200, body: { models: [], asOf: null } });
}

test("loadAgents lists only chat-capable entries with models, options, accounts and defaults", async () => {
  const agents = await loadAgents(api());
  assert.deepEqual(agents.map((a) => a.id), ["claude", "claudex", "grok"]);
  const claude = agents[0];
  assert.equal(claude.adapter, "claude"); assert.equal(claude.enabled, true); assert.equal(claude.version, "2.1.280"); assert.equal(claude.auth.status, "authenticated");
  assert.deepEqual(claude.models.map((m) => m.slug), ["default", "haiku"]);
  assert.equal(claude.models[0].isDefault, true);
  assert.deepEqual(claude.models[0].options[0], { id: "effort", label: "Effort", type: "select", values: [{ id: "medium", label: "Medium", isDefault: true }, { id: "high", label: "High" }] });
  assert.deepEqual(claude.models[0].options[1], { id: "thinking", label: "Thinking", type: "boolean" });
  assert.equal(claude.effortOptionId, "effort");
  assert.deepEqual(claude.supports, { planMode: true, rollback: true, compaction: true, backgroundTasks: true, contextWindow: true });
  assert.deepEqual(claude.accounts, [{ id: "system", label: "System", email: null, plan: null, needsReauth: false, isDefault: false }, { id: "acc-1", label: "jasperclaude", email: null, plan: "max", needsReauth: false, isDefault: true }]);
  assert.equal(claude.defaultAccountId, "acc-1");
  const grok = agents[2];
  assert.equal(grok.enabled, false); assert.equal(grok.installed, false); assert.equal(grok.effortOptionId, "reasoningEffort"); assert.equal(grok.defaultAccountId, "system");
  assert.equal((await loadAgents(api(), { includeLegacyModels: true }))[0].models.length, 3);
});

test("a proxy launcher lists the proxy catalogue and only SEEDED accounts of its backing family", async () => {
  const claudex = (await loadAgents(api()))[1];
  assert.ok(claudex.models.some((m) => m.slug === "gpt-5.6-sol" && m.isDefault));
  assert.deepEqual(claudex.accounts.map((a) => a.id), ["system", "acc-2"]);
  assert.equal(claudex.defaultAccountId, "acc-2");
  assert.equal(isProxyAgent("claudex"), true); assert.equal(isProxyAgent("claude"), false);
});

test("findAgent names the valid ids on a miss", async () => {
  const agents = await loadAgents(api());
  assert.equal(findAgent(agents, "grok").id, "grok");
  assert.throws(() => findAgent(agents, "gemini"), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /claude, claudex, grok/.test(e.message));
});

test("resolveModelSelection: defaults, validation, effort alias, merge with current, drop foreign options", async () => {
  const claude = (await loadAgents(api()))[0];
  assert.deepEqual(resolveModelSelection(claude, {}), { model: "default", options: [] });
  assert.deepEqual(resolveModelSelection(claude, { model: "default", options: { effort: "high", thinking: true } }), { model: "default", options: [{ id: "effort", value: "high" }, { id: "thinking", value: true }] });
  assert.deepEqual(resolveModelSelection(claude, { model: "default", options: { effort: "High" } }).options, [{ id: "effort", value: "high" }]);
  assert.throws(() => resolveModelSelection(claude, { model: "sonnet-9" }), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /default, haiku/.test(e.message));
  assert.throws(() => resolveModelSelection(claude, { model: "default", options: { effort: "ultra" } }), (e: { message: string }) => /medium, high/.test(e.message));
  assert.throws(() => resolveModelSelection(claude, { model: "default", options: { thinking: "yes" } }), (e: { message: string }) => /boolean/.test(e.message));
  assert.throws(() => resolveModelSelection(claude, { model: "default", options: { turbo: true } }), (e: { message: string }) => /effort, thinking/.test(e.message));
  const merged = resolveModelSelection(claude, { options: { effort: "high" }, current: { model: "default", options: [{ id: "thinking", value: true }] } });
  assert.deepEqual(merged, { model: "default", options: [{ id: "thinking", value: true }, { id: "effort", value: "high" }] });
  const switched = resolveModelSelection(claude, { model: "haiku", current: { model: "default", options: [{ id: "effort", value: "high" }] } });
  assert.deepEqual(switched, { model: "haiku", options: [] });
  const grok = (await loadAgents(api()))[2];
  assert.deepEqual(resolveModelSelection(grok, { options: { effort: "low" } }), { model: "grok-4.6", options: [{ id: "reasoningEffort", value: "low" }] });
  assert.equal(EFFORT_OPTION_IDS.opencode, "variant");
});

test("a model without descriptors passes options through; an empty catalogue refuses", async () => {
  const claude = (await loadAgents(api()))[0];
  assert.deepEqual(resolveModelSelection(claude, { model: "haiku", options: { effort: "max" } }).options, [{ id: "effort", value: "max" }]);
  const empty: AgentView = { ...claude, models: [] };
  assert.throws(() => resolveModelSelection(empty, {}), (e: { message: string }) => /Still loading/.test(e.message));
});

test("validateAccountId accepts system and family accounts, refuses the rest with the valid list", async () => {
  const agents = await loadAgents(api());
  assert.equal(validateAccountId(agents[0], undefined), undefined);
  assert.equal(validateAccountId(agents[0], "system"), "system");
  assert.equal(validateAccountId(agents[0], "acc-1"), "acc-1");
  assert.throws(() => validateAccountId(agents[0], "acc-2"), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /acc-1/.test(e.message));
  assert.throws(() => validateAccountId(agents[1], "acc-3"), (e: { message: string }) => /seeded/.test(e.message));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run from `apps/daemon`: `node --import tsx --test src/mcp/views.test.ts src/mcp/agents.test.ts` → FAIL.

- [ ] **Step 3: Write the implementations**

`apps/daemon/src/mcp/views.ts`:
```ts
import { SYSTEM_ACCOUNT_ID, type AgentAccountsResponse, type RegistryResponse, type SessionSummary } from "@orquester/api";
import { agentChatRoutes } from "@orquester/api/agent-chat";
import type { AccountHomeKind, AdapterCapabilities, AgentAdapterId, AgentProvidersResponse, ApprovalDecision, ApprovalOption, LatestTurnSummary, ProviderOptionSelection, ProviderRequestKind, RuntimeMode, RuntimeSubagent, ThreadActivityItem, ThreadItem, ThreadSessionStatus, ThreadSnapshotPayload, ThreadTokenUsage, Turn, UserInputQuestion } from "@orquester/api/agent-chat";
import { startedTurns } from "@orquester/api/agent-chat";
import { resolveChatActivity, type ChatActivityRung } from "../agent-chat/activity-ladder.ts";
import { projectNamesFor, type ProjectRef } from "./addressing.ts";
import type { DaemonApi } from "./daemon-api.ts";
import { readThread, requireChatSession } from "./reads.ts";
import { capText } from "./result.ts";

export const VIEW_TEXT_CAP = 16_384;
export const SETTLED_TURN_STATES: ReadonlySet<string> = new Set(["completed", "failed", "interrupted", "cancelled"]);
/** §4.3's default four, in the GUI's order (`banner-model.ts`). */
export const DEFAULT_APPROVAL_DECISIONS: readonly ApprovalOption[] = [
  { decision: "accept", label: "Approve" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "decline", label: "Decline" },
  { decision: "cancel", label: "Cancel" }
];

export type SessionReason = ChatActivityRung | "new" | "exited";
export interface SessionView { /* as in Interfaces above */ }
export interface PendingApprovalView { /* … */ }
export interface PendingQuestionView { /* … */ }
export interface SubagentView { /* … */ }
export interface PlanView { planId: string; markdown: string; truncated: boolean; actionable: boolean }
export interface SessionDetail extends SessionView { /* … */ }
export interface ViewContext { workspacesDir: string; adapterByRefId: ReadonlyMap<string, AgentAdapterId>; accountLabelById: ReadonlyMap<string, string>; capabilitiesByAdapter: ReadonlyMap<string, AdapterCapabilities> }

export async function buildViewContext(api: DaemonApi): Promise<ViewContext> {
  const adapterByRefId = new Map<string, AgentAdapterId>();
  const accountLabelById = new Map<string, string>();
  const capabilitiesByAdapter = new Map<string, AdapterCapabilities>();
  const registry = await api.request("GET", "/api/registry");
  if (registry.status < 400) {
    for (const entry of (registry.body as RegistryResponse).agents ?? []) if (entry.chat?.adapter) adapterByRefId.set(entry.id, entry.chat.adapter);
  }
  const accounts = await api.request("GET", "/api/agent-accounts");
  if (accounts.status < 400) {
    for (const account of (accounts.body as AgentAccountsResponse).accounts ?? []) accountLabelById.set(account.id, account.label);
  }
  const providers = await api.request("GET", agentChatRoutes.providers);
  if (providers.status < 400) {
    for (const provider of (providers.body as AgentProvidersResponse).providers ?? []) capabilitiesByAdapter.set(provider.id, provider.capabilities);
  }
  return { workspacesDir: api.workspacesDir, adapterByRefId, accountLabelById, capabilitiesByAdapter };
}

export function sessionReason(s: SessionSummary): SessionReason | null {
  if (s.kind !== "agent-chat") return s.status === "exited" ? "exited" : null;
  if ((s.chatSessionStatus ?? "idle") === "idle" && !s.latestTurn) return "new";
  const rung = resolveChatActivity(s).rung;
  return rung === "unknown" ? null : rung;
}

export function sessionView(s: SessionSummary, ctx: ViewContext): SessionView {
  const isChat = s.kind === "agent-chat";
  const view: SessionView = {
    id: s.id, kind: isChat ? "chat" : "terminal", agent: s.refId, title: s.title,
    project: projectNamesFor(s.projectPath, ctx.workspacesDir), cwd: s.cwd, createdAt: s.createdAt, order: s.order,
    status: s.activity?.state ?? "idle", attention: s.activity?.attention ?? null, needsAttentionAt: s.activity?.needsAttentionAt ?? null,
    reason: sessionReason(s)
  };
  if (isChat) {
    const adapter = ctx.adapterByRefId.get(s.refId);
    if (adapter) view.adapter = adapter;
    view.chat = {
      sessionStatus: s.chatSessionStatus ?? "idle", accountId: s.accountId ?? SYSTEM_ACCOUNT_ID, latestTurn: s.latestTurn ?? null,
      pending: { approvals: s.hasPendingApprovals === true, questions: s.hasPendingUserInput === true },
      planReady: s.hasActionableProposedPlan === true, backgroundLiveness: s.backgroundLiveness ?? null
    };
  } else {
    view.terminal = { status: s.status };
    if (s.exitCode !== undefined) view.terminal.exitCode = s.exitCode;
    if (s.kind === "agent") view.terminal.legacyAgent = true;
  }
  return view;
}

export function optionsObject(options: readonly ProviderOptionSelection[] | undefined): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const o of options ?? []) out[o.id] = o.value;
  return out;
}

function rawRequestActivity(items: readonly ThreadItem[], activityKind: string, requestId: string): ThreadActivityItem | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.kind === "activity" && item.activityKind === activityKind && (item.payload as { requestId?: unknown } | null)?.requestId === requestId) return item;
  }
  return undefined;
}

function boundedJson(value: unknown, maxChars: number): unknown {
  const text = JSON.stringify(value ?? null);
  return text.length <= maxChars ? value : capText(text, maxChars).text;
}

export function pendingApprovalViews(snap: ThreadSnapshotPayload): PendingApprovalView[] {
  return snap.pending.approvals.map((a) => {
    const raw = rawRequestActivity(snap.items, "approval.requested", a.requestId);
    const args = (raw?.payload as { args?: { toolName?: unknown; input?: unknown } } | undefined)?.args;
    const view: PendingApprovalView = {
      requestId: a.requestId, kind: a.requestKind, createdAt: a.createdAt,
      decisions: (a.options ?? DEFAULT_APPROVAL_DECISIONS).map((o) => ({ decision: o.decision, label: o.label, ...(o.warning ? { warning: o.warning } : {}) }))
    };
    if (a.detail) view.detail = capText(a.detail, 4096).text;
    if (a.appName) view.appName = a.appName;
    if (args && typeof args === "object" && typeof args.toolName === "string") view.tool = { name: args.toolName, input: boundedJson(args.input, 4096) };
    return view;
  });
}

export function pendingQuestionViews(snap: ThreadSnapshotPayload): PendingQuestionView[] {
  return snap.pending.userInputs.map((q) => {
    const raw = rawRequestActivity(snap.items, "user-input.requested", q.requestId);
    const rawQuestions = (raw?.payload as { questions?: UserInputQuestion[] } | undefined)?.questions ?? [];
    const view: PendingQuestionView = {
      requestId: q.requestId, createdAt: q.createdAt, responseMode: q.responseMode === "message" ? "message" : "blocking", dismissible: q.dismissible,
      questions: q.questions.map((question, i) => {
        const rq = rawQuestions.find((r) => r.id === question.id) ?? rawQuestions[i];
        const qv: PendingQuestionView["questions"][number] = {
          index: i + 1, id: question.id, header: question.header, question: question.question,
          options: question.options.map((o) => ({ label: o.label, description: o.description, ...(o.value !== undefined ? { value: o.value } : {}) })),
          multiSelect: question.multiSelect === true, allowCustomAnswer: question.allowCustomAnswer !== false
        };
        if (rq?.isSecret) qv.isSecret = true;
        if (rq?.isOther) qv.isOther = true;
        return qv;
      })
    };
    if (q.turnId) view.turnId = q.turnId;
    return view;
  });
}

export function planView(snap: ThreadSnapshotPayload, s: SessionSummary): PlanView | null {
  for (let i = snap.items.length - 1; i >= 0; i -= 1) {
    const item = snap.items[i]!;
    if (item.kind === "activity" && item.activityKind === "turn.proposed.completed") {
      const p = item.payload as { planId?: string; planMarkdown?: string };
      const md = capText(p.planMarkdown ?? "", VIEW_TEXT_CAP);
      return { planId: p.planId ?? item.id, markdown: md.text, truncated: md.truncated, actionable: s.hasActionableProposedPlan === true };
    }
  }
  return null;
}

export function subagentView(r: RuntimeSubagent): SubagentView {
  const v: SubagentView = { id: r.id, kind: r.kind, agentKind: r.agentKind, title: r.title ?? null, status: r.status, startedAt: r.startedAt ?? null, completedAt: r.completedAt ?? null };
  if (r.model) v.model = r.model;
  if (r.effort) v.effort = r.effort;
  if (r.progress) v.progress = typeof r.progress === "string" ? r.progress : JSON.stringify(r.progress);
  if (r.lastToolName) v.lastToolName = r.lastToolName;
  if (r.error) v.error = typeof r.error === "string" ? r.error : JSON.stringify(r.error);
  return v;
}

export function latestSettledTurn(turns: readonly Turn[]): Turn | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i]!;
    if (t.turnId && SETTLED_TURN_STATES.has(t.state)) return t;
  }
  return null;
}

export function assistantTextForTurn(items: readonly ThreadItem[], turnId: string): string {
  return items.filter((i): i is Extract<ThreadItem, { kind: "message" }> => i.kind === "message" && i.role === "assistant" && i.turnId === turnId && !i.agentId).map((i) => i.text).filter(Boolean).join("\n\n");
}

export function lastReply(snap: ThreadSnapshotPayload): SessionDetail["lastReply"] | null {
  const t = latestSettledTurn(snap.turns);
  if (!t?.turnId) return null;
  const capped = capText(assistantTextForTurn(snap.items, t.turnId), VIEW_TEXT_CAP);
  return { turnId: t.turnId, text: capped.text, truncated: capped.truncated, completedAt: t.completedAt };
}

function latestContextWindow(items: readonly ThreadItem[]): SessionDetail["chat"]["contextWindow"] | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.kind === "activity" && item.activityKind === "context-window.updated") {
      const u = item.payload as ThreadTokenUsage;
      const cw: NonNullable<SessionDetail["chat"]["contextWindow"]> = { usedTokens: u.usedTokens };
      if (typeof u.maxTokens === "number" && u.maxTokens > 0) { cw.maxTokens = u.maxTokens; cw.percentUsed = Math.round((u.usedTokens / u.maxTokens) * 100); }
      if (typeof u.compactsAutomatically === "boolean") cw.compactsAutomatically = u.compactsAutomatically;
      return cw;
    }
  }
  return undefined;
}

/** The full detail of a chat session: the summary, its thread snapshot and the catalogue context. */
export async function chatDetail(api: DaemonApi, sessionId: string): Promise<SessionDetail> {
  const summary = await requireChatSession(api, sessionId);
  const [snap, ctx] = await Promise.all([readThread(api, sessionId), buildViewContext(api)]);
  return sessionDetail(summary, snap, ctx);
}

export function sessionDetail(s: SessionSummary, snap: ThreadSnapshotPayload, ctx: ViewContext): SessionDetail {
  const base = sessionView(s, ctx);
  const head = snap.head;
  const caps = ctx.capabilitiesByAdapter.get(head.adapter);
  const chat: SessionDetail["chat"] = {
    ...(base.chat as NonNullable<SessionView["chat"]>),
    model: head.modelSelection.model, options: optionsObject(head.modelSelection.options), runtimeMode: head.runtimeMode, home: head.home,
    // Turns are numbered by START ORDER (turns.ts), never by the sparse checkpoint list — this is the number revert_session/get_turn_diff speak in.
    activeTurnId: head.session.activeTurnId, turnCount: startedTurns(snap.turns).length, continueAfterRestart: head.continueAfterRestart !== undefined,
    supports: { planMode: caps?.showPlanModeToggle ?? false, rollback: caps?.supportsConversationRollback ?? false, compaction: caps?.compaction !== undefined, backgroundTasks: caps?.supportsBackgroundTasks ?? false }
  };
  const label = head.accountId ? ctx.accountLabelById.get(head.accountId) : "System";
  if (label) chat.accountLabel = label;
  if (head.session.lastError) chat.lastError = head.session.lastError;
  const cw = latestContextWindow(snap.items);
  if (cw) chat.contextWindow = cw;
  const detail: SessionDetail = { ...base, chat, pending: { approvals: pendingApprovalViews(snap), questions: pendingQuestionViews(snap) }, subagents: snap.roster.map(subagentView) };
  const plan = planView(snap, s);
  if (plan) detail.plan = plan;
  const reply = lastReply(snap);
  if (reply) detail.lastReply = reply;
  return detail;
}
```
(Fill the four interface bodies exactly as listed under **Interfaces**; the `/* … */` markers above are only to avoid repeating them here.)

`apps/daemon/src/mcp/agents.ts`:
```ts
import { proxyLaunchModels, type AgentAccountsResponse, type CliProxyStatus, type RegistryEntry, type RegistryResponse } from "@orquester/api";
import { agentChatRoutes, DEFAULT_RUNTIME_MODE, RUNTIME_MODES, type AgentAdapterId, type AgentProvidersResponse, type ModelSelection, type ProviderModel, type ProviderSnapshot, type RuntimeMode } from "@orquester/api/agent-chat";
import { proxyAccountFamily } from "../agent-chat/service.ts";
import type { DaemonApi } from "./daemon-api.ts";
import { ToolError } from "./errors.ts";

export const EFFORT_OPTION_IDS: Record<AgentAdapterId, string> = { claude: "effort", codex: "effort", opencode: "variant", grok: "reasoningEffort" };
export interface AgentModelOptionView { /* as in Interfaces */ }
export interface AgentModelView { /* … */ }
export interface AgentAccountView { /* … */ }
export interface AgentView { /* … */ }

export function isProxyAgent(refId: string): boolean {
  return proxyAccountFamily(refId) !== null;
}

function modelView(m: ProviderModel): AgentModelView {
  const v: AgentModelView = { slug: m.slug, name: m.name, isDefault: m.isDefault === true, options: [] };
  if (m.shortName) v.shortName = m.shortName;
  if (m.isLegacy) v.isLegacy = true;
  for (const d of m.capabilities?.optionDescriptors ?? []) {
    const o: AgentModelOptionView = { id: d.id, label: d.label, type: d.type };
    if (d.description) o.description = d.description;
    if (d.type === "select") o.values = d.options.map((c) => ({ id: c.id, label: c.label, ...(c.description ? { description: c.description } : {}), ...(c.isDefault ? { isDefault: true } : {}) }));
    v.options.push(o);
  }
  return v;
}

export async function loadAgents(api: DaemonApi, opts?: { includeLegacyModels?: boolean }): Promise<AgentView[]> {
  const registryRes = await api.request("GET", "/api/registry");
  if (registryRes.status >= 400) throw new ToolError("INTERNAL", "Could not read the agent registry.");
  const entries = ((registryRes.body as RegistryResponse).agents ?? []).filter((e): e is RegistryEntry & { chat: { adapter: AgentAdapterId } } => Boolean(e.chat?.adapter));
  const providersRes = await api.request("GET", agentChatRoutes.providers);
  const providers = new Map<string, ProviderSnapshot>();
  if (providersRes.status < 400) for (const p of (providersRes.body as AgentProvidersResponse).providers ?? []) providers.set(p.id, p);
  const accountsRes = await api.request("GET", "/api/agent-accounts");
  const accounts = accountsRes.status < 400 ? (accountsRes.body as AgentAccountsResponse) : { accounts: [], defaults: { claude: null, codex: null, grok: null } };
  const needsProxy = entries.some((e) => isProxyAgent(e.id));
  let proxy: CliProxyStatus | null = null;
  let catalog: string[] = [];
  if (needsProxy) {
    const statusRes = await api.request("GET", "/api/cliproxy");
    if (statusRes.status < 400) proxy = statusRes.body as CliProxyStatus;
    const catalogRes = await api.request("GET", "/api/cliproxy/models");
    if (catalogRes.status < 400) catalog = ((catalogRes.body as { models?: string[] }).models ?? []);
  }
  const seeded = new Set((proxy?.accounts ?? []).map((a) => a.id));
  return entries.map((entry) => {
    const adapter = entry.chat.adapter;
    const snapshot = providers.get(adapter);
    const family = (proxyAccountFamily(entry.id) ?? entry.id) as keyof AgentAccountsResponse["defaults"];
    const familyAccounts = accounts.accounts.filter((a) => a.agent === family).filter((a) => !isProxyAgent(entry.id) || seeded.has(a.id));
    const defaultAccountId = familyAccounts.some((a) => a.id === accounts.defaults[family]) ? (accounts.defaults[family] as string) : "system";
    let models: AgentModelView[];
    if (isProxyAgent(entry.id)) {
      models = proxyLaunchModels(proxy, catalog).map((m) => ({ slug: m.id, name: m.id, isDefault: m.id === proxy?.defaultModel, options: [], ...(m.providerLabel ? { providerLabel: m.providerLabel } : {}) }));
      if (models.length && !models.some((m) => m.isDefault)) models[0]!.isDefault = true;
    } else {
      models = (snapshot?.models ?? []).filter((m) => opts?.includeLegacyModels || !m.isLegacy).map(modelView);
    }
    const caps = snapshot?.capabilities;
    const view: AgentView = {
      id: entry.id, name: entry.name, adapter, enabled: entry.enabled, installed: snapshot?.installed ?? false, version: entry.version ?? snapshot?.version ?? null,
      status: snapshot?.status ?? "unknown", auth: snapshot ? { status: snapshot.auth.status, ...(snapshot.auth.label ? { label: snapshot.auth.label } : {}), ...(snapshot.auth.email ? { email: snapshot.auth.email } : {}) } : { status: "unknown" },
      models, effortOptionId: EFFORT_OPTION_IDS[adapter], runtimeModes: RUNTIME_MODES, defaultRuntimeMode: DEFAULT_RUNTIME_MODE,
      supports: { planMode: caps?.showPlanModeToggle ?? false, rollback: caps?.supportsConversationRollback ?? false, compaction: caps?.compaction !== undefined, backgroundTasks: caps?.supportsBackgroundTasks ?? false, contextWindow: caps?.reportsContextWindow ?? false },
      accounts: [{ id: "system", label: "System", email: null, plan: null, needsReauth: false, isDefault: false }, ...familyAccounts.map((a) => ({ id: a.id, label: a.label, email: a.email, plan: a.plan, needsReauth: a.needsReauth, isDefault: a.id === defaultAccountId }))],
      defaultAccountId
    };
    if (snapshot?.message) view.message = snapshot.message;
    return view;
  });
}

export function findAgent(agents: readonly AgentView[], refId: string): AgentView {
  const agent = agents.find((a) => a.id === refId);
  if (!agent) throw new ToolError("INVALID_ARGUMENT", `Unknown agent "${refId}". Valid agents: ${agents.map((a) => a.id).join(", ")}.`);
  return agent;
}

export interface ResolvedSelection { model: string; options: { id: string; value: string | boolean }[] }

export function resolveModelSelection(agent: AgentView, input: { model?: string; options?: Record<string, string | boolean>; current?: ModelSelection }): ResolvedSelection {
  const model = input.model ?? input.current?.model ?? agent.models.find((m) => m.isDefault)?.slug ?? agent.models[0]?.slug;
  if (!model) throw new ToolError("INVALID_ARGUMENT", `Still loading ${agent.id}'s models — retry in a moment (list_agents).`);
  const modelView = agent.models.find((m) => m.slug === model);
  if (agent.models.length && !modelView) {
    throw new ToolError("INVALID_ARGUMENT", `Unknown model "${model}" for ${agent.id}. Valid models: ${agent.models.slice(0, 40).map((m) => m.slug).join(", ")}${agent.models.length > 40 ? ", …" : ""}.`);
  }
  const descriptors = modelView?.options ?? [];
  const known = new Set(descriptors.map((d) => d.id));
  const merged = new Map<string, string | boolean>();
  for (const o of input.current?.options ?? []) {
    // Same model: everything survives. New model: only options it advertises.
    if (input.current?.model === model || known.has(o.id)) merged.set(o.id, o.value);
  }
  for (const [rawId, rawValue] of Object.entries(input.options ?? {})) {
    const id = rawId === "effort" && !known.has("effort") ? agent.effortOptionId : rawId;
    const d = descriptors.find((x) => x.id === id);
    if (descriptors.length && !d) throw new ToolError("INVALID_ARGUMENT", `Unknown option "${rawId}" for model ${model}. Valid options: ${descriptors.map((x) => x.id).join(", ")}.`);
    if (!d) { merged.set(id, rawValue); continue; }
    if (d.type === "boolean") {
      if (typeof rawValue !== "boolean") throw new ToolError("INVALID_ARGUMENT", `Option "${rawId}" takes a boolean.`);
      merged.set(id, rawValue);
    } else {
      const wanted = String(rawValue);
      const choice = d.values?.find((v) => v.id === wanted) ?? d.values?.find((v) => v.label.toLowerCase() === wanted.toLowerCase());
      if (!choice) throw new ToolError("INVALID_ARGUMENT", `Option "${rawId}" must be one of: ${(d.values ?? []).map((v) => v.id).join(", ")}.`);
      merged.set(id, choice.id);
    }
  }
  return { model, options: [...merged.entries()].map(([id, value]) => ({ id, value })) };
}

export function validateAccountId(agent: AgentView, accountId: string | undefined): string | undefined {
  if (accountId === undefined) return undefined;
  if (accountId === "system") return "system";
  if (agent.accounts.some((a) => a.id === accountId)) return accountId;
  const valid = agent.accounts.map((a) => a.id).join(", ");
  const hint = isProxyAgent(agent.id) ? ` (${agent.id} accepts only accounts seeded into the model proxy)` : "";
  throw new ToolError("INVALID_ARGUMENT", `Account "${accountId}" is not usable with ${agent.id}${hint}. Valid: ${valid}.`);
}
```
Note on the merge rule (spec §7.3 `update_session`): options from `current` survive only when the model is unchanged, or when the (new) model advertises them; `effort` maps to the adapter's real id unless the model literally advertises `effort`; with no descriptors (pending snapshot, proxy models) INPUT values pass through unchecked.

- [ ] **Step 4: Run the tests and typecheck**

Run from `apps/daemon`: `node --import tsx --test src/mcp/views.test.ts src/mcp/agents.test.ts` → PASS; `pnpm check` → clean.

---

### Task 4: Transcript and usage projections (`transcript.ts`, `usage-view.ts`)

Spec §7.6, §6.4, §7.8. Parallel with Tasks 3, 5, 6.

**Files:**
- Create: `apps/daemon/src/mcp/transcript.ts`, `transcript.test.ts`
- Create: `apps/daemon/src/mcp/usage-view.ts`, `usage-view.test.ts`

**Interfaces:**
- Consumes (Task 2): `capText`, fixtures.
- Produces:
  ```ts
  // transcript.ts
  export type TranscriptInclude = "reasoning" | "tools" | "activity";
  export interface TranscriptEntry { turn: number | null; turnId: string | null; kind: "user" | "assistant" | "reasoning" | "tool" | "approval" | "question" | "subagent" | "plan" | "changes" | "compaction" | "error" | "warning" | "info"; createdAt: string; agentId?: string; text?: string;
    attachments?: { name: string; type: string }[]; tool?: { type: string; title: string; status: string; command?: string; detail?: string; changedFiles?: string[] }; requestId?: string; requestKind?: string; decision?: string;
    questions?: string[]; answered?: boolean; subagent?: { id: string; title: string | null; status: string }; actionable?: boolean; files?: { path: string; additions: number; deletions: number }[]; state?: string; beforeTokens?: number; afterTokens?: number }
  export interface TranscriptOptions { turns: number; agentId?: string; include: ReadonlySet<TranscriptInclude>; maxChars: number }
  export interface TranscriptResult { entries: TranscriptEntry[]; turnCount: number; coveredTurns: [number, number] | null; truncated: boolean; subagents: { id: string; title: string | null; status: string }[] }
  export function transcriptEntries(snap: ThreadSnapshotPayload, opts: TranscriptOptions): TranscriptResult;
  // usage-view.ts
  export interface UsageWindowView { id: string; label: string; percentUsed: number; resetsAt?: string; resetsIn?: string }
  export interface UsageAccountView { id: string; label: string; plan?: string; available: boolean; stale: boolean; asOf?: string; ageMinutes?: number; needsReauth?: boolean; email?: string; windows: UsageWindowView[] }
  export interface UsageAgentView { id: string; name: string; available: boolean; stale: boolean; asOf?: string; ageMinutes?: number; plan?: string; windows?: UsageWindowView[]; accounts: UsageAccountView[]; system?: UsageAccountView; aggregate?: { strategy: string; accountCount: number; staleAccountCount?: number } }
  export function formatResetsIn(resetsAt: string | undefined, now: number): string | undefined;   // "2d 9h 14m" | "4h 44m" | "7m" | "now"
  export function usageView(res: UsageResponse, accounts: readonly AgentAccount[], now: number): { agents: UsageAgentView[] };
  ```

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/mcp/transcript.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { activity, message, snapshot, stamp, turn } from "./fixtures.ts";
import { transcriptEntries } from "./transcript.ts";

const ALL = new Set(["reasoning", "tools", "activity"] as const);

function twoTurns() {
  const items = [
      message("user", "hello", { turnId: "t1" }), message("reasoning", "thinking…", { turnId: "t1" }), message("assistant", "hi", { turnId: "t1" }),
      message("user", "edit it", { turnId: "t2", attachments: [{ type: "image", id: "a1", name: "shot.png", mimeType: "image/png", sizeBytes: 10 }] }),
      activity("tool.started", { itemType: "command_execution", toolUseId: "tu1", title: "Run pnpm check", command: "pnpm check", status: "inProgress" }, { turnId: "t2", tone: "tool" }),
      activity("tool.updated", { itemType: "command_execution", toolUseId: "tu1", detail: "…" }, { turnId: "t2", tone: "tool" }),
      activity("tool.completed", { itemType: "command_execution", toolUseId: "tu1", title: "Run pnpm check", status: "completed", detail: "ok\n", changedFiles: ["src/a.ts"] }, { turnId: "t2", tone: "tool" }),
      activity("task.started", { taskId: "task-1", title: "Explore", status: "running" }, { turnId: "t2" }),
      message("assistant", "sub says", { turnId: "t2", agentId: "task-1" }),
      activity("tool.started", { itemType: "command_execution", toolUseId: "tu-sub", title: "ls", status: "inProgress" }, { turnId: "t2", tone: "tool", agentId: "task-1" }),
      activity("task.completed", { taskId: "task-1", title: "Explore", status: "completed" }, { turnId: "t2" }),
      activity("approval.requested", { requestId: "r1", requestKind: "command", detail: "rm x" }, { turnId: "t2", tone: "approval" }),
      activity("approval.resolved", { requestId: "r1", decision: "accept" }, { turnId: "t2", tone: "approval" }),
      activity("user-input.requested", { requestId: "q1", questions: [{ id: "a", header: "A", question: "Pick?", options: [] }] }, { turnId: "t2" }),
      activity("turn.proposed.completed", { planId: "p1", planMarkdown: "# plan" }, { turnId: "t2" }),
      activity("context-compaction", { state: "compacted", beforeTokens: 100, afterTokens: 10 }, { turnId: "t2" }),
      activity("runtime.warning", { detail: "careful" }, { turnId: "t2", summary: "History not available" }),
      activity("provider.turn.start.failed", { detail: "Attachment rejected" }, { turnId: "t2", tone: "error", summary: "Turn failed" }),
      message("assistant", "done", { turnId: "t2" })
  ];
  // The fixture stamps are a module-wide counter, so anchor the checkpoint to the
  // error row's stamp: a stable sort then places "changes" after it and before "done".
  const changesAt = items[items.length - 2]!.createdAt;
  return snapshot({
    turns: [turn(), turn({ turnId: "t2", turnCount: 2, requestedAt: items[3]!.createdAt, startedAt: items[3]!.createdAt, completedAt: items[items.length - 1]!.createdAt })],
    checkpoints: [{ turnId: "t2", checkpointTurnCount: 2, checkpointRef: "refs/x", status: "ready", files: [{ path: "src/a.ts", additions: 3, deletions: 1 }], assistantMessageId: null, completedAt: changesAt }],
    items,
    roster: [{ id: "task-1", kind: "subagent", agentKind: "agent", title: "Explore", status: "completed" } as never]
  });
}

test("parent view: every kind, tools folded per toolUseId, subagent rows as anchors, ordered by time", () => {
  const r = transcriptEntries(twoTurns(), { turns: 5, include: ALL, maxChars: 100_000 });
  assert.equal(r.turnCount, 2); assert.deepEqual(r.coveredTurns, [1, 2]); assert.equal(r.truncated, false);
  assert.deepEqual(r.entries.map((e) => e.kind), ["user", "reasoning", "assistant", "user", "tool", "subagent", "approval", "question", "plan", "compaction", "warning", "error", "changes", "assistant"]);
  const tool = r.entries.find((e) => e.kind === "tool")!;
  assert.deepEqual(tool.tool, { type: "command_execution", title: "Run pnpm check", status: "completed", command: "pnpm check", detail: "ok\n", changedFiles: ["src/a.ts"] });
  assert.equal(tool.createdAt, r.entries[4].createdAt);
  assert.deepEqual(r.entries.find((e) => e.kind === "subagent")!.subagent, { id: "task-1", title: "Explore", status: "completed" });
  const approval = r.entries.find((e) => e.kind === "approval")!;
  assert.equal(approval.requestId, "r1"); assert.equal(approval.decision, "accept"); assert.equal(approval.requestKind, "command");
  const question = r.entries.find((e) => e.kind === "question")!;
  assert.deepEqual(question.questions, ["Pick?"]); assert.equal(question.answered, false);
  assert.deepEqual(r.entries.find((e) => e.kind === "changes")!.files, [{ path: "src/a.ts", additions: 3, deletions: 1 }]);
  assert.deepEqual(r.entries.find((e) => e.kind === "user" && e.turn === 2)!.attachments, [{ name: "shot.png", type: "image" }]);
  assert.equal(r.entries.find((e) => e.kind === "error")!.text, "Turn failed: Attachment rejected");
  assert.ok(!r.entries.some((e) => e.agentId), "subagent-owned rows stay out of the parent view");
  assert.deepEqual(r.subagents, [{ id: "task-1", title: "Explore", status: "completed" }]);
});

test("drill-in view shows only that agent's rows; reasoning and tools are opt-in", () => {
  const sub = transcriptEntries(twoTurns(), { turns: 5, agentId: "task-1", include: ALL, maxChars: 100_000 });
  assert.deepEqual(sub.entries.map((e) => [e.kind, e.agentId]), [["assistant", "task-1"], ["tool", "task-1"]]);
  assert.deepEqual(sub.subagents, []);
  const lean = transcriptEntries(twoTurns(), { turns: 5, include: new Set(), maxChars: 100_000 });
  assert.deepEqual(lean.entries.map((e) => e.kind), ["user", "assistant", "user", "subagent", "plan", "changes", "assistant"]);
});

test("turns selects the last N turns; shedding drops reasoning, then tool detail, then the oldest turn", () => {
  const last = transcriptEntries(twoTurns(), { turns: 1, include: ALL, maxChars: 100_000 });
  assert.deepEqual(last.coveredTurns, [2, 2]); assert.ok(last.entries.every((e) => e.turn === 2));
  const big = snapshot({ turns: [turn(), turn({ turnId: "t2", turnCount: 2, requestedAt: stamp(10), startedAt: stamp(10), completedAt: stamp(20) })],
    items: [message("user", "a".repeat(3000), { turnId: "t1" }), message("reasoning", "r".repeat(3000), { turnId: "t1" }), message("assistant", "b".repeat(3000), { turnId: "t1" }),
      activity("tool.completed", { itemType: "command_execution", toolUseId: "x", title: "t", status: "completed", detail: "d".repeat(3000) }, { turnId: "t2", tone: "tool" }), message("assistant", "c".repeat(3000), { turnId: "t2" })] });
  const shed1 = transcriptEntries(big, { turns: 5, include: ALL, maxChars: 12_000 });
  assert.equal(shed1.truncated, true); assert.ok(!shed1.entries.some((e) => e.kind === "reasoning"));
  assert.ok(shed1.entries.find((e) => e.kind === "tool")!.tool!.detail!.length <= 200);
  const shed2 = transcriptEntries(big, { turns: 5, include: ALL, maxChars: 4_000 });
  assert.deepEqual(shed2.coveredTurns, [2, 2]); assert.equal(shed2.truncated, true);
});
```

`apps/daemon/src/mcp/usage-view.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { UsageResponse } from "@orquester/api";
import { formatResetsIn, usageView } from "./usage-view.ts";

const now = Date.parse("2026-09-22T12:00:00.000Z");

test("formatResetsIn mirrors the top-bar countdown", () => {
  assert.equal(formatResetsIn("2026-09-22T16:44:30.000Z", now), "4h 44m");
  assert.equal(formatResetsIn("2026-09-24T21:14:00.000Z", now), "2d 9h 14m");
  assert.equal(formatResetsIn("2026-09-22T12:07:00.000Z", now), "7m");
  assert.equal(formatResetsIn("2026-09-22T12:00:30.000Z", now), "now");
  assert.equal(formatResetsIn(undefined, now), undefined);
  assert.equal(formatResetsIn("garbage", now), undefined);
});

test("usageView renders the widget row for row: accounts, system, scoped windows, plan, freshness, needsReauth", () => {
  const res: UsageResponse = { agents: [
    { id: "claude", available: true, stale: false, plan: "Max 20x", session: { percent: 7 }, weekly: { percent: 2 }, asOf: "2026-09-22T11:37:00.000Z",
      accounts: [{ id: "acc-1", label: "jasperclaude", available: true, stale: false, plan: "Max 20x", session: { percent: 7, resetsAt: "2026-09-22T16:44:00.000Z" }, weekly: { percent: 2, resetsAt: "2026-09-24T21:14:00.000Z" }, scopedWindows: [{ label: "Fable", percent: 3, resetsAt: "2026-09-24T21:14:00.000Z" }], asOf: "2026-09-22T11:37:00.000Z" }],
      system: { id: "system", label: "System", available: true, stale: true, session: null, weekly: null },
      aggregate: { strategy: "worst-account", accountCount: 1, staleAccountCount: 0 } },
    { id: "grok", available: true, stale: false, session: null, weekly: { percent: 0, resetsAt: "2026-09-26T13:35:00.000Z" }, plan: "SuperGrok", asOf: "2026-09-22T11:59:00.000Z" }
  ] };
  const accounts = [{ id: "acc-1", agent: "claude" as const, label: "jasperclaude", email: "j@x.io", plan: "max", needsReauth: true, createdAt: "", importedAt: "" }];
  const v = usageView(res, accounts, now);
  assert.equal(v.agents[0].name, "Claude Code"); assert.equal(v.agents[0].ageMinutes, 23); assert.equal(v.agents[0].plan, "Max 20x");
  const acc = v.agents[0].accounts[0];
  assert.equal(acc.label, "jasperclaude"); assert.equal(acc.needsReauth, true); assert.equal(acc.email, "j@x.io");
  assert.deepEqual(acc.windows, [
    { id: "session", label: "5h", percentUsed: 7, resetsAt: "2026-09-22T16:44:00.000Z", resetsIn: "4h 44m" },
    { id: "weekly", label: "Week", percentUsed: 2, resetsAt: "2026-09-24T21:14:00.000Z", resetsIn: "2d 9h 14m" },
    { id: "scoped:Fable", label: "Fable", percentUsed: 3, resetsAt: "2026-09-24T21:14:00.000Z", resetsIn: "2d 9h 14m" }
  ]);
  assert.deepEqual(v.agents[0].system, { id: "system", label: "System", available: true, stale: true, windows: [] });
  assert.deepEqual(v.agents[0].aggregate, { strategy: "worst-account", accountCount: 1, staleAccountCount: 0 });
  assert.equal(v.agents[0].windows, undefined);
  assert.equal(v.agents[1].name, "Grok Build"); assert.deepEqual(v.agents[1].accounts, []);
  assert.deepEqual(v.agents[1].windows, [{ id: "weekly", label: "Week", percentUsed: 0, resetsAt: "2026-09-26T13:35:00.000Z", resetsIn: "4d 1h 35m" }]);
});
```

- [ ] **Step 2: Run them to verify they fail** — `node --import tsx --test src/mcp/transcript.test.ts src/mcp/usage-view.test.ts` → FAIL.

- [ ] **Step 3: Write the implementations**

`apps/daemon/src/mcp/transcript.ts`:
```ts
import { startedTurns, type ThreadActivityItem, type ThreadItem, type ThreadSnapshotPayload } from "@orquester/api/agent-chat";
import { capText } from "./result.ts";

export type TranscriptInclude = "reasoning" | "tools" | "activity";
export interface TranscriptEntry { /* as in Interfaces */ }
export interface TranscriptOptions { turns: number; agentId?: string; include: ReadonlySet<TranscriptInclude>; maxChars: number }
export interface TranscriptResult { entries: TranscriptEntry[]; turnCount: number; coveredTurns: [number, number] | null; truncated: boolean; subagents: { id: string; title: string | null; status: string }[] }

const TOOL_KINDS = new Set(["tool.started", "tool.updated", "tool.completed", "tool.denied"]);
const SKIPPED_ACTIVITY = new Set(["tool.output", "tool.progress", "turn.proposed.delta", "turn.plan.updated", "hook.started", "hook.progress", "hook.completed", "context-window.updated", "checkpoint.captured", "background.requested", "task.progress", "task.updated"]);

type P = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export function transcriptEntries(snap: ThreadSnapshotPayload, opts: TranscriptOptions): TranscriptResult {
  // 1. Turn numbering: the ordinal among STARTED turns (turns.ts), the same number
  //    revert_session and get_turn_diff speak in; the highest is turnCount.
  const ordered = startedTurns(snap.turns);
  const turnIndex = new Map<string, number>();
  ordered.forEach((t, i) => turnIndex.set(t.turnId, i + 1));
  const turnCount = ordered.length;
  const wanted = Math.max(1, Math.floor(opts.turns));
  let from = Math.max(1, turnCount - wanted + 1);
  const build = (fromTurn: number): TranscriptEntry[] => {
    const selected = new Set(ordered.slice(fromTurn - 1).map((t) => t.turnId as string));
    const earliest = ordered[fromTurn - 1]?.requestedAt ?? "";
    const inScope = (item: ThreadItem): boolean => (opts.agentId ? item.agentId === opts.agentId : !item.agentId);
    const inTurns = (item: ThreadItem): boolean => (item.turnId ? selected.has(item.turnId) : item.createdAt >= earliest);
    const turnOf = (item: ThreadItem): number | null => (item.turnId ? turnIndex.get(item.turnId) ?? null : null);
    const entries: TranscriptEntry[] = [];
    const tools = new Map<string, TranscriptEntry>();
    const requests = new Map<string, TranscriptEntry>();
    const tasks = new Map<string, TranscriptEntry>();
    const base = (item: ThreadItem, kind: TranscriptEntry["kind"]): TranscriptEntry => ({ turn: turnOf(item), turnId: item.turnId, kind, createdAt: item.createdAt, ...(item.agentId ? { agentId: item.agentId } : {}) });
    for (const item of snap.items) {
      if (!inScope(item) || !inTurns(item)) continue;
      if (item.kind === "message") {
        if (item.role === "reasoning" && !opts.include.has("reasoning")) continue;
        const e = base(item, item.role === "user" ? "user" : item.role === "assistant" ? "assistant" : "reasoning");
        e.text = item.text;
        if (item.attachments?.length) e.attachments = item.attachments.map((a) => ({ name: a.name, type: a.type }));
        entries.push(e);
        continue;
      }
      const a = item as ThreadActivityItem;
      const p = (a.payload ?? {}) as P;
      if (SKIPPED_ACTIVITY.has(a.activityKind)) continue;
      if (TOOL_KINDS.has(a.activityKind)) {
        if (!opts.include.has("tools")) continue;
        const key = str(p.toolUseId) ?? a.id;
        let e = tools.get(key);
        if (!e) { e = base(a, "tool"); e.tool = { type: str(p.itemType) ?? "tool", title: str(p.title) ?? a.summary, status: str(p.status) ?? "inProgress" }; tools.set(key, e); entries.push(e); }
        const t = e.tool!;
        if (str(p.itemType)) t.type = str(p.itemType)!;
        if (str(p.title)) t.title = str(p.title)!;
        if (str(p.status)) t.status = str(p.status)!;
        if (a.activityKind === "tool.denied") t.status = "declined";
        if (str(p.command)) t.command = str(p.command);
        if (str(p.detail)) t.detail = str(p.detail);
        if (Array.isArray(p.changedFiles)) t.changedFiles = p.changedFiles.filter((f): f is string => typeof f === "string");
        continue;
      }
      if (a.activityKind.startsWith("task.")) {
        if (opts.agentId) continue; // anchors live in the parent view only
        const key = str(p.taskId) ?? a.id;
        let e = tasks.get(key);
        if (!e) { e = base(a, "subagent"); e.subagent = { id: key, title: str(p.title) ?? str(p.description) ?? null, status: str(p.status) ?? "running" }; tasks.set(key, e); entries.push(e); }
        if (str(p.title)) e.subagent!.title = str(p.title)!;
        if (a.activityKind === "task.completed") e.subagent!.status = str(p.status) ?? (p.stopped ? "interrupted" : "completed");
        continue;
      }
      if (a.activityKind === "approval.requested" || a.activityKind === "approval.resolved") {
        if (!opts.include.has("activity")) continue;
        const key = `a:${str(p.requestId) ?? a.id}`;
        let e = requests.get(key);
        if (!e) { e = base(a, "approval"); e.requestId = str(p.requestId) ?? a.id; requests.set(key, e); entries.push(e); }
        if (str(p.requestKind)) e.requestKind = str(p.requestKind);
        if (str(p.detail)) e.text = capText(str(p.detail)!, 2000).text;
        if (a.activityKind === "approval.resolved") e.decision = str(p.decision) ?? "resolved";
        continue;
      }
      if (a.activityKind === "user-input.requested" || a.activityKind === "user-input.resolved") {
        if (!opts.include.has("activity")) continue;
        const key = `q:${str(p.requestId) ?? a.id}`;
        let e = requests.get(key);
        if (!e) { e = base(a, "question"); e.requestId = str(p.requestId) ?? a.id; e.answered = false; requests.set(key, e); entries.push(e); }
        if (Array.isArray(p.questions)) e.questions = (p.questions as P[]).map((q) => str(q.question) ?? str(q.header) ?? "").filter(Boolean);
        if (a.activityKind === "user-input.resolved") e.answered = true;
        continue;
      }
      if (a.activityKind === "turn.proposed.completed") {
        const e = base(a, "plan"); e.text = str(p.planMarkdown) ?? ""; entries.push(e); continue;
      }
      if (a.activityKind === "context-compaction") {
        if (!opts.include.has("activity")) continue;
        const e = base(a, "compaction"); e.state = str(p.state) ?? "compacting";
        if (typeof p.beforeTokens === "number") e.beforeTokens = p.beforeTokens;
        if (typeof p.afterTokens === "number") e.afterTokens = p.afterTokens;
        entries.push(e); continue;
      }
      if (!opts.include.has("activity")) continue;
      if (a.tone === "error") { const e = base(a, "error"); e.text = str(p.detail) ? `${a.summary}: ${str(p.detail)}` : a.summary; entries.push(e); continue; }
      if (a.activityKind === "runtime.warning") { const e = base(a, "warning"); e.text = str(p.detail) ? `${a.summary}: ${str(p.detail)}` : a.summary; entries.push(e); continue; }
      if (a.activityKind === "session.identity-changed" || a.activityKind === "model.rerouted") { const e = base(a, "info"); e.text = a.summary; entries.push(e); }
    }
    // Per-turn file changes from the checkpoints (§7.6 "changes").
    if (!opts.agentId) {
      for (const cp of snap.checkpoints) {
        if (!cp.turnId || !selected.has(cp.turnId) || !cp.files.length) continue;
        entries.push({ turn: turnIndex.get(cp.turnId) ?? null, turnId: cp.turnId, kind: "changes", createdAt: cp.completedAt, files: cp.files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })) });
      }
    }
    entries.sort((x, y) => (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : 0));
    return entries;
  };
  const size = (list: TranscriptEntry[]): number => JSON.stringify(list).length;
  let entries = turnCount ? build(from) : [];
  let truncated = false;
  // Shedding order (§7.6): reasoning → tool detail → oldest turns.
  if (size(entries) > opts.maxChars) { truncated = true; entries = entries.filter((e) => e.kind !== "reasoning"); }
  if (size(entries) > opts.maxChars) { for (const e of entries) if (e.tool?.detail && e.tool.detail.length > 200) e.tool.detail = `${e.tool.detail.slice(0, 200)}…`; }
  while (size(entries) > opts.maxChars && from < turnCount) {
    from += 1;
    entries = build(from).filter((e) => e.kind !== "reasoning");
    for (const e of entries) if (e.tool?.detail && e.tool.detail.length > 200) e.tool.detail = `${e.tool.detail.slice(0, 200)}…`;
  }
  const subagents = opts.agentId ? [] : snap.roster.map((r) => ({ id: r.id, title: r.title ?? null, status: r.status }));
  return { entries, turnCount, coveredTurns: turnCount ? [from, turnCount] : null, truncated, subagents };
}
```

`apps/daemon/src/mcp/usage-view.ts`:
```ts
import type { AgentAccount, AgentUsage, UsageAccount, UsageResponse, UsageWindow } from "@orquester/api";

export interface UsageWindowView { id: string; label: string; percentUsed: number; resetsAt?: string; resetsIn?: string }
export interface UsageAccountView { id: string; label: string; plan?: string; available: boolean; stale: boolean; asOf?: string; ageMinutes?: number; needsReauth?: boolean; email?: string; windows: UsageWindowView[] }
export interface UsageAgentView { id: string; name: string; available: boolean; stale: boolean; asOf?: string; ageMinutes?: number; plan?: string; windows?: UsageWindowView[]; accounts: UsageAccountView[]; system?: UsageAccountView; aggregate?: { strategy: string; accountCount: number; staleAccountCount?: number } }

const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", grok: "Grok Build" };

/** The top-bar countdown (`formatCountdown` in the UI) without the "Resets in" prefix. */
export function formatResetsIn(resetsAt: string | undefined, now: number): string | undefined {
  if (!resetsAt) return undefined;
  const ms = Date.parse(resetsAt) - now;
  if (Number.isNaN(ms)) return undefined;
  if (ms <= 60_000) return "now";
  const mins = Math.floor(ms / 60_000);
  const d = Math.floor(mins / 1_440);
  const h = Math.floor((mins % 1_440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function ageMinutes(asOf: string | undefined, now: number): number | undefined {
  if (!asOf) return undefined;
  const t = Date.parse(asOf);
  return Number.isNaN(t) ? undefined : Math.max(0, Math.round((now - t) / 60_000));
}

function window(id: string, label: string, w: UsageWindow | null | undefined, now: number): UsageWindowView | null {
  if (!w) return null;
  const v: UsageWindowView = { id, label, percentUsed: Math.round(w.percent) };
  if (w.resetsAt) { v.resetsAt = w.resetsAt; const rel = formatResetsIn(w.resetsAt, now); if (rel) v.resetsIn = rel; }
  return v;
}

function windows(row: Pick<AgentUsage, "session" | "weekly" | "scopedWindows">, now: number): UsageWindowView[] {
  const out: UsageWindowView[] = [];
  const s = window("session", "5h", row.session, now); if (s) out.push(s);
  const w = window("weekly", "Week", row.weekly, now); if (w) out.push(w);
  for (const sw of row.scopedWindows ?? []) { const v = window(`scoped:${sw.label}`, sw.label, sw, now); if (v) out.push(v); }
  return out;
}

function accountRow(row: UsageAccount, managed: AgentAccount | undefined, now: number): UsageAccountView {
  const v: UsageAccountView = { id: row.id, label: row.label ?? managed?.label ?? row.id, available: row.available, stale: row.stale, windows: windows(row, now) };
  if (row.plan) v.plan = row.plan;
  if (row.asOf) { v.asOf = row.asOf; const age = ageMinutes(row.asOf, now); if (age !== undefined) v.ageMinutes = age; }
  if (managed) { v.needsReauth = managed.needsReauth; if (managed.email) v.email = managed.email; }
  return v;
}

export function usageView(res: UsageResponse, accounts: readonly AgentAccount[], now: number): { agents: UsageAgentView[] } {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return {
    agents: res.agents.map((agent) => {
      const v: UsageAgentView = { id: agent.id, name: AGENT_NAMES[agent.id] ?? agent.id, available: agent.available, stale: agent.stale, accounts: (agent.accounts ?? []).map((row) => accountRow(row, byId.get(row.id), now)) };
      if (agent.asOf) { v.asOf = agent.asOf; const age = ageMinutes(agent.asOf, now); if (age !== undefined) v.ageMinutes = age; }
      if (agent.plan) v.plan = agent.plan;
      if (agent.system) v.system = accountRow(agent.system, undefined, now);
      if (agent.aggregate) v.aggregate = { strategy: agent.aggregate.strategy, accountCount: agent.aggregate.accountCount, ...(agent.aggregate.staleAccountCount !== undefined ? { staleAccountCount: agent.aggregate.staleAccountCount } : {}) };
      if (!v.accounts.length && !v.system) v.windows = windows(agent, now);
      return v;
    })
  };
}
```

- [ ] **Step 4: Run the tests and typecheck** — `node --import tsx --test src/mcp/transcript.test.ts src/mcp/usage-view.test.ts` → PASS; `pnpm check` → clean.

---

### Task 5: The wait engine (`wait.ts`)

Spec §4.3, §9. Parallel with Tasks 3, 4, 6.

**Files:**
- Create: `apps/daemon/src/mcp/wait.ts`, `wait.test.ts`

**Interfaces:**
- Consumes (Task 2): `DaemonApi`, `listSessions`, `ToolError`, fixtures/testing.
- Produces:
  ```ts
  export interface WatchState { sessions: ReadonlyMap<string, SessionSummary>; closed: ReadonlySet<string> }
  export interface WatchOptions<T> { api: DaemonApi; select: (s: SessionSummary) => boolean; evaluate: (state: WatchState) => T | null; timeoutMs: number; signal: AbortSignal; now: () => number; settleMs?: number; rereadMs?: number }
  export async function watchSessions<T>(opts: WatchOptions<T>): Promise<T | null>;      // null = timed out (or aborted)
  export interface TurnBaseline { turnId: string | null; completedAt: string | null; running: boolean }
  export function turnBaseline(s: SessionSummary): TurnBaseline;
  export type TurnOutcome = "completed" | "needs-input" | "plan-ready" | "interrupted" | "failed" | "timeout";
  export async function waitForTurn(api: DaemonApi, sessionId: string, baseline: TurnBaseline, opts: { timeoutMs: number; signal: AbortSignal; now: () => number }): Promise<{ outcome: TurnOutcome; summary: SessionSummary | null }>;   // throws SESSION_NOT_FOUND when closed
  export function attentionQualifies(s: SessionSummary, after: string): boolean;
  export async function waitForAttention(api: DaemonApi, opts: { select: (s: SessionSummary) => boolean; after: string; timeoutMs: number; signal: AbortSignal; now: () => number; settleMs?: number }): Promise<{ sessions: SessionSummary[]; cursor: string; timedOut: boolean }>;
  ```

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/mcp/wait.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { busEvent, FakeDaemonApi } from "./testing.ts";
import { chatSummary, shellSummary, stamp } from "./fixtures.ts";
import { attentionQualifies, turnBaseline, waitForAttention, waitForTurn, watchSessions } from "./wait.ts";

const now = () => Date.now();
const running = (over = {}) => chatSummary({ chatSessionStatus: "running", activity: { state: "working", attention: null, lastOutputAt: null, needsAttentionAt: null }, latestTurn: { turnId: "t2", state: "running", startedAt: stamp(2), completedAt: null }, ...over });
const done = (over = {}) => chatSummary({ latestTurn: { turnId: "t2", state: "completed", startedAt: stamp(2), completedAt: stamp(3) }, activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(3) }, ...over });

test("watchSessions subscribes BEFORE the first read, evaluates on events, and unsubscribes", async () => {
  const api = new FakeDaemonApi();
  api.on("GET", "/api/sessions", () => { assert.equal(api.listenerCount(), 1, "subscribed before reading"); return { status: 200, body: [running()] }; });
  const p = watchSessions({ api, select: (s) => s.id === "c1", evaluate: (st) => (st.sessions.get("c1")?.chatSessionStatus === "ready" ? "ready" : null), timeoutMs: 5_000, signal: new AbortController().signal, now, settleMs: 0 });
  await new Promise((r) => setImmediate(r));
  api.emit(busEvent("session.updated", done()));
  assert.equal(await p, "ready");
  assert.equal(api.listenerCount(), 0);
});

test("watchSessions merges session.activity into the summary and drops closed sessions", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [running()] });
  const seen: string[] = [];
  const p = watchSessions({ api, select: () => true, evaluate: (st) => { seen.push(`${st.sessions.get("c1")?.activity?.state ?? "-"}/${st.closed.has("c1")}`); return st.closed.has("c1") ? "closed" : null; }, timeoutMs: 5_000, signal: new AbortController().signal, now, settleMs: 0 });
  await new Promise((r) => setImmediate(r));
  api.emit(busEvent("session.activity", { id: "c1", activity: { state: "waiting", attention: "needs-input", lastOutputAt: null, needsAttentionAt: stamp(9) } }));
  api.emit(busEvent("session.closed", { id: "c1" }));
  assert.equal(await p, "closed");
  assert.ok(seen.includes("waiting/false"));
});

test("watchSessions times out with null and honours abort", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [] });
  assert.equal(await watchSessions({ api, select: () => true, evaluate: () => null, timeoutMs: 20, signal: new AbortController().signal, now, settleMs: 0 }), null);
  const ac = new AbortController();
  const p = watchSessions({ api, select: () => true, evaluate: () => null, timeoutMs: 5_000, signal: ac.signal, now, settleMs: 0 });
  ac.abort();
  assert.equal(await p, null);
  assert.equal(api.listenerCount(), 0);
});

test("waitForTurn: a new turn completing after the baseline, a pending question, a plan, an error, and a steer", async () => {
  const idle = chatSummary();
  const base = turnBaseline(idle);
  assert.deepEqual(base, { turnId: "t1", completedAt: stamp(1), running: false });
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [idle] });
  const p = waitForTurn(api, "c1", base, { timeoutMs: 5_000, signal: new AbortController().signal, now });
  await new Promise((r) => setImmediate(r));
  api.emit(busEvent("session.updated", chatSummary({ latestTurn: { turnId: null, state: "pending", startedAt: null, completedAt: null } })));
  api.emit(busEvent("session.updated", running()));
  api.emit(busEvent("session.updated", done()));
  assert.equal((await p).outcome, "completed");
  const q = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [running({ hasPendingUserInput: true })] });
  assert.equal((await waitForTurn(q, "c1", base, { timeoutMs: 5_000, signal: new AbortController().signal, now })).outcome, "needs-input");
  const plan = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [done({ hasActionableProposedPlan: true })] });
  assert.equal((await waitForTurn(plan, "c1", base, { timeoutMs: 5_000, signal: new AbortController().signal, now })).outcome, "plan-ready");
  const err = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [chatSummary({ chatSessionStatus: "error" })] });
  assert.equal((await waitForTurn(err, "c1", base, { timeoutMs: 5_000, signal: new AbortController().signal, now })).outcome, "failed");
  const steerBase = turnBaseline(running());
  assert.deepEqual(steerBase, { turnId: "t2", completedAt: null, running: true });
  const steer = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [running()] });
  const sp = waitForTurn(steer, "c1", steerBase, { timeoutMs: 5_000, signal: new AbortController().signal, now });
  await new Promise((r) => setImmediate(r));
  steer.emit(busEvent("session.updated", done({ latestTurn: { turnId: "t2", state: "interrupted", startedAt: stamp(2), completedAt: stamp(4) } })));
  assert.equal((await sp).outcome, "interrupted");
});

test("waitForTurn: the baseline turn itself never counts, a timeout reports timeout, a closed session throws", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [chatSummary()] });
  const r = await waitForTurn(api, "c1", turnBaseline(chatSummary()), { timeoutMs: 20, signal: new AbortController().signal, now });
  assert.equal(r.outcome, "timeout");
  const gone = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [chatSummary()] });
  const p = waitForTurn(gone, "c1", turnBaseline(chatSummary()), { timeoutMs: 5_000, signal: new AbortController().signal, now });
  await new Promise((r) => setImmediate(r));
  gone.emit(busEvent("session.closed", { id: "c1" }));
  await assert.rejects(p, (e: { code: string }) => e.code === "SESSION_NOT_FOUND");
});

test("attentionQualifies and waitForAttention: cursor semantics, immediate return, settle window collects siblings, timeout", async () => {
  assert.equal(attentionQualifies(done(), stamp(2)), true);
  assert.equal(attentionQualifies(done(), stamp(3)), false, "equal stamps do not qualify");
  assert.equal(attentionQualifies(running(), stamp(0)), false);
  assert.equal(attentionQualifies(shellSummary({ activity: { state: "idle", attention: "bell", lastOutputAt: null, needsAttentionAt: stamp(5) } }), stamp(4)), true);
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [done()] });
  const immediate = await waitForAttention(api, { select: () => true, after: stamp(0), timeoutMs: 5_000, signal: new AbortController().signal, now, settleMs: 0 });
  assert.deepEqual(immediate.sessions.map((s) => s.id), ["c1"]); assert.equal(immediate.cursor, stamp(3)); assert.equal(immediate.timedOut, false);
  const again = await waitForAttention(api, { select: () => true, after: immediate.cursor, timeoutMs: 20, signal: new AbortController().signal, now, settleMs: 0 });
  assert.deepEqual(again, { sessions: [], cursor: stamp(3), timedOut: true });
  let reads = 0;
  const two = new FakeDaemonApi().on("GET", "/api/sessions", () => (++reads === 1
    ? { status: 200, body: [running(), running({ id: "c2" })] }
    : { status: 200, body: [done({ activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(7) } }), done({ id: "c2", activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(7) } })] }));
  const p = waitForAttention(two, { select: (s) => s.kind === "agent-chat", after: stamp(3), timeoutMs: 5_000, signal: new AbortController().signal, now, settleMs: 30 });
  await new Promise((r) => setImmediate(r));
  two.emit(busEvent("session.activity", { id: "c1", activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(7) } }));
  const r = await p;
  assert.deepEqual(r.sessions.map((s) => s.id).sort(), ["c1", "c2"], "the settle window re-read picked up the sibling");
  assert.equal(r.cursor, stamp(7));
});
```
- [ ] **Step 2: Run to verify failure** — `node --import tsx --test src/mcp/wait.test.ts` → FAIL.

- [ ] **Step 3: Write the implementation**

`apps/daemon/src/mcp/wait.ts`:
```ts
import type { SessionSummary } from "@orquester/api";
import { resolveChatActivity } from "../agent-chat/activity-ladder.ts";
import type { DaemonApi } from "./daemon-api.ts";
import { ToolError } from "./errors.ts";
import { listSessions } from "./reads.ts";

export interface WatchState { sessions: ReadonlyMap<string, SessionSummary>; closed: ReadonlySet<string> }
export interface WatchOptions<T> { api: DaemonApi; select: (s: SessionSummary) => boolean; evaluate: (state: WatchState) => T | null; timeoutMs: number; signal: AbortSignal; now: () => number; settleMs?: number; rereadMs?: number }

const DEFAULT_SETTLE_MS = 300;
const DEFAULT_REREAD_MS = 10_000;
const SETTLED = new Set(["completed", "failed", "interrupted", "cancelled"]);

/**
 * Watch the daemon bus for the selected sessions and resolve the first non-null
 * evaluation (spec §4.3, §9). Subscribes BEFORE the initial read so nothing
 * published during the read is lost; re-reads the list every `rereadMs` as a
 * safety net; on a hit waits `settleMs` and re-reads so siblings stamped in the
 * same host poll are seen together. Resolves null on timeout or abort.
 */
export async function watchSessions<T>(opts: WatchOptions<T>): Promise<T | null> {
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const rereadMs = opts.rereadMs ?? DEFAULT_REREAD_MS;
  const sessions = new Map<string, SessionSummary>();
  const closed = new Set<string>();
  let wake: (() => void) | null = null;
  const notify = () => { const w = wake; wake = null; w?.(); };
  const off = opts.api.subscribe((event) => {
    if (event.channel !== "sessions") return;
    const payload = event.payload as { id?: string };
    if (event.type === "session.created" || event.type === "session.updated") {
      const s = event.payload as SessionSummary;
      if (opts.select(s)) sessions.set(s.id, s); else sessions.delete(s.id);
    } else if (event.type === "session.activity") {
      const cur = payload.id ? sessions.get(payload.id) : undefined;
      if (cur) sessions.set(cur.id, { ...cur, activity: (event.payload as { activity: SessionSummary["activity"] }).activity });
    } else if (event.type === "session.closed") {
      if (payload.id) { sessions.delete(payload.id); closed.add(payload.id); }
    } else return;
    notify();
  });
  const reload = async () => {
    const list = await listSessions(opts.api);
    sessions.clear();
    for (const s of list) if (opts.select(s)) sessions.set(s.id, s);
  };
  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(() => { opts.signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); resolve(); };
    opts.signal.addEventListener("abort", onAbort, { once: true });
  });
  const deadline = opts.now() + opts.timeoutMs;
  try {
    await reload();
    for (;;) {
      if (opts.signal.aborted) return null;
      const hit = opts.evaluate({ sessions, closed });
      if (hit !== null) {
        if (settleMs > 0 && opts.now() + settleMs < deadline) {
          await sleep(settleMs);
          await reload();
          const settled = opts.evaluate({ sessions, closed });
          if (settled !== null) return settled;
          continue;
        }
        return hit;
      }
      const remaining = deadline - opts.now();
      if (remaining <= 0) return null;
      const slice = Math.min(remaining, rereadMs);
      let timer: NodeJS.Timeout | undefined;
      let rereadDue = false;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(() => { rereadDue = true; notify(); }, slice);
        opts.signal.addEventListener("abort", notify, { once: true });
      });
      if (timer) clearTimeout(timer);
      opts.signal.removeEventListener("abort", notify);
      if (rereadDue && !opts.signal.aborted) await reload();
    }
  } finally {
    off();
  }
}

export interface TurnBaseline { turnId: string | null; completedAt: string | null; running: boolean }
export function turnBaseline(s: SessionSummary): TurnBaseline {
  const lt = s.latestTurn ?? null;
  const running = s.chatSessionStatus === "running" || s.chatSessionStatus === "starting" || lt?.state === "running" || lt?.state === "pending";
  return { turnId: lt?.turnId ?? null, completedAt: lt?.completedAt ?? null, running };
}

export type TurnOutcome = "completed" | "needs-input" | "plan-ready" | "interrupted" | "failed" | "timeout";

function turnOutcome(s: SessionSummary, baseline: TurnBaseline): TurnOutcome | null {
  if (s.hasPendingApprovals || s.hasPendingUserInput) return "needs-input";
  if (resolveChatActivity(s).rung === "plan-ready") return "plan-ready";
  if (s.chatSessionStatus === "error") return "failed";
  const lt = s.latestTurn;
  if (!lt || !SETTLED.has(lt.state)) return null;
  const isNew = lt.turnId !== baseline.turnId || (baseline.running && lt.completedAt !== baseline.completedAt);
  if (!isNew) return null;
  if (lt.state === "completed") return "completed";
  if (lt.state === "failed") return "failed";
  return "interrupted";
}

export async function waitForTurn(api: DaemonApi, sessionId: string, baseline: TurnBaseline, opts: { timeoutMs: number; signal: AbortSignal; now: () => number }): Promise<{ outcome: TurnOutcome; summary: SessionSummary | null }> {
  let last: SessionSummary | null = null;
  const hit = await watchSessions<{ outcome: TurnOutcome; summary: SessionSummary }>({
    api, select: (s) => s.id === sessionId, timeoutMs: opts.timeoutMs, signal: opts.signal, now: opts.now, settleMs: 0,
    evaluate: (state) => {
      if (state.closed.has(sessionId)) throw new ToolError("SESSION_NOT_FOUND", `Session "${sessionId}" was closed while waiting.`);
      const s = state.sessions.get(sessionId);
      if (!s) return null;
      last = s;
      const outcome = turnOutcome(s, baseline);
      return outcome ? { outcome, summary: s } : null;
    }
  });
  return hit ?? { outcome: "timeout", summary: last };
}

export function attentionQualifies(s: SessionSummary, after: string): boolean {
  const a = s.activity;
  return Boolean(a && a.attention !== null && a.needsAttentionAt && a.needsAttentionAt > after);
}

export async function waitForAttention(api: DaemonApi, opts: { select: (s: SessionSummary) => boolean; after: string; timeoutMs: number; signal: AbortSignal; now: () => number; settleMs?: number }): Promise<{ sessions: SessionSummary[]; cursor: string; timedOut: boolean }> {
  const hit = await watchSessions<SessionSummary[]>({
    api, select: opts.select, timeoutMs: opts.timeoutMs, signal: opts.signal, now: opts.now, settleMs: opts.settleMs,
    evaluate: (state) => { const q = [...state.sessions.values()].filter((s) => attentionQualifies(s, opts.after)); return q.length ? q : null; }
  });
  if (!hit) return { sessions: [], cursor: opts.after, timedOut: true };
  const cursor = hit.reduce((max, s) => (s.activity?.needsAttentionAt && s.activity.needsAttentionAt > max ? s.activity.needsAttentionAt : max), opts.after);
  return { sessions: hit, cursor, timedOut: false };
}
```
Note `evaluate` may throw (the closed-session case); `watchSessions` lets it propagate through its `finally`, which still unsubscribes.

- [ ] **Step 4: Run the tests and typecheck** — `node --import tsx --test src/mcp/wait.test.ts` → PASS; `pnpm check` → clean.

---

### Task 6: Inline attachments (`attachments.ts`)

Spec §8.1–§8.3. Parallel with Tasks 3, 4, 5.

**Files:**
- Create: `apps/daemon/src/mcp/attachments.ts`, `attachments.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const attachmentInputSchema: z.ZodType<AttachmentInput>;   // { path } | { name, base64, mimeType? }
  export type AttachmentInput = { path: string } | { name: string; base64: string; mimeType?: string };
  export const MAX_ATTACHMENTS = 8;
  export function guessMime(name: string): string | undefined;
  export async function uploadInlineAttachments(api: DaemonApi, sessionId: string, inputs: readonly AttachmentInput[], opts?: { max?: number }): Promise<AttachmentRef[]>;
  ```

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/mcp/attachments.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDaemonApi } from "./testing.ts";
import { attachmentInputSchema, guessMime, uploadInlineAttachments } from "./attachments.ts";

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "mcp-att-"));
  const ws = join(root, "workspaces"); await mkdir(join(ws, "acme", "api"), { recursive: true });
  await writeFile(join(ws, "acme", "api", "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(root, "secret.txt"), "nope"); await symlink(join(root, "secret.txt"), join(ws, "acme", "api", "link.txt"));
  const api = new FakeDaemonApi(); api.fsRoot = ws; api.workspacesDir = ws;
  return { root, ws, api };
}

test("schema accepts the two shapes and rejects mixed or empty ones", () => {
  assert.ok(attachmentInputSchema.safeParse({ path: "/x/y.png" }).success);
  assert.ok(attachmentInputSchema.safeParse({ name: "a.txt", base64: "YQ==" }).success);
  assert.ok(!attachmentInputSchema.safeParse({ name: "a.txt" }).success);
  assert.ok(!attachmentInputSchema.safeParse({ path: "/x", base64: "YQ==" }).success);
});

test("guessMime by extension", () => {
  assert.equal(guessMime("a.PNG"), "image/png"); assert.equal(guessMime("b.jpg"), "image/jpeg"); assert.equal(guessMime("c.pdf"), "application/pdf"); assert.equal(guessMime("d"), undefined);
});

test("uploads a sandbox file and an inline base64 file with the right meta, returning the host's refs in order", async (t) => {
  const s = await sandbox(); t.after(() => rm(s.root, { recursive: true, force: true }));
  const refs = await uploadInlineAttachments(s.api, "c1", [{ path: join(s.ws, "acme", "api", "shot.png") }, { name: "notes.txt", base64: Buffer.from("hello").toString("base64") }]);
  assert.equal(refs.length, 2);
  assert.deepEqual(s.api.uploads.map((u) => [u.sessionId, u.meta, u.bytes.toString("latin1").length]), [["c1", { name: "shot.png", type: "image/png" }, 4], ["c1", { name: "notes.txt", type: "text/plain" }, 5]]);
  assert.equal(refs[0].type, "image"); assert.equal(refs[1].type, "file"); assert.equal(refs[1].name, "notes.txt");
});

test("refuses more than 8, a path outside the sandbox (incl. a symlink escape), a missing file, bad base64, and oversize", async (t) => {
  const s = await sandbox(); t.after(() => rm(s.root, { recursive: true, force: true }));
  const nine = Array.from({ length: 9 }, () => ({ name: "a.txt", base64: "YQ==" }));
  await assert.rejects(uploadInlineAttachments(s.api, "c1", nine), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  await assert.rejects(uploadInlineAttachments(s.api, "c1", [{ path: join(s.root, "secret.txt") }]), (e: { code: string }) => e.code === "PATH_NOT_ALLOWED");
  await assert.rejects(uploadInlineAttachments(s.api, "c1", [{ path: join(s.ws, "acme", "api", "link.txt") }]), (e: { code: string }) => e.code === "PATH_NOT_ALLOWED");
  await assert.rejects(uploadInlineAttachments(s.api, "c1", [{ path: join(s.ws, "acme", "api", "missing.txt") }]), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  await assert.rejects(uploadInlineAttachments(s.api, "c1", [{ name: "x.txt", base64: "not base64!!" }]), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  const bigImage = { name: "big.png", base64: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64") };
  await assert.rejects(uploadInlineAttachments(s.api, "c1", [bigImage]), (e: { message: string }) => /10 MiB/.test(e.message));
  assert.equal(s.api.uploads.length, 0, "nothing is uploaded when validation fails");
});

test("a host refusal becomes the daemon's error", async (t) => {
  const s = await sandbox(); t.after(() => rm(s.root, { recursive: true, force: true }));
  s.api.onUpload(() => ({ status: 400, value: { error: { code: "INVALID_COMMAND", message: "Attachment exceeds the 50 MiB limit." } } }));
  await assert.rejects(uploadInlineAttachments(s.api, "c1", [{ name: "a.txt", base64: "YQ==" }]), (e: { code: string }) => e.code === "INVALID_COMMAND");
});
```

- [ ] **Step 2: Run to verify failure** — `node --import tsx --test src/mcp/attachments.test.ts` → FAIL.

- [ ] **Step 3: Write the implementation**

`apps/daemon/src/mcp/attachments.ts`:
```ts
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { MAX_TURN_ATTACHMENTS, MAX_TURN_FILE_BYTES, MAX_TURN_IMAGE_BYTES, SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES, type AttachmentRef } from "@orquester/api/agent-chat";
import { assertInsideFsRoot, FsSandboxError } from "@orquester/config/fs";
import type { DaemonApi } from "./daemon-api.ts";
import { ToolError, daemonError } from "./errors.ts";

export const MAX_ATTACHMENTS = MAX_TURN_ATTACHMENTS;

export const attachmentInputSchema = z.union([
  z.object({ path: z.string().min(1).describe("Absolute path of a file inside the workspaces sandbox.") }).strict(),
  z.object({
    name: z.string().min(1).describe("File name; the extension decides the type unless mimeType is given."),
    base64: z.string().min(1).describe("The file bytes, base64-encoded."),
    mimeType: z.string().optional().describe("MIME type override.")
  }).strict()
]);
export type AttachmentInput = z.infer<typeof attachmentInputSchema>;

const MIME_BY_EXT: Record<string, string> = { gif: "image/gif", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html", xml: "application/xml", js: "text/javascript", ts: "text/typescript", py: "text/x-python", log: "text/plain" };
const IMAGE_EXTS = new Set(["gif", "jpg", "jpeg", "png", "webp"]);

export function guessMime(name: string): string | undefined {
  return MIME_BY_EXT[extname(name).slice(1).toLowerCase()];
}

interface Prepared { name: string; type: string | undefined; bytes: Buffer }

async function prepare(api: DaemonApi, input: AttachmentInput, index: number): Promise<Prepared> {
  if ("path" in input) {
    let real: string;
    try { real = await assertInsideFsRoot(api.fsRoot, input.path); } catch (error) {
      if (error instanceof FsSandboxError) throw new ToolError("PATH_NOT_ALLOWED", `attachments[${index}]: path is not allowed (outside the sandbox).`);
      throw new ToolError("INVALID_ARGUMENT", `attachments[${index}]: file not found.`);
    }
    let size: number;
    try { const st = await stat(real); if (!st.isFile()) throw new Error("not a file"); size = st.size; } catch { throw new ToolError("INVALID_ARGUMENT", `attachments[${index}]: file not found or not a regular file.`); }
    const name = basename(input.path);
    checkSize(name, undefined, size, index);
    return { name, type: guessMime(name), bytes: await readFile(real) };
  }
  const clean = input.base64.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) throw new ToolError("INVALID_ARGUMENT", `attachments[${index}]: base64 is malformed.`);
  const bytes = Buffer.from(clean, "base64");
  const type = input.mimeType?.toLowerCase() ?? guessMime(input.name);
  checkSize(input.name, type, bytes.length, index);
  return { name: input.name, type, bytes };
}

function checkSize(name: string, type: string | undefined, size: number, index: number): void {
  const isImage = (type !== undefined && (SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES as readonly string[]).includes(type)) || IMAGE_EXTS.has(extname(name).slice(1).toLowerCase());
  const cap = isImage ? MAX_TURN_IMAGE_BYTES : MAX_TURN_FILE_BYTES;
  if (size > cap) throw new ToolError("INVALID_ARGUMENT", `attachments[${index}] "${name}" is ${size} bytes; ${isImage ? "images" : "files"} are capped at ${cap / (1024 * 1024)} MiB.`);
}

/** Validate every attachment, then upload them in order; nothing is uploaded unless all validate (spec §8). */
export async function uploadInlineAttachments(api: DaemonApi, sessionId: string, inputs: readonly AttachmentInput[], opts?: { max?: number }): Promise<AttachmentRef[]> {
  const max = opts?.max ?? MAX_ATTACHMENTS;
  if (inputs.length > max) throw new ToolError("INVALID_ARGUMENT", `At most ${max} attachments per message.`);
  const prepared: Prepared[] = [];
  for (const [index, input] of inputs.entries()) prepared.push(await prepare(api, input, index));
  const refs: AttachmentRef[] = [];
  for (const p of prepared) {
    const res = await api.uploadAttachment(sessionId, { name: p.name, type: p.type }, Readable.from([p.bytes]));
    if (res.status >= 400) throw daemonError({ status: res.status, body: res.value }, { code: "HOST_UNAVAILABLE", message: "Attachment upload failed." });
    const ref = res.value as AttachmentRef | null;
    if (!ref || typeof ref !== "object" || typeof (ref as { id?: unknown }).id !== "string") throw new ToolError("INTERNAL", "The host did not return an attachment reference.");
    refs.push(ref);
  }
  return refs;
}
```

- [ ] **Step 4: Run the tests and typecheck** — `node --import tsx --test src/mcp/attachments.test.ts` → PASS; `pnpm check` → clean.

---

### Task 7: Catalogue tools (`tools/catalog.ts`)

Spec §7.1. Parallel with Tasks 8–11 after Tasks 3–6.

**Files:**
- Create: `apps/daemon/src/mcp/tools/catalog.ts`, `apps/daemon/src/mcp/tools/catalog.test.ts`

**Interfaces:**
- Consumes: `defineTool`, `READ_ONLY` (tool.ts); `resolveProject` (addressing.ts); `listSessions`, `expectOk` (reads/errors); `loadAgents` (agents.ts).
- Produces: `export const catalogTools: ToolDef[]` — `list_projects`, `list_agents`, `list_conversations`.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/mcp/tools/catalog.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDaemonApi } from "../testing.ts";
import { chatSummary, stamp } from "../fixtures.ts";
import type { ToolContext } from "../tool.ts";
import { catalogTools } from "./catalog.ts";

const tool = (name: string) => catalogTools.find((t) => t.name === name)!;
const ctx = (api: FakeDaemonApi): ToolContext => ({ api, todos: {} as never, files: {} as never, signal: new AbortController().signal, now: () => Date.parse("2026-09-22T12:00:00.000Z") });

test("list_projects flattens workspaces, hides archived by default, marks recency and open sessions, recent first", async () => {
  const api = new FakeDaemonApi()
    .on("GET", "/api/workspaces", { status: 200, body: [{ name: "acme", path: "/w/acme", projectCount: 2 }, { name: "old", path: "/w/old", projectCount: 1, isArchived: true }] })
    .on("GET", "/api/workspaces/acme/projects", { status: 200, body: [{ name: "api", workspace: "acme", path: "/w/acme/api" }, { name: "web", workspace: "acme", path: "/w/acme/web", isArchived: true }] })
    .on("GET", "/api/workspaces/old/projects", { status: 200, body: [{ name: "x", workspace: "old", path: "/w/old/x" }] })
    .on("GET", "/api/projects/recent", { status: 200, body: [{ name: "api", workspace: "acme", path: "/w/acme/api", lastInteractedAt: stamp(5), interactionCount: 3 }] })
    .on("GET", "/api/sessions", { status: 200, body: [chatSummary(), chatSummary({ id: "c2" })] });
  const r = await tool("list_projects").run({ includeArchived: false }, ctx(api));
  assert.deepEqual(r, { projects: [{ workspace: "acme", name: "api", path: "/w/acme/api", isArchived: false, lastInteractedAt: stamp(5), openSessions: 2 }] });
  const all = await tool("list_projects").run({ includeArchived: true }, ctx(api));
  assert.deepEqual((all.projects as { path: string }[]).map((p) => p.path), ["/w/acme/api", "/w/acme/web", "/w/old/x"]);
  const one = await tool("list_projects").run({ workspace: "old", includeArchived: true }, ctx(api));
  assert.equal((one.projects as unknown[]).length, 1);
});

test("list_agents returns the catalogue, optionally one agent", async () => {
  const api = new FakeDaemonApi()
    .on("GET", "/api/registry", { status: 200, body: { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [{ id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } }, { id: "grok", kind: "agent", name: "Grok Build", bin: ["grok"], enabled: true, installState: "idle", chat: { adapter: "grok" } }] } })
    .on("GET", "/api/agent/providers", { status: 200, body: { hostInstanceId: "h", providers: [] } })
    .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [], defaults: { claude: null, codex: null, grok: null } } });
  const r = await tool("list_agents").run({ includeLegacyModels: false }, ctx(api));
  assert.deepEqual((r.agents as { id: string }[]).map((a) => a.id), ["claude", "grok"]);
  const one = await tool("list_agents").run({ agent: "grok", includeLegacyModels: false }, ctx(api));
  assert.deepEqual((one.agents as { id: string }[]).map((a) => a.id), ["grok"]);
  await assert.rejects(tool("list_agents").run({ agent: "nope", includeLegacyModels: false }, ctx(api)), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
});

test("list_conversations resolves the project, maps homes to launch agents and flags resumability", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mcp-cat-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "acme", "api"), { recursive: true });
  const api = new FakeDaemonApi(); api.fsRoot = root; api.workspacesDir = root;
  api.on("GET", "/api/registry", { status: 200, body: { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [{ id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } }, { id: "claudex", kind: "agent", name: "Claude Code × GPT", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } }] } })
    .on("GET", "/api/agents/conversations", ({ query }) => ({ status: 200, body: { conversations: [
      { id: "s1", agentRefId: "claude", title: "Fix build", updatedAt: stamp(9), home: "account", accountId: "acc-1" },
      { id: "s2", agentRefId: "claude", title: "Proxy chat", updatedAt: stamp(8), home: "cliproxy", proxyRefId: "claudex" },
      { id: "s3", agentRefId: "deepseek", title: "Old", updatedAt: stamp(7) },
      { id: "s4", agentRefId: "claude", title: "Other", preview: "p", updatedAt: stamp(6), home: "system" }
    ].filter(() => query?.path === join(root, "acme", "api")) } }));
  const r = await tool("list_conversations").run({ project: "acme/api", limit: 3 }, ctx(api));
  assert.deepEqual(r, { conversations: [
    { id: "s1", agent: "claude", title: "Fix build", updatedAt: stamp(9), home: "account", accountId: "acc-1", resumable: true },
    { id: "s2", agent: "claudex", title: "Proxy chat", updatedAt: stamp(8), home: "cliproxy", resumable: true },
    { id: "s3", agent: "deepseek", title: "Old", updatedAt: stamp(7), home: "system", resumable: false }
  ] });
  const only = await tool("list_conversations").run({ project: join(root, "acme", "api"), agent: "claudex", limit: 20 }, ctx(api));
  assert.deepEqual((only.conversations as { id: string }[]).map((c) => c.id), ["s2"]);
});
```

- [ ] **Step 2: Run to verify failure** — `node --import tsx --test src/mcp/tools/catalog.test.ts` → FAIL.

- [ ] **Step 3: Write the implementation**

`apps/daemon/src/mcp/tools/catalog.ts`:
```ts
import { z } from "zod";
import type { AgentConversationsResponse, ProjectSummary, RecentProjectSummary, RegistryResponse, WorkspaceSummary } from "@orquester/api";
import { resolveProject } from "../addressing.ts";
import { findAgent, loadAgents } from "../agents.ts";
import { expectOk } from "../errors.ts";
import { listSessions } from "../reads.ts";
import { defineTool, READ_ONLY, type ToolDef } from "../tool.ts";

const listProjects = defineTool({
  name: "list_projects",
  title: "List projects",
  description: "List every project (workspace/name and absolute path) with recency and open-session counts. Use the `path` or `workspace/name` as the `project` argument of other tools.",
  input: {
    workspace: z.string().optional().describe("Only this workspace."),
    includeArchived: z.boolean().default(false).describe("Include archived workspaces and projects.")
  },
  annotations: READ_ONLY,
  async run(args, { api }) {
    const workspaces = expectOk<WorkspaceSummary[]>(await api.request("GET", "/api/workspaces"), "workspaces");
    const recentRes = await api.request("GET", "/api/projects/recent");
    const recent = recentRes.status < 400 ? (recentRes.body as RecentProjectSummary[]) : [];
    const sessions = await listSessions(api);
    const projects: { workspace: string; name: string; path: string; isArchived: boolean; lastInteractedAt?: string; openSessions: number }[] = [];
    for (const ws of workspaces) {
      if (args.workspace && ws.name !== args.workspace) continue;
      if (ws.isArchived && !args.includeArchived) continue;
      const list = expectOk<ProjectSummary[]>(await api.request("GET", `/api/workspaces/${encodeURIComponent(ws.name)}/projects`), "projects");
      for (const p of list) {
        if (p.isArchived && !args.includeArchived) continue;
        const r = recent.find((x) => x.path === p.path);
        projects.push({ workspace: ws.name, name: p.name, path: p.path, isArchived: p.isArchived === true, ...(r ? { lastInteractedAt: r.lastInteractedAt } : {}), openSessions: sessions.filter((s) => s.projectPath === p.path).length });
      }
    }
    projects.sort((a, b) => {
      if (a.lastInteractedAt !== b.lastInteractedAt) { if (!a.lastInteractedAt) return 1; if (!b.lastInteractedAt) return -1; return a.lastInteractedAt < b.lastInteractedAt ? 1 : -1; }
      return `${a.workspace}/${a.name}`.localeCompare(`${b.workspace}/${b.name}`);
    });
    return { projects };
  }
});

const listAgents = defineTool({
  name: "list_agents",
  title: "List launchable agents",
  description: "The chat agents you can open (claude, claudex, claudemix, codex, opencode, grok) with their valid models, model options (effort…), permission modes, capabilities and accounts. Call this before create_session or update_session.",
  input: {
    agent: z.string().optional().describe("Only this agent id."),
    includeLegacyModels: z.boolean().default(false).describe("Also list models flagged legacy.")
  },
  annotations: READ_ONLY,
  async run(args, { api }) {
    const agents = await loadAgents(api, { includeLegacyModels: args.includeLegacyModels });
    return { agents: args.agent ? [findAgent(agents, args.agent)] : agents };
  }
});

const listConversations = defineTool({
  name: "list_conversations",
  title: "List resumable conversations",
  description: "Past provider conversations recorded for a project, newest first. Pass a row's `id` as create_session.resume.conversationId; `agent` is the agent to resume it with.",
  input: {
    project: z.string().describe("Absolute project path or \"<workspace>/<project>\"."),
    agent: z.string().optional().describe("Only conversations resumable with this agent id."),
    limit: z.number().int().min(1).max(200).default(20).describe("Maximum rows.")
  },
  annotations: READ_ONLY,
  async run(args, { api }) {
    const project = await resolveProject(api, args.project);
    const registry = await api.request("GET", "/api/registry");
    const chatAgents = new Set(registry.status < 400 ? ((registry.body as RegistryResponse).agents ?? []).filter((e) => e.chat?.adapter).map((e) => e.id) : []);
    const res = expectOk<AgentConversationsResponse>(await api.request("GET", "/api/agents/conversations", { query: { path: project.path } }), "conversations");
    const rows = res.conversations.map((c) => {
      const agent = c.home === "cliproxy" && c.proxyRefId ? c.proxyRefId : c.agentRefId;
      return { id: c.id, agent, title: c.title, ...(c.preview ? { preview: c.preview } : {}), updatedAt: c.updatedAt, home: c.home ?? "system", ...(c.accountId ? { accountId: c.accountId } : {}), resumable: chatAgents.has(agent) };
    });
    const filtered = args.agent ? rows.filter((r) => r.agent === args.agent) : rows;
    return { conversations: filtered.slice(0, args.limit) };
  }
});

export const catalogTools: ToolDef[] = [listProjects as ToolDef, listAgents as ToolDef, listConversations as ToolDef];
```
(`.default(...)` on a zod field makes the parsed value present; tests pass the field explicitly. If `ToolDef`'s generic makes the `as ToolDef` casts unnecessary, drop them.)

- [ ] **Step 4: Run the tests and typecheck** — `node --import tsx --test src/mcp/tools/catalog.test.ts` → PASS; `pnpm check` → clean.

---

### Task 8: Session tools (`tools/sessions.ts`)

Spec §7.2, §7.3. Parallel with Tasks 7, 9, 10, 11.

**Files:**
- Create: `apps/daemon/src/mcp/tools/sessions.ts`, `apps/daemon/src/mcp/tools/sessions.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5 exports (`resolveProject`, `listSessions`, `findSession`, `requireChatSession`, `readThread`, `sendCommand`, `buildViewContext`, `sessionView`, `sessionDetail`, `loadAgents`, `findAgent`, `isProxyAgent`, `resolveModelSelection`, `validateAccountId`, `capText`, `ToolError`, `expectOk`).
- Consumes also: `chatDetail(api, sessionId)` from `../views.ts` (Task 3).
- Produces: `export const sessionTools: ToolDef[]` and `export const MAX_RUNNING_SESSIONS_PER_PROJECT = 24`.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/mcp/tools/sessions.test.ts` (the fake routes every test shares are built by `harness()`; each test overrides what it needs):
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDaemonApi } from "../testing.ts";
import { activity, chatSummary, head, message, shellSummary, snapshot, stamp, turn } from "../fixtures.ts";
import type { ToolContext } from "../tool.ts";
import { sessionTools } from "./sessions.ts";

const tool = (name: string) => sessionTools.find((t) => t.name === name)!;
const registry = { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [
  { id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } },
  { id: "claudex", kind: "agent", name: "Claude Code × GPT", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } },
  { id: "grok", kind: "agent", name: "Grok Build", bin: ["grok"], enabled: false, installState: "idle", chat: { adapter: "grok" } }
] };
const providers = { hostInstanceId: "h", providers: [{ id: "claude", refIds: ["claude", "claudex"], installed: true, version: "2", status: "ready", auth: { status: "authenticated" }, checkedAt: stamp(0), slashCommands: [], skills: [],
  capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: true, showPlanModeToggle: true, reportsContextWindow: true, compaction: { type: "slash-command", command: "/compact" } },
  models: [{ slug: "default", name: "Default", isDefault: true, capabilities: { optionDescriptors: [{ id: "effort", label: "Effort", type: "select", options: [{ id: "medium", label: "Medium", isDefault: true }, { id: "high", label: "High" }] }] } }, { slug: "haiku", name: "Haiku", capabilities: null }] }] };
const accounts = { accounts: [{ id: "acc-1", agent: "claude", label: "jasperclaude", email: null, plan: null, needsReauth: false, createdAt: stamp(0), importedAt: stamp(0) }, { id: "acc-2", agent: "codex", label: "e@x.io", email: "e@x.io", plan: null, needsReauth: false, createdAt: stamp(0), importedAt: stamp(0) }], defaults: { claude: "acc-1", codex: "acc-2", grok: null } };
const cliproxy = { state: "healthy", reasons: [], detail: null, version: null, defaultModel: "gpt-5.6-sol", backgroundModel: "", modelOverrides: {}, providers: [], routerProviders: [], accounts: [{ id: "acc-2", provider: "codex", label: "e@x.io" }], activeSessionCount: 0, testedClaudeCliVersion: null, xai: { state: "none", email: null, expiredAt: null, lastQuotaError: null, lastLinkError: null, link: null } };

async function harness(sessions = [chatSummary(), shellSummary()], snap = snapshot()) {
  const root = await mkdtemp(join(tmpdir(), "mcp-sess-"));
  await mkdir(join(root, "acme", "api"), { recursive: true });
  const api = new FakeDaemonApi(); api.fsRoot = root; api.workspacesDir = root;
  const projectPath = join(root, "acme", "api");
  const fix = (s: ReturnType<typeof chatSummary>) => ({ ...s, projectPath, cwd: projectPath });
  api.on("GET", "/api/sessions", { status: 200, body: sessions.map(fix) })
    .on("GET", "/api/sessions/c1/thread", { status: 200, body: { kind: "snapshot", thread: { ...snap, head: { ...snap.head, projectPath, cwd: projectPath } } } })
    .on("GET", "/api/registry", { status: 200, body: registry }).on("GET", "/api/agent/providers", { status: 200, body: providers })
    .on("GET", "/api/agent-accounts", { status: 200, body: accounts }).on("GET", "/api/cliproxy", { status: 200, body: cliproxy }).on("GET", "/api/cliproxy/models", { status: 200, body: { models: [], asOf: null } });
  const ctx: ToolContext = { api, todos: {} as never, files: {} as never, signal: new AbortController().signal, now: () => Date.parse("2026-09-22T12:00:00.000Z") };
  return { api, ctx, projectPath, root, close: () => rm(root, { recursive: true, force: true }) };
}

test("list_sessions: kind filter, project filter, attention ordering", async (t) => {
  const waiting = chatSummary({ id: "c9", hasPendingUserInput: true, activity: { state: "waiting", attention: "needs-input", lastOutputAt: null, needsAttentionAt: stamp(9) } });
  const h = await harness([chatSummary(), shellSummary(), waiting]); t.after(h.close);
  const all = await tool("list_sessions").run({ kind: "all", attention: false }, h.ctx);
  assert.deepEqual((all.sessions as { id: string; kind: string }[]).map((s) => [s.id, s.kind]), [["c1", "chat"], ["t1", "terminal"], ["c9", "chat"]]);
  const chats = await tool("list_sessions").run({ kind: "chat", attention: false, project: "acme/api" }, h.ctx);
  assert.deepEqual((chats.sessions as { id: string }[]).map((s) => s.id), ["c1", "c9"]);
  assert.deepEqual(h.api.calls.filter((c) => c.path === "/api/sessions").at(-1)?.query, { projectPath: h.projectPath });
  const att = await tool("list_sessions").run({ kind: "all", attention: true }, h.ctx);
  assert.deepEqual((att.sessions as { id: string; reason: string }[]).map((s) => [s.id, s.reason]), [["c9", "question"], ["c1", "completed"]]);
});

test("get_session returns a detail for a chat and a view for a terminal; unknown id errors", async (t) => {
  const h = await harness(); t.after(h.close);
  const chat = await tool("get_session").run({ sessionId: "c1" }, h.ctx);
  assert.equal((chat.session as { chat: { model: string } }).chat.model, "claude-fable-5-1[1m]");
  const term = await tool("get_session").run({ sessionId: "t1" }, h.ctx);
  assert.equal((term.session as { kind: string }).kind, "terminal");
  await assert.rejects(tool("get_session").run({ sessionId: "zz" }, h.ctx), (e: { code: string }) => e.code === "SESSION_NOT_FOUND");
});

test("create_session validates everything up front and posts the GUI's body (claude, then claudex, then a resume)", async (t) => {
  const h = await harness(); t.after(h.close);
  h.api.on("POST", "/api/sessions", ({ body }) => ({ status: 200, body: chatSummary({ id: "c1", refId: (body as { refId: string }).refId }) }));
  const r = await tool("create_session").run({ project: "acme/api", agent: "claude", model: "default", options: { effort: "high" }, runtimeMode: "approval-required", accountId: "acc-1", title: "Fixer" }, h.ctx);
  assert.equal((r.session as { id: string }).id, "c1");
  const created = h.api.calls.find((c) => c.method === "POST" && c.path === "/api/sessions")!.body;
  assert.deepEqual(created, { kind: "agent-chat", refId: "claude", projectPath: h.projectPath, cwd: h.projectPath, title: "Fixer", accountId: "acc-1",
    chat: { accountId: "acc-1", modelSelection: { model: "default", options: [{ id: "effort", value: "high" }] }, runtimeMode: "approval-required" } });
  h.api.calls.length = 0;
  await tool("create_session").run({ project: h.projectPath, agent: "claudex", runtimeMode: "full-access" }, h.ctx);
  const proxy = h.api.calls.find((c) => c.method === "POST" && c.path === "/api/sessions")!.body as Record<string, unknown>;
  assert.equal(proxy.model, "gpt-5.6-sol"); assert.equal(proxy.title, "Claude Code × GPT");
  assert.deepEqual(proxy.chat, { modelSelection: { model: "gpt-5.6-sol", options: [] }, runtimeMode: "full-access" });
  assert.equal(proxy.accountId, undefined, "no accountId → the daemon picks the family default");
  h.api.on("GET", "/api/agents/conversations", { status: 200, body: { conversations: [{ id: "conv-1", agentRefId: "claude", title: "Earlier", updatedAt: stamp(1), home: "account", accountId: "acc-1" }] } });
  h.api.calls.length = 0;
  await tool("create_session").run({ project: "acme/api", resume: { conversationId: "conv-1" }, runtimeMode: "full-access" }, h.ctx);
  const resumed = h.api.calls.find((c) => c.method === "POST" && c.path === "/api/sessions")!.body as Record<string, unknown>;
  assert.equal(resumed.refId, "claude"); assert.equal(resumed.title, "Earlier"); assert.equal(resumed.accountId, "acc-1");
  assert.deepEqual((resumed.chat as { resume: unknown }).resume, { home: "account", conversationId: "conv-1" });
});

test("create_session refusals: unknown project, disabled agent, bad model, wrong-family account, cwd escape, unknown conversation, session cap", async (t) => {
  const h = await harness(); t.after(h.close);
  const run = (a: Record<string, unknown>) => tool("create_session").run({ runtimeMode: "full-access", ...a }, h.ctx);
  await assert.rejects(run({ project: "acme/nope", agent: "claude" }), (e: { code: string }) => e.code === "PROJECT_NOT_FOUND");
  await assert.rejects(run({ project: "acme/api", agent: "grok" }), (e: { message: string }) => /not available/.test(e.message));
  await assert.rejects(run({ project: "acme/api", agent: "claude", model: "gpt-9" }), (e: { message: string }) => /default, haiku/.test(e.message));
  await assert.rejects(run({ project: "acme/api", agent: "claude", accountId: "acc-2" }), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /acc-1/.test(e.message));
  await assert.rejects(run({ project: "acme/api", agent: "claude", cwd: "/etc" }), (e: { code: string }) => e.code === "PATH_NOT_ALLOWED");
  h.api.on("GET", "/api/agents/conversations", { status: 200, body: { conversations: [] } });
  await assert.rejects(run({ project: "acme/api", agent: "claude", resume: { conversationId: "missing" } }), (e: { message: string }) => /list_conversations/.test(e.message));
  const many = Array.from({ length: 24 }, (_, i) => chatSummary({ id: `c${i}` }));
  const full = await harness(many); t.after(full.close);
  await assert.rejects(tool("create_session").run({ project: "acme/api", agent: "claude", runtimeMode: "full-access" }, full.ctx), (e: { code: string }) => e.code === "SESSION_BUSY");
  assert.ok(!h.api.calls.some((c) => c.method === "POST"), "nothing was created");
});

test("update_session: one /mode body for model+effort+runtimeMode, rename via PUT, account via /account, no-ops skipped", async (t) => {
  const h = await harness(); t.after(h.close);
  h.api.on("PUT", "/api/sessions/c1", { status: 200, body: chatSummary({ title: "New" }) }).on("POST", "/api/sessions/c1/mode", { status: 200, body: { seq: 11 } }).on("POST", "/api/sessions/c1/account", { status: 200, body: { seq: 12 } });
  const r = await tool("update_session").run({ sessionId: "c1", title: "New", model: "default", options: { effort: "medium" }, runtimeMode: "auto", accountId: "system", force: false }, h.ctx);
  assert.deepEqual(r.applied, ["title", "model", "options", "runtimeMode"]);
  const mode = h.api.calls.find((c) => c.path === "/api/sessions/c1/mode")!.body as Record<string, unknown>;
  assert.deepEqual(mode.modelSelection, { model: "default", options: [{ id: "effort", value: "medium" }] }); assert.equal(mode.runtimeMode, "auto");
  assert.ok(!h.api.calls.some((c) => c.path === "/api/sessions/c1/account"), "system → system is a no-op");
  assert.deepEqual(h.api.calls.find((c) => c.method === "PUT")!.body, { title: "New" });
  h.api.calls.length = 0;
  const acc = await tool("update_session").run({ sessionId: "c1", accountId: "acc-1", force: false }, h.ctx);
  assert.deepEqual(acc.applied, ["accountId"]);
  assert.deepEqual(h.api.calls.find((c) => c.path === "/api/sessions/c1/account")!.body, { commandId: (h.api.calls.find((c) => c.path === "/api/sessions/c1/account")!.body as { commandId: string }).commandId, accountId: "acc-1" });
});

test("update_session gates: busy without force, idle gate for accounts, opencode has no account, wrong family", async (t) => {
  const running = chatSummary({ chatSessionStatus: "running", latestTurn: { turnId: "t2", state: "running", startedAt: stamp(2), completedAt: null } });
  const h = await harness([running]); t.after(h.close);
  h.api.on("POST", "/api/sessions/c1/mode", { status: 200, body: { seq: 1 } });
  await assert.rejects(tool("update_session").run({ sessionId: "c1", runtimeMode: "auto", force: false }, h.ctx), (e: { code: string; message: string }) => e.code === "SESSION_BUSY" && /force/.test(e.message));
  await tool("update_session").run({ sessionId: "c1", runtimeMode: "auto", force: true }, h.ctx);
  await assert.rejects(tool("update_session").run({ sessionId: "c1", accountId: "acc-1", force: true }, h.ctx), (e: { code: string }) => e.code === "SESSION_BUSY");
  const oc = await harness([chatSummary({ refId: "opencode" })]); t.after(oc.close);
  await assert.rejects(tool("update_session").run({ sessionId: "c1", accountId: "acc-1", force: false }, oc.ctx), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /OpenCode/.test(e.message));
  const idle = await harness(); t.after(idle.close);
  await assert.rejects(tool("update_session").run({ sessionId: "c1", accountId: "acc-2", force: false }, idle.ctx), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
});

test("interrupt/stop/close/compact/revert map to their commands with the right gates", async (t) => {
  const running = chatSummary({ chatSessionStatus: "running", latestTurn: { turnId: "t2", state: "running", startedAt: stamp(2), completedAt: null } });
  const three = [turn(), turn({ turnId: "t2", turnCount: 2, requestedAt: stamp(2), startedAt: stamp(2), completedAt: stamp(3) }), turn({ turnId: "t3", turnCount: 3, requestedAt: stamp(4), startedAt: stamp(4), completedAt: null, state: "running" })];
  const h = await harness([running, shellSummary()], snapshot({ head: head({ session: { status: "running", activeTurnId: "t3" }, turnCount: 3 }), turns: three })); t.after(h.close);
  for (const name of ["interrupt", "session/stop", "compact", "revert"]) h.api.on("POST", `/api/sessions/c1/${name}`, { status: 200, body: { seq: 7 } });
  h.api.on("DELETE", "/api/sessions/c1", { status: 204, body: null }).on("DELETE", "/api/sessions/t1", { status: 204, body: null });
  const i = await tool("interrupt_session").run({ sessionId: "c1" }, h.ctx);
  assert.equal(i.seq, 7); assert.deepEqual((h.api.calls.find((c) => c.path === "/api/sessions/c1/interrupt")!.body as { turnId: string }).turnId, "t3");
  await tool("stop_session").run({ sessionId: "c1" }, h.ctx);
  assert.ok(h.api.calls.some((c) => c.path === "/api/sessions/c1/session/stop"));
  assert.deepEqual(await tool("close_session").run({ sessionId: "t1" }, h.ctx), { closed: true, sessionId: "t1" });
  await tool("compact_session").run({ sessionId: "c1" }, h.ctx);
  await assert.rejects(tool("revert_session").run({ sessionId: "c1", keepTurns: 1 }, h.ctx), (e: { code: string }) => e.code === "SESSION_BUSY");
  const settled = [turn(), turn({ turnId: "t2", turnCount: 2, requestedAt: stamp(2), startedAt: stamp(2), completedAt: stamp(3) }), turn({ turnId: "t3", turnCount: 3, requestedAt: stamp(4), startedAt: stamp(4), completedAt: stamp(5) })];
  const idle = await harness([chatSummary()], snapshot({ head: head({ turnCount: 3 }), turns: settled })); t.after(idle.close);
  idle.api.on("POST", "/api/sessions/c1/revert", { status: 200, body: { seq: 8 } }).on("POST", "/api/sessions/c1/interrupt", { status: 200, body: { seq: 9 } });
  await tool("revert_session").run({ sessionId: "c1", keepTurns: 1 }, idle.ctx);
  assert.deepEqual((idle.api.calls.find((c) => c.path === "/api/sessions/c1/revert")!.body as { targetTurnCount: number }).targetTurnCount, 1);
  await assert.rejects(tool("revert_session").run({ sessionId: "c1", keepTurns: 3 }, idle.ctx), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  await tool("interrupt_session").run({ sessionId: "c1" }, idle.ctx);
  assert.equal((idle.api.calls.find((c) => c.path === "/api/sessions/c1/interrupt")!.body as { turnId?: string }).turnId, undefined, "no running turn → stop background work");
  const grok = await harness([chatSummary({ refId: "grok" })]); t.after(grok.close);
  await assert.rejects(tool("revert_session").run({ sessionId: "c1", keepTurns: 0 }, grok.ctx), (e: { message: string }) => /rollback/.test(e.message));
});

test("get_turn_diff defaults to the latest turn, includes the checkpoint files and caps the diff", async (t) => {
  const snap = snapshot({ head: head({ turnCount: 5 }), checkpoints: [{ turnId: "t2", checkpointTurnCount: 2, checkpointRef: "r", status: "ready", files: [{ path: "a.ts", additions: 1, deletions: 0 }], assistantMessageId: null, completedAt: stamp(3) }] });
  const h = await harness([chatSummary()], snap); t.after(h.close);
  h.api.on("GET", "/api/sessions/c1/turns/2/diff", { status: 200, body: { fromTurnCount: 1, toTurnCount: 2, diff: "x".repeat(90_000) } });
  const r = await tool("get_turn_diff").run({ sessionId: "c1" }, h.ctx);
  assert.equal(r.turn, 2); assert.equal(r.fromTurn, 1); assert.deepEqual(r.files, [{ path: "a.ts", additions: 1, deletions: 0 }]); assert.equal((r.diff as string).length, 80_000); assert.equal(r.truncated, true);
  assert.deepEqual(h.api.calls.find((c) => c.path.endsWith("/diff"))!.query, { ignoreWhitespace: "1" });
  await assert.rejects(tool("get_turn_diff").run({ sessionId: "c1", turn: 5 }, h.ctx), (e: { code: string }) => e.code === "THREAD_NOT_FOUND" || e.code === "NOT_FOUND" || e.code === "INVALID_ARGUMENT");
});

```

- [ ] **Step 2: Run to verify failure** — `node --import tsx --test src/mcp/tools/sessions.test.ts` → FAIL.

- [ ] **Step 3: Write the implementation**

`apps/daemon/src/mcp/tools/sessions.ts`:
```ts
import { z } from "zod";
import type { AgentConversationsResponse, SessionSummary } from "@orquester/api";
import { agentChatRoutes, RUNTIME_MODES, startedTurns, type AccountHomeKind, type ModelSelection, type RuntimeMode, type TurnDiffResponse } from "@orquester/api/agent-chat";
import { assertInsideFsRoot, FsSandboxError } from "@orquester/config/fs";
import { resolve } from "node:path";
import { resolveProject } from "../addressing.ts";
import { findAgent, isProxyAgent, loadAgents, resolveModelSelection, validateAccountId, type ResolvedSelection } from "../agents.ts";
import type { DaemonApi } from "../daemon-api.ts";
import { ToolError, expectOk } from "../errors.ts";
import { findSession, listSessions, readThread, requireChatSession, sendCommand } from "../reads.ts";
import { capText } from "../result.ts";
import { defineTool, DESTRUCTIVE, MUTATING, MUTATING_IDEMPOTENT, READ_ONLY, type ToolDef } from "../tool.ts";
import { buildViewContext, chatDetail, sessionView } from "../views.ts";

export const MAX_RUNNING_SESSIONS_PER_PROJECT = 24;
const MAX_DIFF_CHARS = 80_000;
const runtimeModeSchema = z.enum(RUNTIME_MODES as unknown as [RuntimeMode, ...RuntimeMode[]]);
const optionsSchema = z.record(z.union([z.string(), z.boolean()])).describe("Model options by id, e.g. {\"effort\":\"high\",\"thinking\":true}. `effort` works for every agent.");
const sessionIdField = z.string().min(1).describe("The session id from list_sessions.");

function isTurnActive(s: SessionSummary): boolean {
  return s.chatSessionStatus === "starting" || s.chatSessionStatus === "running" || s.latestTurn?.state === "running" || s.latestTurn?.state === "pending";
}

/** The GUI's `canSwitchChatAccount` / the host's `identitySwitchRefusal`, on summary fields. */
function switchRefusal(s: SessionSummary): string | null {
  if (isTurnActive(s)) return "Wait for the agent to finish the current turn before switching accounts.";
  if (s.hasPendingApprovals || s.hasPendingUserInput) return "Answer the agent's open request before switching accounts.";
  if (s.backgroundLiveness) return "Wait for the background work to finish before switching accounts.";
  return null;
}

function sameSelection(a: ResolvedSelection, b: ModelSelection): boolean {
  const norm = (o: readonly { id: string; value: string | boolean }[] | undefined) => JSON.stringify([...(o ?? [])].sort((x, y) => x.id.localeCompare(y.id)));
  return a.model === b.model && norm(a.options) === norm(b.options);
}

const listSessionsTool = defineTool({
  name: "list_sessions",
  title: "List sessions",
  description: "The open tabs: chat sessions (Claude/Codex/OpenCode/Grok) and terminals, with status (working/waiting/idle), attention and why. `attention:true` returns only sessions that need you, ordered like the Attention Center.",
  input: {
    project: z.string().optional().describe("Absolute project path or \"<workspace>/<project>\"; omit for every project."),
    kind: z.enum(["chat", "terminal", "all"]).default("all").describe("Which tabs to list."),
    attention: z.boolean().default(false).describe("Only sessions with attention set or waiting on you.")
  },
  annotations: READ_ONLY,
  async run(args, { api }) {
    const projectPath = args.project ? (await resolveProject(api, args.project)).path : undefined;
    const ctx = await buildViewContext(api);
    let sessions = await listSessions(api, projectPath);
    if (args.kind !== "all") sessions = sessions.filter((s) => (args.kind === "chat") === (s.kind === "agent-chat"));
    if (args.attention) {
      sessions = sessions.filter((s) => s.activity && (s.activity.attention !== null || s.activity.state === "waiting"));
      const stamp = (s: SessionSummary) => s.activity?.needsAttentionAt ?? s.createdAt;
      sessions.sort((a, b) => (stamp(a) < stamp(b) ? 1 : stamp(a) > stamp(b) ? -1 : 0));
    } else {
      sessions.sort((a, b) => a.projectPath.localeCompare(b.projectPath) || a.order - b.order);
    }
    return { sessions: sessions.map((s) => sessionView(s, ctx)) };
  }
});

const getSession = defineTool({
  name: "get_session",
  title: "Get session status",
  description: "Everything about one session: status and why, model/options/permission mode/account, pending questions and approvals (with their options and ids), the proposed plan, subagents, the context meter and the last reply.",
  input: { sessionId: sessionIdField },
  annotations: READ_ONLY,
  async run(args, { api }) {
    const summary = await findSession(api, args.sessionId);
    if (summary.kind !== "agent-chat") return { session: sessionView(summary, await buildViewContext(api)) };
    return { session: await chatDetail(api, args.sessionId) };
  }
});

const getTurnDiff = defineTool({
  name: "get_turn_diff",
  title: "Get a turn's diff",
  description: "The unified diff of the files a turn changed (the GUI's changed-files card). Defaults to the latest turn with a checkpoint.",
  input: { sessionId: sessionIdField, turn: z.number().int().min(1).optional().describe("Turn number (1-based); default: the latest.") },
  annotations: READ_ONLY,
  async run(args, { api }) {
    await requireChatSession(api, args.sessionId);
    const snap = await readThread(api, args.sessionId);
    // Checkpoints are keyed by turn ORDINAL and sparse (a non-git project captures nothing);
    // default to the latest turn that has one.
    const latestCheckpointed = snap.checkpoints.reduce((max, c) => Math.max(max, c.checkpointTurnCount), 0);
    const turnCount = args.turn ?? latestCheckpointed;
    if (turnCount < 1) throw new ToolError("INVALID_ARGUMENT", "This session has no checkpointed turn yet.");
    const res = expectOk<TurnDiffResponse>(await api.request("GET", agentChatRoutes.turnDiff(args.sessionId, turnCount), { query: { ignoreWhitespace: "1" } }), "diff");
    const files = snap.checkpoints.find((c) => c.checkpointTurnCount === turnCount)?.files ?? [];
    const diff = capText(res.diff, MAX_DIFF_CHARS);
    return { turn: res.toTurnCount, fromTurn: res.fromTurnCount, files: files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })), diff: diff.text, truncated: diff.truncated };
  }
});

async function resolveCwd(api: DaemonApi, cwd: string): Promise<string> {
  try { await assertInsideFsRoot(api.fsRoot, cwd); } catch (error) {
    if (error instanceof FsSandboxError) throw new ToolError("PATH_NOT_ALLOWED", "cwd is not allowed (outside the sandbox).");
    throw new ToolError("INVALID_ARGUMENT", "cwd does not exist.");
  }
  return resolve(cwd);
}

const createSession = defineTool({
  name: "create_session",
  title: "Open a chat session",
  description: "Open a new chat tab for an agent in a project — the GUI's '+' menu — with model, options (effort…), permission mode and account; or resume a past conversation from list_conversations. Returns the session detail. Send the first message with send_message.",
  input: {
    project: z.string().describe("Absolute project path or \"<workspace>/<project>\"."),
    agent: z.string().optional().describe("Agent id from list_agents (claude, claudex, claudemix, codex, opencode, grok). Required unless `resume` is given."),
    model: z.string().optional().describe("Model slug from list_agents; default: the agent's default."),
    options: optionsSchema.optional(),
    runtimeMode: runtimeModeSchema.default("full-access").describe("Permission mode: approval-required (Supervised), auto-accept-edits, auto, full-access."),
    accountId: z.string().optional().describe("A managed account id from list_agents, or \"system\"; default: the family's default account."),
    title: z.string().min(1).max(300).optional().describe("Tab title; default: the agent's name (or the conversation's)."),
    cwd: z.string().optional().describe("Working directory inside the sandbox; default: the project path."),
    resume: z.object({ conversationId: z.string().min(1) }).optional().describe("Resume this conversation (id from list_conversations for the same project).")
  },
  annotations: MUTATING,
  async run(args, { api }) {
    const project = await resolveProject(api, args.project);
    let resumeRow: { id: string; agent: string; title: string; home: AccountHomeKind; accountId?: string } | undefined;
    if (args.resume) {
      const res = expectOk<AgentConversationsResponse>(await api.request("GET", "/api/agents/conversations", { query: { path: project.path } }), "conversations");
      const row = res.conversations.find((c) => c.id === args.resume!.conversationId);
      if (!row) throw new ToolError("INVALID_ARGUMENT", `No conversation "${args.resume.conversationId}" in this project; pick one from list_conversations.`);
      resumeRow = { id: row.id, agent: row.home === "cliproxy" && row.proxyRefId ? row.proxyRefId : row.agentRefId, title: row.title, home: row.home ?? "system", ...(row.accountId ? { accountId: row.accountId } : {}) };
    }
    const refId = args.agent ?? resumeRow?.agent;
    if (!refId) throw new ToolError("INVALID_ARGUMENT", "agent is required (see list_agents).");
    if (resumeRow && args.agent && resumeRow.agent !== args.agent) throw new ToolError("INVALID_ARGUMENT", `Conversation "${resumeRow.id}" belongs to ${resumeRow.agent}, not ${args.agent}.`);
    const agent = findAgent(await loadAgents(api), refId);
    if (!agent.enabled) throw new ToolError("INVALID_ARGUMENT", `${refId} is not available on this host (not installed or disabled).`);
    const selection = resolveModelSelection(agent, { model: args.model, options: args.options });
    let accountId = validateAccountId(agent, args.accountId);
    if (resumeRow?.home === "account" && resumeRow.accountId) accountId = resumeRow.accountId;
    else if (resumeRow?.home === "system") accountId = accountId ?? "system";
    const cwd = args.cwd ? await resolveCwd(api, args.cwd) : project.path;
    const running = (await listSessions(api, project.path)).filter((s) => s.status === "running").length;
    if (running >= MAX_RUNNING_SESSIONS_PER_PROJECT) throw new ToolError("SESSION_BUSY", `${running} sessions are open in this project (limit ${MAX_RUNNING_SESSIONS_PER_PROJECT}); close some first.`);
    const chat: Record<string, unknown> = { ...(accountId ? { accountId } : {}), modelSelection: { model: selection.model, options: selection.options }, runtimeMode: args.runtimeMode };
    if (resumeRow) chat.resume = { home: resumeRow.home, conversationId: resumeRow.id };
    const body = { kind: "agent-chat", refId, projectPath: project.path, cwd, title: args.title ?? resumeRow?.title ?? agent.name, ...(accountId ? { accountId } : {}), ...(isProxyAgent(refId) ? { model: selection.model } : {}), chat };
    const summary = expectOk<SessionSummary>(await api.request("POST", "/api/sessions", { body }), "create");
    return { session: await chatDetail(api, summary.id) };
  }
});

const updateSession = defineTool({
  name: "update_session",
  title: "Update session settings",
  description: "Change what the composer bar holds — model, options (effort…), permission mode, account — and/or rename the tab. Model/permission changes restart a live agent session and are refused while a turn runs unless force:true; an account switch applies on the next message and needs an idle session.",
  input: {
    sessionId: sessionIdField,
    title: z.string().min(1).max(300).optional().describe("New tab title."),
    model: z.string().optional().describe("Model slug from list_agents."),
    options: optionsSchema.optional(),
    runtimeMode: runtimeModeSchema.optional().describe("Permission mode."),
    accountId: z.string().optional().describe("Managed account id or \"system\"; applied on the next message."),
    force: z.boolean().default(false).describe("Apply model/permission changes even while a turn is running (this cuts the turn).")
  },
  annotations: MUTATING_IDEMPOTENT,
  async run(args, { api }) {
    const summary = await requireChatSession(api, args.sessionId);
    const snap = await readThread(api, args.sessionId);
    const agent = findAgent(await loadAgents(api), summary.refId);
    const wantsMode = args.model !== undefined || args.options !== undefined || args.runtimeMode !== undefined;
    if (wantsMode && isTurnActive(summary) && !args.force) {
      throw new ToolError("SESSION_BUSY", "A turn is running; changing the model or permission mode restarts the agent and would cut it. Wait, interrupt_session, or pass force:true.");
    }
    const selection = args.model !== undefined || args.options !== undefined ? resolveModelSelection(agent, { model: args.model, options: args.options, current: snap.head.modelSelection }) : undefined;
    let accountId: string | undefined;
    if (args.accountId !== undefined) {
      if (summary.refId === "opencode" || agent.adapter === "opencode") throw new ToolError("INVALID_ARGUMENT", "OpenCode runs one server per project under the daemon's own identity; it has no per-session account.");
      accountId = validateAccountId(agent, args.accountId);
      const refusal = switchRefusal(summary);
      if (refusal && accountId !== (summary.accountId ?? "system")) throw new ToolError("SESSION_BUSY", refusal);
    }
    const applied: string[] = [];
    try {
      if (args.title !== undefined && args.title !== summary.title) {
        expectOk(await api.request("PUT", `/api/sessions/${encodeURIComponent(args.sessionId)}`, { body: { title: args.title } }), "rename");
        applied.push("title");
      }
      const mode: Record<string, unknown> = {};
      if (selection && !sameSelection(selection, snap.head.modelSelection)) {
        mode.modelSelection = { model: selection.model, options: selection.options };
        if (args.model !== undefined && args.model !== snap.head.modelSelection.model) applied.push("model");
        if (args.options !== undefined) applied.push("options");
        if (!applied.includes("model") && !applied.includes("options")) applied.push("model");
      }
      if (args.runtimeMode !== undefined && args.runtimeMode !== snap.head.runtimeMode) { mode.runtimeMode = args.runtimeMode; applied.push("runtimeMode"); }
      if (Object.keys(mode).length) await sendCommand(api, args.sessionId, "mode", mode);
      if (accountId !== undefined && accountId !== (summary.accountId ?? "system")) {
        await sendCommand(api, args.sessionId, "account", { accountId });
        applied.push("accountId");
      }
    } catch (error) {
      if (error instanceof ToolError) throw new ToolError(error.code, error.message, { applied, ...(error.detail !== undefined ? { cause: error.detail } : {}) });
      throw error;
    }
    return { applied, session: await chatDetail(api, args.sessionId) };
  }
});

const interruptSession = defineTool({
  name: "interrupt_session",
  title: "Interrupt",
  description: "The GUI's Stop: interrupts the running turn (its pending requests are cancelled); with no turn running, stops every live subagent, background shell and watch loop.",
  input: { sessionId: sessionIdField },
  annotations: MUTATING_IDEMPOTENT,
  async run(args, { api }) {
    const summary = await requireChatSession(api, args.sessionId);
    const snap = await readThread(api, args.sessionId);
    const turnId = summary.chatSessionStatus === "running" ? snap.head.session.activeTurnId : null;
    const { seq } = await sendCommand(api, args.sessionId, "interrupt", turnId ? { turnId } : {});
    return { seq, session: await chatDetail(api, args.sessionId) };
  }
});

const stopSession = defineTool({
  name: "stop_session",
  title: "Stop the agent process",
  description: "Stop the provider process but keep the tab, its history and resume cursor; the next send_message resumes it. Use it to recover a session whose status is error.",
  input: { sessionId: sessionIdField },
  annotations: MUTATING_IDEMPOTENT,
  async run(args, { api }) {
    await requireChatSession(api, args.sessionId);
    const { seq } = await sendCommand(api, args.sessionId, "session/stop", {});
    return { seq, session: await chatDetail(api, args.sessionId) };
  }
});

const closeSession = defineTool({
  name: "close_session",
  title: "Close a session",
  description: "Close a tab (chat or terminal). A chat's thread is deleted; the provider's own transcript stays resumable via list_conversations.",
  input: { sessionId: sessionIdField },
  annotations: DESTRUCTIVE,
  async run(args, { api }) {
    await findSession(api, args.sessionId);
    expectOk(await api.request("DELETE", `/api/sessions/${encodeURIComponent(args.sessionId)}`), "close");
    return { closed: true, sessionId: args.sessionId };
  }
});

const revertSession = defineTool({
  name: "revert_session",
  title: "Rewind the conversation",
  description: "Rewind the conversation to keep only the first `keepTurns` turns (the GUI's 'Rewind to here'). Conversation only — files are not restored. Needs an idle session and an agent that supports rollback (not Grok).",
  input: { sessionId: sessionIdField, keepTurns: z.number().int().min(0).describe("How many turns to keep (0 = everything after the start).") },
  annotations: DESTRUCTIVE,
  async run(args, { api }) {
    const summary = await requireChatSession(api, args.sessionId);
    const snap = await readThread(api, args.sessionId);
    const agent = findAgent(await loadAgents(api), summary.refId);
    if (!agent.supports.rollback) throw new ToolError("INVALID_ARGUMENT", `${summary.refId} does not support conversation rollback.`);
    const started = startedTurns(snap.turns).length; // turns are counted by START ORDER (turns.ts), never by checkpoints
    if (args.keepTurns >= started) throw new ToolError("INVALID_ARGUMENT", `keepTurns must be below the number of started turns (${started}).`);
    if (isTurnActive(summary)) throw new ToolError("SESSION_BUSY", "Stop the current turn before rewinding.");
    const { seq } = await sendCommand(api, args.sessionId, "revert", { targetTurnCount: args.keepTurns });
    return { seq, session: await chatDetail(api, args.sessionId) };
  }
});

const compactSession = defineTool({
  name: "compact_session",
  title: "Compact context",
  description: "Ask the agent to compact its context window (the GUI's 'Compact context'). Refused while a turn runs or on an empty conversation.",
  input: { sessionId: sessionIdField },
  annotations: MUTATING_IDEMPOTENT,
  async run(args, { api }) {
    await requireChatSession(api, args.sessionId);
    const { seq } = await sendCommand(api, args.sessionId, "compact", {});
    return { seq, session: await chatDetail(api, args.sessionId) };
  }
});

export const sessionTools: ToolDef[] = [listSessionsTool, getSession, getTurnDiff, createSession, updateSession, interruptSession, stopSession, closeSession, revertSession, compactSession] as ToolDef[];
```

- [ ] **Step 4: Run the tests and typecheck** — `node --import tsx --test src/mcp/tools/sessions.test.ts` → PASS; `pnpm check` → clean.

---

### Task 9: Message tools (`tools/messages.ts`)

Spec §7.4, §7.6, §9.1. Parallel with Tasks 7, 8, 10, 11.

**Files:**
- Create: `apps/daemon/src/mcp/tools/messages.ts`, `apps/daemon/src/mcp/tools/messages.test.ts`

**Interfaces:**
- Consumes: `chatDetail` (Task 3 — import from `../views.ts`), `uploadInlineAttachments` + `attachmentInputSchema` (Task 6), `waitForTurn` + `turnBaseline` (Task 5), `transcriptEntries` (Task 4), `pendingQuestionViews`/`pendingApprovalViews`/`buildViewContext` (Task 3), `buildPlanImplementationPrompt` (Task 1), `sendCommand`/`readThread`/`requireChatSession`.
- Produces: `export const messageTools: ToolDef[]` — `send_message`, `implement_plan`, `read_transcript`.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/mcp/tools/messages.test.ts` (reuse the `harness()` of Task 8's test verbatim — copy it; the two files must not import each other's helpers):
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { busEvent, FakeDaemonApi } from "../testing.ts";
import { activity, chatSummary, message, snapshot, stamp, turn } from "../fixtures.ts";
import type { ToolContext } from "../tool.ts";
import { messageTools } from "./messages.ts";
// …copy `registry`, `providers`, `accounts`, `cliproxy` and `harness()` from sessions.test.ts here…

const tool = (name: string) => messageTools.find((t) => t.name === name)!;
const done = (over = {}) => chatSummary({ latestTurn: { turnId: "t2", state: "completed", startedAt: stamp(2), completedAt: stamp(3) }, ...over });

test("send_message posts the turn body, waits for the new turn and returns its reply", async (t) => {
  const h = await harness(); t.after(h.close);
  const after = snapshot({ turns: [turn(), turn({ turnId: "t2", turnCount: 2, requestedAt: stamp(2), startedAt: stamp(2), completedAt: stamp(3) })], items: [message("user", "hi", { turnId: "t2" }), message("assistant", "hello!", { turnId: "t2" })] });
  let posted = false;
  h.api.on("POST", "/api/sessions/c1/turn", ({ body }) => { posted = true; assert.deepEqual(body, { commandId: (body as { commandId: string }).commandId, input: "hi", interactionMode: "default" }); return { status: 200, body: { seq: 21 } }; });
  h.api.on("GET", "/api/sessions/c1/thread", () => ({ status: 200, body: { kind: "snapshot", thread: posted ? { ...after, head: { ...after.head, projectPath: h.projectPath, cwd: h.projectPath } } : snapshot() } }));
  const p = tool("send_message").run({ sessionId: "c1", text: " hi ", planMode: false, wait: true, timeoutMs: 5_000 }, h.ctx);
  await new Promise((r) => setTimeout(r, 5));
  h.api.emit(busEvent("session.updated", { ...done(), projectPath: h.projectPath }));
  const r = await p;
  assert.equal(r.seq, 21); assert.equal(r.outcome, "completed"); assert.equal(r.turnId, "t2"); assert.equal(r.reply, "hello!"); assert.equal(r.pending, undefined);
});

test("send_message without wait returns sent; attachments are uploaded first and referenced", async (t) => {
  const h = await harness(); t.after(h.close);
  h.api.on("POST", "/api/sessions/c1/turn", ({ body }) => { const b = body as { attachments: { id: string }[]; input: string }; assert.equal(b.attachments.length, 1); assert.equal(b.input, "see"); return { status: 200, body: { seq: 3 } }; });
  const r = await tool("send_message").run({ sessionId: "c1", text: "see", attachments: [{ name: "a.png", base64: Buffer.from("png").toString("base64") }], planMode: false, wait: false, timeoutMs: 1000 }, h.ctx);
  assert.equal(r.outcome, "sent"); assert.equal(h.api.uploads.length, 1); assert.equal(h.api.uploads[0].meta.type, "image/png");
});

test("send_message refusals: empty, pending request, error state, plan mode unsupported", async (t) => {
  const h = await harness(); t.after(h.close);
  const run = (a: Record<string, unknown>, ctx = h.ctx) => tool("send_message").run({ planMode: false, wait: false, timeoutMs: 1000, ...a }, ctx);
  await assert.rejects(run({ sessionId: "c1", text: "  " }), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  const pending = await harness([chatSummary({ hasPendingUserInput: true })], snapshot({ pending: { approvals: [], userInputs: [{ requestId: "q1", createdAt: stamp(1), dismissible: false, questions: [{ id: "x", header: "H", question: "X?", options: [], multiSelect: false, allowCustomAnswer: true }] }] } })); t.after(pending.close);
  await assert.rejects(run({ sessionId: "c1", text: "hi" }, pending.ctx), (e: { code: string; detail: { questions: string[] } }) => e.code === "PENDING_REQUEST" && e.detail.questions[0] === "q1");
  const err = await harness([chatSummary({ chatSessionStatus: "error" })]); t.after(err.close);
  await assert.rejects(run({ sessionId: "c1", text: "hi" }, err.ctx), (e: { code: string; message: string }) => e.code === "SESSION_BUSY" && /stop_session/.test(e.message));
  const stopped = await harness([chatSummary({ chatSessionStatus: "stopped" })]); t.after(stopped.close);
  stopped.api.on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 2 } });
  assert.equal((await run({ sessionId: "c1", text: "hi" }, stopped.ctx)).outcome, "sent", "a stopped session resumes on the next message");
  const grok = await harness([chatSummary({ refId: "grok" })]); t.after(grok.close);
  grok.api.on("GET", "/api/agent/providers", { status: 200, body: { hostInstanceId: "h", providers: [{ id: "grok", refIds: ["grok"], installed: true, version: "1", status: "ready", auth: { status: "unknown" }, checkedAt: stamp(0), slashCommands: [], skills: [], models: [], capabilities: { sessionModelSwitch: "in-session", showPlanModeToggle: false, reportsContextWindow: true, compaction: { type: "slash-command", command: "/compact" } } }] } });
  await assert.rejects(run({ sessionId: "c1", text: "hi", planMode: true }, grok.ctx), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /plan mode/i.test(e.message));
  assert.ok(!h.api.calls.some((c) => c.method === "POST"));
});

test("send_message reports needs-input with the pending requests, and timeout", async (t) => {
  const h = await harness(); t.after(h.close);
  h.api.on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 4 } });
  const asked = snapshot({ pending: { approvals: [{ requestId: "r1", requestKind: "command", createdAt: stamp(5) }], userInputs: [] } });
  let posted = false;
  h.api.on("POST", "/api/sessions/c1/turn", () => { posted = true; return { status: 200, body: { seq: 4 } }; });
  h.api.on("GET", "/api/sessions/c1/thread", () => ({ status: 200, body: { kind: "snapshot", thread: { ...(posted ? asked : snapshot()), head: { ...snapshot().head, projectPath: h.projectPath, cwd: h.projectPath } } } }));
  const p = tool("send_message").run({ sessionId: "c1", text: "go", planMode: false, wait: true, timeoutMs: 5_000 }, h.ctx);
  await new Promise((r) => setTimeout(r, 5));
  h.api.emit(busEvent("session.updated", { ...chatSummary({ chatSessionStatus: "running", hasPendingApprovals: true }), projectPath: h.projectPath }));
  const r = await p;
  assert.equal(r.outcome, "needs-input"); assert.equal((r.pending as { approvals: { requestId: string }[] }).approvals[0].requestId, "r1"); assert.equal(r.reply, undefined);
  const slow = await harness(); t.after(slow.close);
  slow.api.on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 5 } });
  const to = await tool("send_message").run({ sessionId: "c1", text: "go", planMode: false, wait: true, timeoutMs: 20 }, slow.ctx);
  assert.equal(to.outcome, "timeout");
});

test("implement_plan sends the prefixed plan in default mode; refuses without an actionable plan", async (t) => {
  const planned = snapshot({ items: [activity("turn.proposed.completed", { planId: "p1", planMarkdown: "  # Plan\n1. do  " })] });
  const h = await harness([chatSummary({ hasActionableProposedPlan: true })], planned); t.after(h.close);
  h.api.on("POST", "/api/sessions/c1/turn", ({ body }) => { assert.deepEqual(body, { commandId: (body as { commandId: string }).commandId, input: "PLEASE IMPLEMENT THIS PLAN:\n# Plan\n1. do", interactionMode: "default" }); return { status: 200, body: { seq: 6 } }; });
  const r = await tool("implement_plan").run({ sessionId: "c1", wait: false, timeoutMs: 1000 }, h.ctx);
  assert.equal(r.outcome, "sent");
  const none = await harness(); t.after(none.close);
  await assert.rejects(tool("implement_plan").run({ sessionId: "c1", wait: false, timeoutMs: 1000 }, none.ctx), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
});

test("read_transcript projects the snapshot with defaults and validates agentId", async (t) => {
  const snap = snapshot({ items: [message("user", "hi"), message("reasoning", "hmm"), message("assistant", "yo")], roster: [{ id: "task-1", kind: "subagent", agentKind: "agent", title: "Explore", status: "completed" } as never] });
  const h = await harness([chatSummary()], snap); t.after(h.close);
  const r = await tool("read_transcript").run({ sessionId: "c1", turns: 3, include: ["tools", "activity"], maxChars: 40_000 }, h.ctx);
  assert.deepEqual((r.entries as { kind: string }[]).map((e) => e.kind), ["user", "assistant"]);
  assert.deepEqual(r.subagents, [{ id: "task-1", title: "Explore", status: "completed" }]);
  const withReasoning = await tool("read_transcript").run({ sessionId: "c1", turns: 3, include: ["reasoning"], maxChars: 40_000 }, h.ctx);
  assert.equal((withReasoning.entries as unknown[]).length, 3);
  await assert.rejects(tool("read_transcript").run({ sessionId: "c1", turns: 3, agentId: "nope", include: [], maxChars: 40_000 }, h.ctx), (e: { message: string }) => /task-1/.test(e.message));
});
```

- [ ] **Step 2: Run to verify failure** — `node --import tsx --test src/mcp/tools/messages.test.ts` → FAIL.

- [ ] **Step 3: Write the implementation**

`apps/daemon/src/mcp/tools/messages.ts`:
```ts
import { z } from "zod";
import type { SessionSummary } from "@orquester/api";
import { buildPlanImplementationPrompt, MAX_TURN_INPUT_CHARS, type AttachmentRef, type ThreadSnapshotPayload } from "@orquester/api/agent-chat";
import { attachmentInputSchema, uploadInlineAttachments } from "../attachments.ts";
import type { DaemonApi } from "../daemon-api.ts";
import { ToolError } from "../errors.ts";
import { readThread, requireChatSession, sendCommand } from "../reads.ts";
import { defineTool, MUTATING, READ_ONLY, type ToolContext, type ToolDef } from "../tool.ts";
import { transcriptEntries } from "../transcript.ts";
import { buildViewContext, chatDetail, type SessionDetail } from "../views.ts";
import { turnBaseline, waitForTurn, type TurnOutcome } from "../wait.ts";

const MAX_WAIT_MS = 600_000;
const sessionIdField = z.string().min(1).describe("The session id from list_sessions.");
const waitFields = {
  wait: z.boolean().default(true).describe("Block until the turn settles or the agent asks something (default true)."),
  timeoutMs: z.number().int().min(1_000).max(MAX_WAIT_MS).default(120_000).describe("How long to wait, in ms (max 600000). On timeout the turn keeps running.")
};

function pendingIds(snap: ThreadSnapshotPayload): { approvals: string[]; questions: string[] } {
  return { approvals: snap.pending.approvals.map((a) => a.requestId), questions: snap.pending.userInputs.map((q) => q.requestId) };
}

/** The send preconditions the GUI applies (spec §7.4). */
async function readyToSend(api: DaemonApi, summary: SessionSummary): Promise<ThreadSnapshotPayload> {
  if (summary.chatSessionStatus === "error") throw new ToolError("SESSION_BUSY", "This session's agent is in an error state. Call stop_session (or revert_session) first, then send again.");
  const snap = await readThread(api, summary.id);
  if (snap.pending.approvals.length || snap.pending.userInputs.length) {
    throw new ToolError("PENDING_REQUEST", "Answer the agent's pending request first (resolve_approval / answer_question / dismiss_question).", pendingIds(snap));
  }
  return snap;
}

interface SendResult { seq: number; outcome: TurnOutcome | "sent"; turnId?: string; reply?: string; replyTruncated?: boolean; pending?: SessionDetail["pending"]; session: SessionDetail }

async function dispatchTurn(ctx: ToolContext, summary: SessionSummary, body: { input: string; attachments?: AttachmentRef[]; interactionMode: "default" | "plan" }, wait: boolean, timeoutMs: number): Promise<SendResult> {
  const baseline = turnBaseline(summary);
  const { seq } = await sendCommand(ctx.api, summary.id, "turn", { input: body.input, ...(body.attachments?.length ? { attachments: body.attachments } : {}), interactionMode: body.interactionMode });
  if (!wait) return { seq, outcome: "sent", session: await chatDetail(ctx.api, summary.id) };
  const { outcome } = await waitForTurn(ctx.api, summary.id, baseline, { timeoutMs, signal: ctx.signal, now: ctx.now });
  const session = await chatDetail(ctx.api, summary.id);
  const result: SendResult = { seq, outcome, session };
  const reply = session.lastReply;
  if (reply && outcome !== "needs-input" && outcome !== "timeout" && (reply.turnId !== baseline.turnId || baseline.running)) {
    result.turnId = reply.turnId; result.reply = reply.text; if (reply.truncated) result.replyTruncated = true;
  }
  if (session.pending.approvals.length || session.pending.questions.length) result.pending = session.pending;
  return result;
}

const sendMessage = defineTool({
  name: "send_message",
  title: "Send a message",
  description: "Send a message to a chat session (with optional image/file attachments, optionally in plan mode). With wait:true (default) it returns the agent's reply, or the question/approval it stopped on. While a turn is running the message steers it.",
  input: {
    sessionId: sessionIdField,
    text: z.string().optional().describe("The message. Required unless attachments are given."),
    attachments: z.array(attachmentInputSchema).max(8).optional().describe("Up to 8: {path} inside the sandbox, or {name, base64, mimeType?}."),
    planMode: z.boolean().default(false).describe("Send in plan mode (the agent plans, does not edit). Only where the agent supports it; OpenCode uses options.agent=\"plan\"."),
    ...waitFields
  },
  annotations: MUTATING,
  async run(args, ctx) {
    const summary = await requireChatSession(ctx.api, args.sessionId);
    const text = (args.text ?? "").trim();
    if (!text && !args.attachments?.length) throw new ToolError("INVALID_ARGUMENT", "A message needs text or at least one attachment.");
    if (text.length > MAX_TURN_INPUT_CHARS) throw new ToolError("INVALID_ARGUMENT", `The message is ${text.length} characters; the limit is ${MAX_TURN_INPUT_CHARS}.`);
    await readyToSend(ctx.api, summary);
    if (args.planMode) {
      const view = await buildViewContext(ctx.api);
      const adapter = view.adapterByRefId.get(summary.refId);
      const caps = adapter ? view.capabilitiesByAdapter.get(adapter) : undefined;
      if (caps && !caps.showPlanModeToggle) throw new ToolError("INVALID_ARGUMENT", `${summary.refId} has no plan mode toggle${adapter === "opencode" ? ' — use update_session {options:{agent:"plan"}}' : ""}.`);
    }
    const attachments = args.attachments?.length ? await uploadInlineAttachments(ctx.api, args.sessionId, args.attachments) : [];
    return dispatchTurn(ctx, summary, { input: text, attachments, interactionMode: args.planMode ? "plan" : "default" }, args.wait, args.timeoutMs);
  }
});

function latestPlanMarkdown(snap: ThreadSnapshotPayload): string | null {
  for (let i = snap.items.length - 1; i >= 0; i -= 1) {
    const item = snap.items[i]!;
    if (item.kind === "activity" && item.activityKind === "turn.proposed.completed") return String((item.payload as { planMarkdown?: unknown }).planMarkdown ?? "");
  }
  return null;
}

const implementPlan = defineTool({
  name: "implement_plan",
  title: "Implement the proposed plan",
  description: "The GUI's Implement button: sends the agent's latest proposed plan back as 'PLEASE IMPLEMENT THIS PLAN' in default mode. To refine a plan instead, send_message with planMode:true.",
  input: { sessionId: sessionIdField, ...waitFields },
  annotations: MUTATING,
  async run(args, ctx) {
    const summary = await requireChatSession(ctx.api, args.sessionId);
    const snap = await readyToSend(ctx.api, summary);
    const plan = latestPlanMarkdown(snap);
    if (plan === null || !summary.hasActionableProposedPlan) throw new ToolError("INVALID_ARGUMENT", "This session has no actionable proposed plan (get_session.plan).");
    return dispatchTurn(ctx, summary, { input: buildPlanImplementationPrompt(plan), interactionMode: "default" }, args.wait, args.timeoutMs);
  }
});

const readTranscript = defineTool({
  name: "read_transcript",
  title: "Read the transcript",
  description: "What was said and done in a session, newest turns last: messages, tool calls, approvals, questions, plans, file changes, errors. `agentId` drills into one subagent's own timeline.",
  input: {
    sessionId: sessionIdField,
    turns: z.number().int().min(1).max(200).default(3).describe("How many of the latest turns to include."),
    agentId: z.string().optional().describe("A subagent id from get_session.subagents to read its own timeline."),
    include: z.array(z.enum(["reasoning", "tools", "activity"])).default(["tools", "activity"]).describe("Extra row kinds; reasoning is opt-in."),
    maxChars: z.number().int().min(2_000).max(90_000).default(40_000).describe("Result budget; older turns are shed first.")
  },
  annotations: READ_ONLY,
  async run(args, { api }) {
    await requireChatSession(api, args.sessionId);
    const snap = await readThread(api, args.sessionId);
    if (args.agentId && !snap.roster.some((r) => r.id === args.agentId) && !snap.items.some((i) => i.agentId === args.agentId)) {
      throw new ToolError("INVALID_ARGUMENT", `No subagent "${args.agentId}". Known: ${snap.roster.map((r) => r.id).join(", ") || "none"}.`);
    }
    return transcriptEntries(snap, { turns: args.turns, ...(args.agentId ? { agentId: args.agentId } : {}), include: new Set(args.include), maxChars: args.maxChars }) as unknown as Record<string, unknown>;
  }
});

export const messageTools: ToolDef[] = [sendMessage, implementPlan, readTranscript] as ToolDef[];
```

- [ ] **Step 4: Run the tests and typecheck** — `node --import tsx --test src/mcp/tools/messages.test.ts` → PASS; `pnpm check` → clean.

---

### Task 10: Request tools (`tools/requests.ts`)

Spec §7.5. Parallel with Tasks 7–9, 11.

**Files:**
- Create: `apps/daemon/src/mcp/tools/requests.ts`, `apps/daemon/src/mcp/tools/requests.test.ts`

**Interfaces:**
- Consumes: `pendingApprovalViews`, `pendingQuestionViews`, `chatDetail` (Task 3); `uploadInlineAttachments`, `attachmentInputSchema` (Task 6); `readThread`, `requireChatSession`, `sendCommand`.
- Produces: `export const requestTools: ToolDef[]` — `answer_question`, `dismiss_question`, `resolve_approval`.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/mcp/tools/requests.test.ts` (copy `harness()` and its constants from sessions.test.ts):
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { activity, chatSummary, snapshot, stamp } from "../fixtures.ts";
import { requestTools } from "./requests.ts";
// …harness() copied…

const tool = (name: string) => requestTools.find((t) => t.name === name)!;
const questions = [
  { id: "Which database?", header: "DB", question: "Which database?", options: [{ label: "Postgres", description: "pg" }, { label: "SQLite", description: "lite" }], multiSelect: false, allowCustomAnswer: true },
  { id: "Modules", header: "Modules", question: "Which modules?", options: [{ label: "Auth", description: "" }, { label: "Billing", description: "", value: "bill" }], multiSelect: true, allowCustomAnswer: false },
  { id: "Token", header: "Token", question: "API token?", options: [], multiSelect: false, allowCustomAnswer: true }
];
const asked = () => snapshot({
  items: [activity("user-input.requested", { requestId: "q1", dismissible: false, questions: [{ ...questions[0] }, { ...questions[1] }, { ...questions[2], isSecret: true }] })],
  pending: { approvals: [], userInputs: [{ requestId: "q1", createdAt: stamp(1), dismissible: false, questions }] }
});

test("answer_question encodes single, multi (values over labels), custom text and index keys, and posts one /answer", async (t) => {
  const h = await harness([chatSummary({ hasPendingUserInput: true })], asked()); t.after(h.close);
  h.api.on("POST", "/api/sessions/c1/answer", { status: 200, body: { seq: 30 } });
  const r = await tool("answer_question").run({ sessionId: "c1", answers: { "1": "Postgres", "Modules": ["Auth", "Billing"], "3": "sk-secret" } }, h.ctx);
  assert.equal(r.seq, 30);
  const body = h.api.calls.find((c) => c.path === "/api/sessions/c1/answer")!.body as Record<string, unknown>;
  assert.equal(body.requestId, "q1");
  assert.deepEqual(body.answers, { "Which database?": "Postgres", Modules: ["Auth", "bill"], Token: "sk-secret" });
  assert.equal(body.attachmentsByQuestionId, undefined);
});

test("answer_question: custom text where allowed, wrapped single→multi, unwrapped one-element arrays, case-insensitive labels", async (t) => {
  const h = await harness([chatSummary({ hasPendingUserInput: true })], asked()); t.after(h.close);
  h.api.on("POST", "/api/sessions/c1/answer", { status: 200, body: { seq: 31 } });
  await tool("answer_question").run({ sessionId: "c1", requestId: "q1", answers: { "Which database?": ["mysql"], Modules: "auth", Token: "none" } }, h.ctx);
  const body = h.api.calls.find((c) => c.path === "/api/sessions/c1/answer")!.body as { answers: Record<string, unknown> };
  assert.deepEqual(body.answers, { "Which database?": "mysql", Modules: ["Auth"], Token: "none" });
});

test("answer_question refusals: unanswered question, invalid selection without custom, secret with attachments, unknown key, wrong requestId, none pending", async (t) => {
  const h = await harness([chatSummary({ hasPendingUserInput: true })], asked()); t.after(h.close);
  const run = (a: Record<string, unknown>, ctx = h.ctx) => tool("answer_question").run({ sessionId: "c1", ...a }, ctx);
  await assert.rejects(run({ answers: { "1": "Postgres" } }), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /Modules/.test(e.message));
  await assert.rejects(run({ answers: { "1": "Postgres", Modules: ["Nope"], Token: "x" } }), (e: { message: string }) => /Auth, Billing/.test(e.message));
  await assert.rejects(run({ answers: { "1": "Postgres", Modules: ["Auth"], Token: "x" }, attachments: { Token: [{ name: "a.txt", base64: "YQ==" }] } }), (e: { message: string }) => /secret/i.test(e.message));
  await assert.rejects(run({ answers: { "1": "Postgres", Modules: ["Auth"], Token: "x", Bogus: "y" } }), (e: { message: string }) => /Bogus/.test(e.message));
  await assert.rejects(run({ requestId: "q9", answers: {} }), (e: { message: string }) => /q1/.test(e.message));
  const none = await harness(); t.after(none.close);
  await assert.rejects(run({ answers: {} }, none.ctx), (e: { message: string }) => /No pending question/.test(e.message));
  assert.ok(!h.api.calls.some((c) => c.method === "POST"));
});

test("answer_question uploads per-question attachments and allows attachment-only answers", async (t) => {
  const withFile = snapshot({ pending: { approvals: [], userInputs: [{ requestId: "q2", createdAt: stamp(1), dismissible: false, questions: [{ id: "Upload", header: "U", question: "Upload the log", options: [], multiSelect: false, allowCustomAnswer: true }] }] } });
  const h = await harness([chatSummary({ hasPendingUserInput: true })], withFile); t.after(h.close);
  h.api.on("POST", "/api/sessions/c1/answer", { status: 200, body: { seq: 32 } });
  await tool("answer_question").run({ sessionId: "c1", answers: {}, attachments: { Upload: [{ name: "app.log", base64: Buffer.from("x").toString("base64") }] } }, h.ctx);
  const body = h.api.calls.find((c) => c.path === "/api/sessions/c1/answer")!.body as { answers: Record<string, unknown>; attachmentsByQuestionId: Record<string, { name: string }[]> };
  assert.deepEqual(body.answers, { Upload: "" }); assert.equal(body.attachmentsByQuestionId.Upload[0].name, "app.log");
});

test("dismiss_question only for message-mode questions; resolve_approval validates the decision", async (t) => {
  const async_ = snapshot({ pending: { approvals: [{ requestId: "r1", requestKind: "command", createdAt: stamp(1), options: [{ decision: "accept", label: "Approve" }, { decision: "decline", label: "Decline" }] }],
    userInputs: [{ requestId: "q3", createdAt: stamp(1), dismissible: true, responseMode: "message", questions: [{ id: "x", header: "H", question: "X?", options: [], multiSelect: false, allowCustomAnswer: true }] }] } });
  const h = await harness([chatSummary({ hasPendingUserInput: true, hasPendingApprovals: true })], async_); t.after(h.close);
  h.api.on("POST", "/api/sessions/c1/dismiss", { status: 200, body: { seq: 40 } }).on("POST", "/api/sessions/c1/approval", { status: 200, body: { seq: 41 } });
  assert.equal((await tool("dismiss_question").run({ sessionId: "c1" }, h.ctx)).seq, 40);
  assert.deepEqual((h.api.calls.find((c) => c.path === "/api/sessions/c1/dismiss")!.body as { requestId: string }).requestId, "q3");
  const r = await tool("resolve_approval").run({ sessionId: "c1", decision: "decline" }, h.ctx);
  assert.equal(r.seq, 41);
  assert.deepEqual((h.api.calls.find((c) => c.path === "/api/sessions/c1/approval")!.body as { requestId: string; decision: string }), { commandId: (h.api.calls.find((c) => c.path === "/api/sessions/c1/approval")!.body as { commandId: string }).commandId, requestId: "r1", decision: "decline" } as never);
  await assert.rejects(tool("resolve_approval").run({ sessionId: "c1", decision: "acceptAlways" }, h.ctx), (e: { message: string }) => /accept, decline/.test(e.message));
  const blocking = await harness([chatSummary({ hasPendingUserInput: true })], asked()); t.after(blocking.close);
  await assert.rejects(tool("dismiss_question").run({ sessionId: "c1" }, blocking.ctx), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /interrupt_session/.test(e.message));
});
```

- [ ] **Step 2: Run to verify failure** — `node --import tsx --test src/mcp/tools/requests.test.ts` → FAIL.

- [ ] **Step 3: Write the implementation**

`apps/daemon/src/mcp/tools/requests.ts`:
```ts
import { z } from "zod";
import type { ApprovalDecision, AttachmentRef } from "@orquester/api/agent-chat";
import { attachmentInputSchema, uploadInlineAttachments, type AttachmentInput } from "../attachments.ts";
import { ToolError } from "../errors.ts";
import { readThread, requireChatSession, sendCommand } from "../reads.ts";
import { defineTool, MUTATING, type ToolDef } from "../tool.ts";
import { chatDetail, pendingApprovalViews, pendingQuestionViews, type PendingQuestionView } from "../views.ts";

const sessionIdField = z.string().min(1).describe("The session id from list_sessions.");
const requestIdField = z.string().optional().describe("The request id from get_session; may be omitted when exactly one is pending.");

function pick<T extends { requestId: string }>(rows: T[], requestId: string | undefined, noun: string): T {
  if (requestId) {
    const hit = rows.find((r) => r.requestId === requestId);
    if (!hit) throw new ToolError("INVALID_ARGUMENT", `No pending ${noun} with requestId "${requestId}". Pending: ${rows.map((r) => r.requestId).join(", ") || "none"}.`);
    return hit;
  }
  if (rows.length === 1) return rows[0]!;
  if (!rows.length) throw new ToolError("INVALID_ARGUMENT", `No pending ${noun} on this session.`);
  throw new ToolError("INVALID_ARGUMENT", `Several ${noun}s are pending; pass requestId (${rows.map((r) => r.requestId).join(", ")}).`);
}

type Q = PendingQuestionView["questions"][number];

function optionValue(q: Q, text: string): string | undefined {
  const exact = q.options.find((o) => o.value === text || o.label === text);
  const loose = exact ?? q.options.find((o) => o.label.toLowerCase() === text.toLowerCase() || o.value?.toLowerCase() === text.toLowerCase());
  return loose ? (loose.value ?? loose.label) : undefined;
}

/** Encode one question's answer exactly as the GUI card does (spec §7.5). */
function encodeAnswer(q: Q, raw: string | string[] | undefined, hasAttachments: boolean): string | string[] | undefined {
  if (raw === undefined) return hasAttachments ? "" : undefined;
  const list = Array.isArray(raw) ? raw : [raw];
  const valid = q.options.map((o) => o.label).join(", ");
  if (q.multiSelect) {
    if (Array.isArray(raw) || optionValue(q, list[0] ?? "") !== undefined) {
      const values = list.map((item) => { const v = optionValue(q, item); if (v === undefined) throw new ToolError("INVALID_ARGUMENT", `"${item}" is not an option of "${q.header}". Options: ${valid}.${q.allowCustomAnswer ? " Pass a string for a custom answer." : ""}`); return v; });
      return values;
    }
    if (!q.allowCustomAnswer) throw new ToolError("INVALID_ARGUMENT", `"${raw}" is not an option of "${q.header}". Options: ${valid}.`);
    return String(raw).trim();
  }
  if (list.length !== 1) throw new ToolError("INVALID_ARGUMENT", `"${q.header}" takes one answer.`);
  const text = list[0]!;
  const v = optionValue(q, text);
  if (v !== undefined) return v;
  if (!q.allowCustomAnswer || !text.trim()) throw new ToolError("INVALID_ARGUMENT", `"${text}" is not an option of "${q.header}". Options: ${valid}.`);
  return text.trim();
}

const answerQuestion = defineTool({
  name: "answer_question",
  title: "Answer the agent's question",
  description: "Answer a pending AskUserQuestion-style request: keys are question ids (or 1-based indexes) from get_session; a string picks an option or gives a custom answer, an array picks several (multiSelect). Attachments per question are optional. Works for Codex's async questions too.",
  input: {
    sessionId: sessionIdField,
    requestId: requestIdField,
    answers: z.record(z.union([z.string(), z.array(z.string())])).describe("questionId (or index) → answer."),
    attachments: z.record(z.array(attachmentInputSchema).max(8)).optional().describe("questionId (or index) → attachments.")
  },
  annotations: MUTATING,
  async run(args, { api }) {
    await requireChatSession(api, args.sessionId);
    const snap = await readThread(api, args.sessionId);
    const req = pick(pendingQuestionViews(snap), args.requestId, "question");
    const lookup = <T,>(map: Record<string, T> | undefined, q: Q): T | undefined => map?.[q.id] ?? map?.[String(q.index)];
    const known = new Set(req.questions.flatMap((q) => [q.id, String(q.index)]));
    for (const key of [...Object.keys(args.answers), ...Object.keys(args.attachments ?? {})]) {
      if (!known.has(key)) throw new ToolError("INVALID_ARGUMENT", `"${key}" is not a question of this request. Questions: ${req.questions.map((q) => `${q.index}: ${q.id}`).join(" | ")}.`);
    }
    const answers: Record<string, string | string[]> = {};
    const attachmentsByQuestionId: Record<string, AttachmentRef[]> = {};
    const missing: string[] = [];
    for (const q of req.questions) {
      const files = lookup<AttachmentInput[]>(args.attachments, q);
      if (files?.length && q.isSecret) throw new ToolError("INVALID_ARGUMENT", `"${q.header}" is a secret field and takes no attachments.`);
      const encoded = encodeAnswer(q, lookup(args.answers, q), Boolean(files?.length));
      if (encoded === undefined) { missing.push(q.header || q.question); continue; }
      answers[q.id] = encoded;
      if (files?.length) attachmentsByQuestionId[q.id] = await uploadInlineAttachments(api, args.sessionId, files);
    }
    if (missing.length) throw new ToolError("INVALID_ARGUMENT", `Every question must be answered. Missing: ${missing.join(", ")}.`);
    const { seq } = await sendCommand(api, args.sessionId, "answer", { requestId: req.requestId, answers, ...(Object.keys(attachmentsByQuestionId).length ? { attachmentsByQuestionId } : {}) });
    return { seq, session: await chatDetail(api, args.sessionId) };
  }
});

const dismissQuestion = defineTool({
  name: "dismiss_question",
  title: "Dismiss a question",
  description: "Close a dismissible (message-mode / async) question without answering it. A blocking question cannot be dismissed — answer it or interrupt_session.",
  input: { sessionId: sessionIdField, requestId: requestIdField },
  annotations: MUTATING,
  async run(args, { api }) {
    await requireChatSession(api, args.sessionId);
    const snap = await readThread(api, args.sessionId);
    const req = pick(pendingQuestionViews(snap), args.requestId, "question");
    if (!req.dismissible) throw new ToolError("INVALID_ARGUMENT", `Question "${req.requestId}" blocks the agent and cannot be dismissed; answer it with answer_question or stop the turn with interrupt_session.`);
    const { seq } = await sendCommand(api, args.sessionId, "dismiss", { requestId: req.requestId });
    return { seq, session: await chatDetail(api, args.sessionId) };
  }
});

const resolveApproval = defineTool({
  name: "resolve_approval",
  title: "Resolve a tool approval",
  description: "Answer a pending tool-permission request with one of its offered decisions (get_session lists them). Quirks: on Claude acceptAlways denies; on OpenCode acceptForSession/acceptAlways both mean 'always' for the whole directory.",
  input: { sessionId: sessionIdField, requestId: requestIdField, decision: z.enum(["accept", "acceptForSession", "acceptAlways", "decline", "cancel"]).describe("The decision.") },
  annotations: MUTATING,
  async run(args, { api }) {
    await requireChatSession(api, args.sessionId);
    const snap = await readThread(api, args.sessionId);
    const req = pick(pendingApprovalViews(snap), args.requestId, "approval");
    if (!req.decisions.some((d) => d.decision === args.decision)) {
      throw new ToolError("INVALID_ARGUMENT", `"${args.decision}" is not offered for this request. Offered: ${req.decisions.map((d) => d.decision).join(", ")}.`);
    }
    const { seq } = await sendCommand(api, args.sessionId, "approval", { requestId: req.requestId, decision: args.decision as ApprovalDecision });
    return { seq, session: await chatDetail(api, args.sessionId) };
  }
});

export const requestTools: ToolDef[] = [answerQuestion, dismissQuestion, resolveApproval] as ToolDef[];
```

- [ ] **Step 4: Run the tests and typecheck** — `node --import tsx --test src/mcp/tools/requests.test.ts` → PASS; `pnpm check` → clean.

---

### Task 11: Watch and usage tools (`tools/watch.ts`, `tools/usage.ts`)

Spec §7.7, §7.8, §9.2. Parallel with Tasks 7–10.

**Files:**
- Create: `apps/daemon/src/mcp/tools/watch.ts`, `watch.test.ts`, `apps/daemon/src/mcp/tools/usage.ts`, `usage.test.ts`

**Interfaces:**
- Consumes: `waitForAttention` (Task 5), `buildViewContext`/`sessionView` (Task 3), `usageView` (Task 4), `resolveProject`, `findSession`, `expectOk`.
- Produces: `export const watchTools: ToolDef[]` (`wait_for_session`), `export const usageTools: ToolDef[]` (`get_usage`, `get_cost`).

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/mcp/tools/watch.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { busEvent, FakeDaemonApi } from "../testing.ts";
import { chatSummary, stamp } from "../fixtures.ts";
import type { ToolContext } from "../tool.ts";
import { watchTools } from "./watch.ts";

const tool = watchTools[0]!;
const registry = { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [{ id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } }] };
function ctx(api: FakeDaemonApi): ToolContext { return { api, todos: {} as never, files: {} as never, signal: new AbortController().signal, now: () => Date.parse("2026-09-22T12:00:00.000Z") }; }
function api(sessions: unknown[]) {
  return new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: sessions }).on("GET", "/api/registry", { status: 200, body: registry })
    .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [], defaults: {} } }).on("GET", "/api/agent/providers", { status: 503, body: null });
}

test("wait_for_session returns flagged sessions after the cursor, newest first, with a new cursor", async () => {
  const a = chatSummary({ id: "a", activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(5) } });
  const b = chatSummary({ id: "b", hasPendingApprovals: true, activity: { state: "waiting", attention: "needs-input", lastOutputAt: null, needsAttentionAt: stamp(7) } });
  const r = await tool.run({ after: stamp(1), timeoutMs: 1000 }, ctx(api([a, b])));
  assert.deepEqual((r.sessions as { id: string; reason: string }[]).map((s) => [s.id, s.reason]), [["b", "approval"], ["a", "completed"]]);
  assert.equal(r.cursor, stamp(7)); assert.equal(r.timedOut, false);
  const again = await tool.run({ after: r.cursor as string, timeoutMs: 20 }, ctx(api([a, b])));
  assert.deepEqual(again, { sessions: [], cursor: stamp(7), timedOut: true });
});

test("wait_for_session defaults `after` to now, honours session and project filters, and rejects both", async (t) => {
  const stale = chatSummary({ id: "a", activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(5) } });
  assert.equal((await tool.run({ timeoutMs: 20 }, ctx(api([stale])))).timedOut, true, "an old finish before `now` does not count");
  const fresh = { ...stale, activity: { ...stale.activity!, needsAttentionAt: "2026-09-22T12:00:01.000Z" } };
  const live = api([stale]);
  const p = tool.run({ sessionId: "a", timeoutMs: 1000 }, ctx(live));
  await new Promise((r) => setTimeout(r, 5));
  live.on("GET", "/api/sessions", { status: 200, body: [fresh] });
  live.emit(busEvent("session.activity", { id: "a", activity: fresh.activity }));
  const r = await p;
  assert.deepEqual((r.sessions as { id: string }[]).map((s) => s.id), ["a"]); assert.equal(r.cursor, "2026-09-22T12:00:01.000Z");
  const root = await mkdtemp(join(tmpdir(), "mcp-watch-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "acme", "api"), { recursive: true });
  const elsewhere = { ...fresh, projectPath: "/w/other" };
  const proj = api([elsewhere]); proj.fsRoot = root; proj.workspacesDir = root;
  assert.equal((await tool.run({ project: "acme/api", after: stamp(0), timeoutMs: 20 }, ctx(proj))).timedOut, true, "another project's session is not watched");
  assert.equal((await tool.run({ after: stamp(0), timeoutMs: 20 }, ctx(proj))).timedOut, false);
  await assert.rejects(tool.run({ sessionId: "a", project: "x/y", timeoutMs: 1000 }, ctx(api([stale]))), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  await assert.rejects(tool.run({ sessionId: "zz", timeoutMs: 1000 }, ctx(api([stale]))), (e: { code: string }) => e.code === "SESSION_NOT_FOUND");
});
```
(Imports for this file: add `import { mkdtemp, mkdir, rm } from "node:fs/promises"; import { tmpdir } from "node:os"; import { join } from "node:path";`.)

`apps/daemon/src/mcp/tools/usage.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeDaemonApi } from "../testing.ts";
import type { ToolContext } from "../tool.ts";
import { usageTools } from "./usage.ts";

const tool = (name: string) => usageTools.find((t) => t.name === name)!;
const ctx = (api: FakeDaemonApi): ToolContext => ({ api, todos: {} as never, files: {} as never, signal: new AbortController().signal, now: () => Date.parse("2026-09-22T12:00:00.000Z") });

test("get_usage passes refresh through and joins accounts", async () => {
  const api = new FakeDaemonApi()
    .on("GET", "/api/usage", ({ query }) => ({ status: 200, body: { agents: [{ id: "codex", available: true, stale: false, plan: "Pro", session: null, weekly: { percent: 34, resetsAt: "2026-09-23T20:38:00.000Z" }, asOf: "2026-09-22T11:50:00.000Z", accounts: [{ id: "acc-2", label: "therealeduard465", available: true, stale: false, plan: "Pro", session: null, weekly: { percent: 34, resetsAt: "2026-09-23T20:38:00.000Z" }, asOf: "2026-09-22T11:50:00.000Z" }], refreshed: query?.refresh === "1" }] } }))
    .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [{ id: "acc-2", agent: "codex", label: "therealeduard465", email: "e@x.io", plan: null, needsReauth: false, createdAt: "", importedAt: "" }], defaults: {} } });
  const r = await tool("get_usage").run({ refresh: true }, ctx(api));
  assert.deepEqual(api.calls[0].query, { refresh: "1" });
  const agent = (r.agents as { name: string; accounts: { label: string; email: string; windows: { label: string; percentUsed: number; resetsIn: string }[] }[] }[])[0];
  assert.equal(agent.name, "Codex"); assert.equal(agent.accounts[0].email, "e@x.io"); assert.deepEqual(agent.accounts[0].windows[0], { id: "weekly", label: "Week", percentUsed: 34, resetsAt: "2026-09-23T20:38:00.000Z", resetsIn: "1d 8h 38m" });
  await tool("get_usage").run({ refresh: false }, ctx(api));
  assert.equal(api.calls.at(-2)!.query, undefined);
});

test("get_cost windows the rows to the last N UTC days and totals them", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/usage/tokens", { status: 200, body: { asOf: "2026-09-22T11:00:00.000Z", rows: [
    { agent: "claude", model: "opus", day: "2026-09-22", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.5, costSource: "api_equivalent" },
    { agent: "claude", model: "opus", day: "2026-09-21", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5, costSource: "api_equivalent" },
    { agent: "codex", model: "gpt", day: "2026-09-01", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 9, costSource: "api_equivalent" }
  ] } });
  const r = await tool("get_cost").run({ days: 7 }, ctx(api));
  assert.equal(r.days, 7); assert.equal(r.totalUsd, 2); assert.deepEqual(r.byDay, [{ day: "2026-09-21", usd: 0.5 }, { day: "2026-09-22", usd: 1.5 }]);
  assert.equal((r.rows as unknown[]).length, 2); assert.equal(r.asOf, "2026-09-22T11:00:00.000Z");
});
```

- [ ] **Step 2: Run to verify failure** — `node --import tsx --test src/mcp/tools/watch.test.ts src/mcp/tools/usage.test.ts` → FAIL.

- [ ] **Step 3: Write the implementations**

`apps/daemon/src/mcp/tools/watch.ts`:
```ts
import { z } from "zod";
import type { SessionSummary } from "@orquester/api";
import { resolveProject } from "../addressing.ts";
import { ToolError } from "../errors.ts";
import { findSession } from "../reads.ts";
import { defineTool, READ_ONLY, type ToolDef } from "../tool.ts";
import { buildViewContext, sessionView } from "../views.ts";
import { waitForAttention } from "../wait.ts";

const waitForSession = defineTool({
  name: "wait_for_session",
  title: "Wait for a session to need you",
  description: "Block until a session (or any session of a project, or any at all) needs attention — a question, an approval, a plan to review, a finished turn, an error — after `after`. Pass the returned `cursor` as the next call's `after` so nothing is missed or repeated. Never poll: call this instead.",
  input: {
    sessionId: z.string().optional().describe("Watch one session."),
    project: z.string().optional().describe("Watch every session of this project (path or \"workspace/project\")."),
    after: z.string().optional().describe("ISO timestamp; only attention raised after it counts. Default: now. Use the previous result's cursor."),
    timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000).describe("How long to wait (ms, max 600000).")
  },
  annotations: READ_ONLY,
  async run(args, { api, signal, now }) {
    if (args.sessionId && args.project) throw new ToolError("INVALID_ARGUMENT", "Pass sessionId or project, not both.");
    let select: (s: SessionSummary) => boolean = () => true;
    if (args.sessionId) { const id = (await findSession(api, args.sessionId)).id; select = (s) => s.id === id; }
    else if (args.project) { const path = (await resolveProject(api, args.project)).path; select = (s) => s.projectPath === path; }
    const after = args.after ?? new Date(now()).toISOString();
    if (Number.isNaN(Date.parse(after))) throw new ToolError("INVALID_ARGUMENT", "`after` must be an ISO-8601 timestamp.");
    const r = await waitForAttention(api, { select, after, timeoutMs: args.timeoutMs, signal, now });
    const ctx = await buildViewContext(api);
    const stamp = (s: SessionSummary) => s.activity?.needsAttentionAt ?? s.createdAt;
    const sessions = [...r.sessions].sort((a, b) => (stamp(a) < stamp(b) ? 1 : stamp(a) > stamp(b) ? -1 : a.createdAt < b.createdAt ? 1 : -1)).map((s) => sessionView(s, ctx));
    return { sessions, cursor: r.cursor, timedOut: r.timedOut };
  }
});

export const watchTools: ToolDef[] = [waitForSession] as ToolDef[];
```

`apps/daemon/src/mcp/tools/usage.ts`:
```ts
import { z } from "zod";
import type { AgentAccountsResponse, UsageResponse, UsageTokensResponse } from "@orquester/api";
import { expectOk } from "../errors.ts";
import { defineTool, READ_ONLY, type ToolDef } from "../tool.ts";
import { usageView } from "../usage-view.ts";

const getUsage = defineTool({
  name: "get_usage",
  title: "Get subscription usage",
  description: "Quota per agent family and per managed account — the 5h, weekly and per-model (e.g. Fable) windows as % USED with reset times — exactly as the usage widget shows them. An absent family is not signed in; stale:true with no asOf means no reading yet. refresh:true may still return last-known data; never call it in a loop.",
  input: { refresh: z.boolean().default(false).describe("Ask the daemon to re-fetch before answering.") },
  annotations: READ_ONLY,
  async run(args, { api, now }) {
    const usage = expectOk<UsageResponse>(await api.request("GET", "/api/usage", args.refresh ? { query: { refresh: "1" } } : undefined), "usage");
    const accountsRes = await api.request("GET", "/api/agent-accounts");
    const accounts = accountsRes.status < 400 ? (accountsRes.body as AgentAccountsResponse).accounts ?? [] : [];
    return usageView(usage, accounts, now()) as unknown as Record<string, unknown>;
  }
});

const getCost = defineTool({
  name: "get_cost",
  title: "Get estimated cost",
  description: "API-equivalent cost estimate per agent, model and UTC day from local transcripts (the usage widget's Cost tab), for the last N days.",
  input: { days: z.number().int().min(1).max(90).default(7).describe("How many UTC days back, including today.") },
  annotations: READ_ONLY,
  async run(args, { api, now }) {
    const res = expectOk<UsageTokensResponse>(await api.request("GET", "/api/usage/tokens"), "cost");
    const today = new Date(now());
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (args.days - 1))).toISOString().slice(0, 10);
    const rows = res.rows.filter((r) => r.day >= start).map((r) => ({ agent: r.agent, model: r.model, day: r.day, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens, costUsd: r.costUsd }));
    const byDayMap = new Map<string, number>();
    for (const r of rows) byDayMap.set(r.day, (byDayMap.get(r.day) ?? 0) + (r.costUsd ?? 0));
    const byDay = [...byDayMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, usd]) => ({ day, usd: Math.round(usd * 10_000) / 10_000 }));
    const totalUsd = Math.round(byDay.reduce((sum, d) => sum + d.usd, 0) * 10_000) / 10_000;
    return { asOf: res.asOf, days: args.days, totalUsd, byDay, rows };
  }
});

export const usageTools: ToolDef[] = [getUsage, getCost] as ToolDef[];
```

- [ ] **Step 4: Run the tests and typecheck** — `node --import tsx --test src/mcp/tools/watch.test.ts src/mcp/tools/usage.test.ts` → PASS; `pnpm check` → clean.

---

### Task 12: Server, mount, todo/file tools and the mount test (`server.ts`, `tools/todos.ts`, `tools/files.ts`, `index.ts`)

Spec §4.1, §4.5, §7.9, §10, §12 (mount test). Runs after Tasks 7–11.

**Files:**
- Create: `apps/daemon/src/mcp/tools/todos.ts`, `apps/daemon/src/mcp/tools/files.ts`
- Rewrite: `apps/daemon/src/mcp/server.ts` (the Task-2 stub), create `apps/daemon/src/mcp/server.test.ts`
- Modify: `apps/daemon/src/mcp/result.ts` (add the `TodoError` mapping — Task 2 is complete by now), `apps/daemon/src/mcp/todo-tools.ts` (final import/`ToolError` codes check only)
- Modify: `apps/daemon/src/index.ts` (the `if (options.mode === "remote")` mount block, ~line 4627)

**Interfaces:**
- Produces: `McpDeps { createApi(authorization: string | undefined): DaemonApi; todos: TodoTools; files: FsTools; now?: () => number }`, `SERVER_INSTRUCTIONS`, `SERVER_VERSION = "2.0.0"`, `allTools(): ToolDef[]`, `buildServer(deps, authorization, signal): McpServer`, `registerMcp(app, deps)`.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/mcp/server.test.ts` (the `mcpApp`/`postMcp` helpers are the old test's, recovered with `git show abf8f04:apps/daemon/src/mcp/server.test.ts`):
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { chatSummary } from "./fixtures.ts";
import { FakeDaemonApi } from "./testing.ts";
import { allTools, registerMcp, SERVER_INSTRUCTIONS } from "./server.ts";

const EXPECTED_TOOLS = ["list_projects", "list_agents", "list_conversations", "list_sessions", "get_session", "get_turn_diff", "create_session", "update_session", "interrupt_session", "stop_session", "close_session", "revert_session", "compact_session", "send_message", "implement_plan", "read_transcript", "answer_question", "dismiss_question", "resolve_approval", "wait_for_session", "get_usage", "get_cost", "list_files", "read_file", "list_todos", "create_todo", "update_todo", "delete_todo", "toggle_todo_item"];

function mcpApp(api: FakeDaemonApi) {
  const app = Fastify();
  registerMcp(app, { createApi: () => api, todos: {} as never, files: {} as never });
  app.addHook("preHandler", async (request) => { (request.raw as unknown as { destroyed: boolean }).destroyed = true; });
  return app;
}
async function postMcp(app: ReturnType<typeof Fastify>, payload: unknown) {
  const response = await app.inject({ method: "POST", url: "/mcp", headers: { accept: "application/json, text/event-stream", "content-type": "application/json", authorization: "Bearer abc" }, payload });
  assert.equal(response.statusCode, 200, response.body);
  return JSON.parse(response.body);
}

test("tools/list is exactly the 29 spec tools, each with a title, annotations and described params", async () => {
  const app = mcpApp(new FakeDaemonApi());
  try {
    const list = await postMcp(app, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const tools = list.result.tools as { name: string; title?: string; description: string; annotations?: object; inputSchema: { properties?: Record<string, { description?: string }> } }[];
    assert.deepEqual(tools.map((t) => t.name), EXPECTED_TOOLS);
    for (const t of tools) {
      assert.ok(t.title, `${t.name} has a title`); assert.ok(t.annotations, `${t.name} has annotations`);
      assert.ok(t.description.length <= 600, `${t.name} description is ${t.description.length} chars`);
      assert.doesNotMatch(t.description, /❯|Escape|keystroke/i, `${t.name} carries no TUI guidance`);
      for (const [p, s] of Object.entries(t.inputSchema.properties ?? {})) assert.ok(s.description, `${t.name}.${p} is described`);
    }
    assert.equal(allTools().length, EXPECTED_TOOLS.length);
  } finally { await app.close(); }
});

test("a tool call returns structuredContent + text; a ToolError becomes isError with a code; the api is built with the caller's bearer", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [chatSummary()] })
    .on("GET", "/api/registry", { status: 200, body: { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [] } })
    .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [], defaults: {} } }).on("GET", "/api/agent/providers", { status: 503, body: null });
  let seenAuth: string | undefined;
  const app = Fastify();
  registerMcp(app, { createApi: (authorization) => { seenAuth = authorization; return api; }, todos: {} as never, files: {} as never });
  app.addHook("preHandler", async (request) => { (request.raw as unknown as { destroyed: boolean }).destroyed = true; });
  try {
    const r = await postMcp(app, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_sessions", arguments: { kind: "all" } } });
    assert.equal(seenAuth, "Bearer abc");
    assert.equal(r.result.structuredContent.sessions[0].id, "c1");
    assert.equal(JSON.parse(r.result.content[0].text).sessions[0].id, "c1");
    const e = await postMcp(app, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_session", arguments: { sessionId: "nope" } } });
    assert.equal(e.result.isError, true); assert.equal(e.result.structuredContent.code, "SESSION_NOT_FOUND"); assert.match(e.result.content[0].text, /^SESSION_NOT_FOUND: /);
  } finally { await app.close(); }
});

test("GET and DELETE /mcp answer 405 with Allow: POST", async () => {
  const app = mcpApp(new FakeDaemonApi());
  try {
    for (const method of ["GET", "DELETE"] as const) {
      const res = await app.inject({ method, url: "/mcp" });
      assert.equal(res.statusCode, 405); assert.equal(res.headers.allow, "POST"); assert.equal(JSON.parse(res.body).error.message, "Method not allowed.");
    }
  } finally { await app.close(); }
});

test("SERVER_INSTRUCTIONS stays under the ~2KB budget and names the load-bearing rules", () => {
  assert.ok(SERVER_INSTRUCTIONS.length <= 2048, `${SERVER_INSTRUCTIONS.length} chars`);
  for (const needle of ["list_agents", "wait_for_session", "cursor", "% USED", "sessionId"]) assert.ok(SERVER_INSTRUCTIONS.includes(needle), needle);
});
```

Also add to `apps/daemon/src/mcp/result.test.ts` (Task 2's file; append):
```ts
import { TodoError } from "../todos.ts";
test("TodoError maps its status to a code", () => {
  assert.equal(toSafeToolError(new TodoError(404, "todo not found")).structuredContent.code, "NOT_FOUND");
  assert.equal(toSafeToolError(new TodoError(400, "bad")).structuredContent.code, "INVALID_ARGUMENT");
});
```

- [ ] **Step 2: Run to verify failure** — `node --import tsx --test src/mcp/server.test.ts src/mcp/result.test.ts` → FAIL.

- [ ] **Step 3: Write the implementation**

`apps/daemon/src/mcp/tools/todos.ts`:
```ts
import { z } from "zod";
import { resolveProject } from "../addressing.ts";
import { ToolError } from "../errors.ts";
import { defineTool, DESTRUCTIVE, MUTATING, MUTATING_IDEMPOTENT, READ_ONLY, type ToolContext, type ToolDef } from "../tool.ts";

const scopeFields = {
  workspace: z.string().optional().describe("Workspace name for a workspace-wide list."),
  project: z.string().optional().describe("Absolute project path or \"workspace/project\" for a project list.")
};
async function scope(ctx: ToolContext, args: { workspace?: string; project?: string }): Promise<{ workspace: string; project?: string }> {
  if (Boolean(args.workspace) === Boolean(args.project)) throw new ToolError("INVALID_ARGUMENT", "Pass exactly one of workspace or project.");
  if (args.project) {
    const ref = await resolveProject(ctx.api, args.project);
    if (!ref.workspace || !ref.name) throw new ToolError("PROJECT_NOT_FOUND", "Todo lists need a project inside a workspace.");
    return { workspace: ref.workspace, project: ref.name };
  }
  return { workspace: args.workspace as string };
}
const idField = z.string().min(1).describe("The todo list id.");

const listTodos = defineTool({ name: "list_todos", title: "List todo lists", description: "Shared todo lists of a workspace or project — the human sees them live in the Todo tab.", input: scopeFields, annotations: READ_ONLY,
  async run(args, ctx) { return { todos: ctx.todos.list(await scope(ctx, args)) }; } });
const createTodo = defineTool({ name: "create_todo", title: "Create a todo list", description: "Create a shared todo list in a workspace or project. The body starts empty; fill it with update_todo.", input: { ...scopeFields, name: z.string().min(1).describe("List name.") }, annotations: MUTATING,
  async run(args, ctx) { return { todo: await ctx.todos.create(await scope(ctx, args), args.name) }; } });
const updateTodo = defineTool({ name: "update_todo", title: "Update a todo list", description: "Rename a list and/or replace its whole markdown body ('- [ ] item' lines). To tick ONE item use toggle_todo_item (atomic).", input: { id: idField, name: z.string().min(1).optional().describe("New name."), body: z.string().optional().describe("New markdown body.") }, annotations: MUTATING_IDEMPOTENT,
  async run(args, ctx) { return { todo: await ctx.todos.update(args.id, { name: args.name, body: args.body }) }; } });
const deleteTodo = defineTool({ name: "delete_todo", title: "Delete a todo list", description: "Delete a todo list.", input: { id: idField }, annotations: DESTRUCTIVE,
  async run(args, ctx) { await ctx.todos.remove(args.id); return { deleted: true, id: args.id }; } });
const toggleTodoItem = defineTool({ name: "toggle_todo_item", title: "Toggle a todo item", description: "Atomically check/uncheck one task item by 1-based index or exact text; omit `checked` to flip.", input: { id: idField, item: z.union([z.string(), z.number().int().min(1)]).describe("Item text or 1-based index."), checked: z.boolean().optional().describe("Target state; omit to flip.") }, annotations: MUTATING_IDEMPOTENT,
  async run(args, ctx) { return { ...(await ctx.todos.toggleItem(args.id, args.item, args.checked)) }; } });

export const todoTools: ToolDef[] = [listTodos, createTodo, updateTodo, deleteTodo, toggleTodoItem] as ToolDef[];
```

`apps/daemon/src/mcp/tools/files.ts`:
```ts
import { z } from "zod";
import { DEFAULT_READ_BYTES, MAX_READ_BYTES } from "../fs-tools.ts";
import { defineTool, READ_ONLY, type ToolDef } from "../tool.ts";

const listFiles = defineTool({ name: "list_files", title: "List files", description: "List a directory inside the workspaces sandbox (absolute, or relative to the sandbox root). Capped at 500 entries (truncated:true beyond).", input: { path: z.string().min(1).describe("Directory path.") }, annotations: READ_ONLY,
  async run(args, ctx) { return { ...(await ctx.files.listFiles(args.path)) }; } });
const readFile = defineTool({ name: "read_file", title: "Read a file", description: `Read a text file inside the workspaces sandbox with byte-offset paging (offset/maxBytes; default ${DEFAULT_READ_BYTES} bytes, max ${MAX_READ_BYTES}). truncated:true means advance offset and read again. Binary files are refused.`,
  input: { path: z.string().min(1).describe("File path."), offset: z.number().int().min(0).optional().describe("Byte offset to start from."), maxBytes: z.number().int().min(1).max(MAX_READ_BYTES).optional().describe("Bytes to read.") }, annotations: READ_ONLY,
  async run(args, ctx) { return { ...(await ctx.files.readFileWindow(args.path, { offset: args.offset, maxBytes: args.maxBytes })) }; } });

export const fileTools: ToolDef[] = [listFiles, readFile] as ToolDef[];
```

`apps/daemon/src/mcp/result.ts` — add, before the generic branch of `toSafeToolError`:
```ts
  } else if (err instanceof TodoError) {
    code = err.status === 404 ? "NOT_FOUND" : err.status === 409 ? "CONFLICT" : "INVALID_ARGUMENT";
    message = err.message;
```
(`import { TodoError } from "../todos.ts";` — check `TodoError`'s status property name in `apps/daemon/src/todos.ts` and use it.)

`apps/daemon/src/mcp/server.ts`:
```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { DaemonApi } from "./daemon-api.ts";
import type { FsTools } from "./fs-tools.ts";
import { ok, toSafeToolError } from "./result.ts";
import type { TodoTools } from "./todo-tools.ts";
import type { ToolContext, ToolDef } from "./tool.ts";
import { catalogTools } from "./tools/catalog.ts";
import { fileTools } from "./tools/files.ts";
import { messageTools } from "./tools/messages.ts";
import { requestTools } from "./tools/requests.ts";
import { sessionTools } from "./tools/sessions.ts";
import { todoTools } from "./tools/todos.ts";
import { usageTools } from "./tools/usage.ts";
import { watchTools } from "./tools/watch.ts";

/** 16 MiB: inline base64 attachments (spec §8.2). */
const MCP_BODY_LIMIT = 16 * 1024 * 1024;

export interface McpDeps {
  /** Built per request with the caller's `Authorization` header (spec §4.2). */
  createApi: (authorization: string | undefined) => DaemonApi;
  todos: TodoTools;
  files: FsTools;
  now?: () => number;
}

export const SERVER_VERSION = "2.0.0";

/** ≤ 2 KB: Claude Code truncates server instructions around there; the load-bearing rules also live in each tool description. */
export const SERVER_INSTRUCTIONS = `Orquester MCP drives Orquester's agent chat sessions (Claude Code, Codex, OpenCode, Grok) exactly like the chat GUI. Addressing: sessions by sessionId (list_sessions); projects by absolute path or "workspace/project" (list_projects). Start with list_agents to learn valid models, options (effort…), permission modes and accounts. create_session opens a tab (or resumes a conversation from list_conversations); send_message talks to it — wait:true (default) returns the reply or the question/approval it stopped on; while a turn runs a message steers it. get_session shows status (status/attention/reason), pending questions and approvals with their ids and options, the proposed plan, subagents and the context meter; read_transcript shows what was said and done (agentId drills into a subagent). answer_question / resolve_approval / dismiss_question act on pending requests; implement_plan is the GUI's Implement button. update_session changes model, effort/options, permission mode, account or title. wait_for_session blocks until a session needs you — pass its cursor back as \`after\`; never poll in a loop. Attachments are inline ({path} in the sandbox or {name, base64}). get_usage percentages are % USED. Errors carry a code (SESSION_BUSY, PENDING_REQUEST, INVALID_ARGUMENT…) and a message naming the fix.`;

export function allTools(): ToolDef[] {
  return [...catalogTools, ...sessionTools, ...messageTools, ...requestTools, ...watchTools, ...usageTools, ...fileTools, ...todoTools];
}

/** Build a per-request McpServer with every tool bound to the caller's DaemonApi. */
export function buildServer(deps: McpDeps, authorization: string | undefined, signal: AbortSignal): McpServer {
  const server = new McpServer({ name: "orquester", version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const ctx: ToolContext = { api: deps.createApi(authorization), todos: deps.todos, files: deps.files, signal, now: deps.now ?? (() => Date.now()) };
  for (const tool of allTools()) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: tool.annotations }, (async (args: Record<string, unknown>) => {
      try {
        return ok(await tool.run(args as never, ctx));
      } catch (error) {
        return toSafeToolError(error);
      }
    }) as never);
  }
  return server;
}

const METHOD_NOT_ALLOWED = { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null };

/** Mount POST /mcp (Streamable HTTP, stateless). The caller registers this ONLY on the HTTP transport. */
export function registerMcp(app: FastifyInstance, deps: McpDeps): void {
  app.post("/mcp", { bodyLimit: MCP_BODY_LIMIT }, async (request, reply) => {
    // …the pre-existing handler body, recovered verbatim from
    // `git show abf8f04:apps/daemon/src/mcp/server.ts` (lines 218-241), with
    // `buildServer(deps, ctrl.signal)` replaced by
    // `buildServer(deps, request.headers.authorization, ctrl.signal)`.
  });
  const notAllowed = async (_request: FastifyRequest, reply: FastifyReply) => reply.code(405).header("allow", "POST").send(METHOD_NOT_ALLOWED);
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
}
```

`apps/daemon/src/index.ts` mount block (replace the Task-2 stub call):
```ts
  // Orquester MCP — HTTP-only. The unix socket is unauthenticated, so full
  // session drive must never be reachable there; register /mcp only on remote.
  if (options.mode === "remote") {
    registerMcp(app, {
      createApi: (authorization) =>
        new InjectDaemonApi({
          app,
          authorization,
          agentChat: services.agentChat ?? null,
          broadcaster: services.broadcaster,
          fsRoot: resolved.fsRoot,
          workspacesDir: resolved.workspacesDir
        }),
      todos: new TodoTools({ todos, workspacesDir: resolved.workspacesDir }),
      files: new FsTools({ fsRoot: resolved.fsRoot })
    });
  }
```
with `import { InjectDaemonApi } from "./mcp/daemon-api.ts";` added beside the existing `registerMcp`/`TodoTools`/`FsTools` imports (`services.agentChat`'s exact property name/type: read the `DaemonServices` interface near `index.ts:1753`).

- [ ] **Step 4: Run the tests, the whole suite and typecheck** — `node --import tsx --test src/mcp/server.test.ts src/mcp/result.test.ts` → PASS; `pnpm --filter @orquester/daemon test` → PASS; `pnpm check` → clean.

---

### Task 13: Documentation

Spec §11. Runs after Task 12.

**Files:**
- Create: `docs/orquester-mcp.md`
- Delete: `docs/terminal-control-mcp.md`
- Modify: `AGENTS.md` (an "Orquester MCP" subsection at the end of "Agent chat GUI", a "Where to look first" row, and the stale `/mcp` mention in the PWA paragraph stays as is), `README.md` (the two pointers at lines ~76-77 and ~120 now name `docs/orquester-mcp.md`)

- [ ] **Step 1: Write `docs/orquester-mcp.md`** with these sections, in this order (prose, no placeholders):
  1. *What it is* — one paragraph: the MCP drives chat sessions like the GUI; no terminal I/O; 29 tools.
  2. *Prerequisites and endpoint* — keep §1 of the old doc (HTTP-only, `https://<domain>/mcp` / `http://127.0.0.1:47831/mcp`, `POST`, Streamable HTTP stateless, `Accept` header, `GET`/`DELETE` → 405).
  3. *Authentication* — keep §2 of the old doc verbatim (`compute-bearer.mjs`).
  4. *Install into a client* — keep §3 verbatim.
  5. *Addressing* — `sessionId` from `list_sessions`; `project` as absolute path or `workspace/project`.
  6. *The tools* — one table per group (catalogue, sessions, messages, requests, waiting, usage, files, todos) with columns Tool · Input · Returns · GUI equivalent, generated from the descriptions in `allTools()` (run `node --import tsx -e 'import("./apps/daemon/src/mcp/server.ts").then(m => console.log(m.allTools().map(t => t.name + ": " + t.description).join("\n")))'` from the repo root to list them) plus the §6 view shapes copied from the spec (`SessionView`, `SessionDetail`, pending views).
  7. *Workflows* — three worked examples with real JSON: (a) open a Claude session, send a message with `wait`, read the reply; (b) supervise a project: `wait_for_session` loop with the cursor, then `get_session` → `answer_question` / `resolve_approval`; (c) attachments and plan mode: `send_message` with a base64 image in `planMode:true`, then `implement_plan`.
  8. *Waiting semantics* — the §9 rules in user terms (what `outcome` means; the cursor contract; timeouts leave the turn running).
  9. *Attachments* — §8 limits; non-image files arrive to the agent as `Attached file: <name> (<path>)` lines.
  10. *Safety & things to know* — keep the old §8 with "keystrokes" wording replaced by "messages and commands".
  11. *Troubleshooting* — keep the old §9 table minus the selector/AmbiguousTab/tab-limit rows; keep the "stale tool guidance until a fresh `claude` session" row.
- [ ] **Step 2: Update `AGENTS.md`**: add a subsection "**Orquester MCP** (`apps/daemon/src/mcp/`)" after the agent chat gotchas: what it is (in-process REST client via `fastify.inject`, HTTP-only, 29 tools mirroring the GUI), the two invariants (tools never touch services directly — only `DaemonApi`; waits ride the `Broadcaster`, never sleeps), the addressing rules, and "tool docs: `docs/orquester-mcp.md`; design: the v2 spec". Add the row `| Orquester MCP (tools, in-process client, waits) | \`apps/daemon/src/mcp/server.ts\`, \`…/daemon-api.ts\`, \`…/wait.ts\`, \`…/tools/\` |` to "Where to look first". Also add under the Claude gotchas one bullet from Task 14: "**Registry `args` are the terminal launcher's flags and never reach a chat launch** — permissions come only from `runtimeMode`, `full-access` = `bypassPermissions`; effort only from the model selection."
- [ ] **Step 3: Update `README.md`** pointers; `git rm docs/terminal-control-mcp.md`.
- [ ] **Step 4: Verify** — `grep -rn "terminal-control-mcp" --include=*.md . | grep -v node_modules` → no hits; `pnpm check` → clean.

---

### Task 14: Host fix — permission mode is the only authority (registry args never reach a chat launch)

Collateral finding §14.1 of the spec; the user's explicit request. Independent of Tasks 1–13 (host files only). Verdict of the audit: Claude-family chats always ran `bypassPermissions` and always got the registry's `--effort max|high`; Codex, Grok and OpenCode already honour the mode (`--yolo` never reaches `codex app-server` / `grok agent stdio`, and would crash them if it did).

**Files:**
- Modify: `apps/daemon/src/agent-host/main.ts:161-175` (`buildRefIdIndex`: drop `args`), `:499` (delete `launchArgsForRefId`)
- Modify: `apps/daemon/src/agent-host/orchestration/orchestrator.ts:211-216` (delete the `launchArgsForRefId` option), `:978-994` (delete `launchArgs` from the `startSession` call)
- Modify: `apps/daemon/src/agent-host/adapter.ts:54-61` (delete `launchArgs` from `StartSessionInput`)
- Modify: `apps/daemon/src/agent-host/adapters/claude/index.ts:281-284` (stop forwarding `launchArgs`), `adapters/claude/session.ts:154, 272` (drop the field), `adapters/claude/launch.ts` (delete `parseClaudeLaunchArgs` and the `skipPermissions`/`permissionMode`-from-args fold at ~98-124 and ~190-194; `permissionMode` becomes `RUNTIME_MODE_TO_PERMISSION_MODE[input.runtimeMode]`; `extraArgs` keeps ONLY what the adapter adds itself — e.g. `thinking-display` — never registry flags; fix the comments at ~83-88, ~187-189)
- Modify: `apps/daemon/src/agent-host/adapters/codex/session.ts:127-128, 322` (delete the unused `launchArgs` option; the spawn is exactly `["app-server"]`)
- Modify: `apps/daemon/src/agent-host/adapters/grok/launch.ts:268-293` (the per-thread `GROK_CONFIG_PATH` overlay: also pin the UI permission mode per runtime mode — see Step 3)
- Tests: `adapters/claude/lifecycle.test.ts:1532-1544`, `adapters/claude/launch.test.ts:256-283`, `orchestration/orchestrator.test.ts:1390-1398`, `adapters/grok/launch.test.ts` (or wherever the overlay is tested)
- Docs: `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md` §4.5 (a *Built:* note under the Claude and Codex launch lines)

**Interfaces:** none new. `StartSessionInput` loses `launchArgs`; `RUNTIME_MODE_TO_PERMISSION_MODE` is unchanged (`full-access` → `bypassPermissions`, plus `allowDangerouslySkipPermissions: true` — that is the flag's whole effect, so full access keeps its meaning).

- [ ] **Step 1: Write the failing tests**

In `adapters/claude/launch.test.ts` replace the block at 256-283 with:
```ts
test("permissions come only from the runtime mode; effort only from the model selection", () => {
  const base = { threadId: "t", projectPath: "/p", cwd: "/p", home: { kind: "system" as const, path: "/home/u" }, title: "x", interactionMode: "default" as const };
  const supervised = buildClaudeQueryOptions({ ...base, runtimeMode: "approval-required", modelSelection: { model: "default", options: [{ id: "effort", value: "low" }] } });
  assert.equal(supervised.permissionMode, undefined);
  assert.equal(supervised.allowDangerouslySkipPermissions, undefined);
  assert.equal(supervised.effort, "low");
  assert.equal((supervised.extraArgs as Record<string, unknown> | undefined)?.effort, undefined);
  assert.equal((supervised.extraArgs as Record<string, unknown> | undefined)?.["dangerously-skip-permissions"], undefined);
  const full = buildClaudeQueryOptions({ ...base, runtimeMode: "full-access", modelSelection: { model: "default" } });
  assert.equal(full.permissionMode, "bypassPermissions");
  assert.equal(full.allowDangerouslySkipPermissions, true);
  const edits = buildClaudeQueryOptions({ ...base, runtimeMode: "auto-accept-edits", modelSelection: { model: "default" } });
  assert.equal(edits.permissionMode, "acceptEdits");
});
```
(Adapt the input literal to `buildClaudeQueryOptions`'s real parameter type — read `launch.ts` first; the assertions are the contract.) Delete `lifecycle.test.ts:1532-1544` ("launchArgs reach the query and fold into the permission mode") and replace it with a test that `startSession` under `runtimeMode: "approval-required"` produces query options **without** `permissionMode`/`allowDangerouslySkipPermissions`, using the same harness the deleted test used. Delete or rename `orchestrator.test.ts:1390-1398` ("hands the registry entry's launch args to startSession") — replace with "startSession receives no launch args" asserting the `startSession` input has no `launchArgs` key.

- [ ] **Step 2: Run them to verify they fail** — `node --import tsx --test src/agent-host/adapters/claude/launch.test.ts src/agent-host/adapters/claude/lifecycle.test.ts src/agent-host/orchestration/orchestrator.test.ts` (from `apps/daemon`) → the new tests FAIL.

- [ ] **Step 3: Make the change**

1. `main.ts`: `buildRefIdIndex` returns `{ adapter, bins }` only; delete `launchArgsForRefId`.
2. `orchestrator.ts`: delete the option and the `...(launchArgs.length > 0 ? { launchArgs } : {})` spread.
3. `adapter.ts`: delete `launchArgs` from `StartSessionInput` and its doc comment; add one sentence to the interface doc: "Registry `args` are the terminal launcher's flags; a chat launch never sees them. Permissions come only from `runtimeMode`."
4. Claude: `launch.ts` — `const permissionMode = RUNTIME_MODE_TO_PERMISSION_MODE[input.runtimeMode];` is the only derivation; delete `parseClaudeLaunchArgs` and every reference; keep the adapter-authored `extraArgs` (grep `extraArgs` to see what the adapter itself sets — keep those). `index.ts`/`session.ts` — remove the field plumbing. Update the three comments.
5. Codex: delete `launchArgs` from `session.ts` options and the spawn spread.
6. Grok overlay: in `launch.ts:268-293`, add to the per-thread config overlay a `[ui] permission_mode = "<value>"` line where value is `default` (approval-required), `acceptEdits` (auto-accept-edits), `auto` (auto), `always-approve` (full-access) — **verify the accepted spellings first** against `grok --help` / `grok agent --help` and `apps/daemon/test/fixtures/grok/README.md:26-37` (the fixtures were captured with a project config pinning `permission_mode = "default"`; this host's `~/.grok/config.toml` sets `always-approve`). If the key or a value cannot be confirmed from those sources, do not write the overlay line for that mode; leave a comment naming what was verified. Add a test asserting the overlay content per mode.
7. Spec: add under §4.5 Claude ("Launch line" or equivalent) and Codex: *Built: registry `args` (`--dangerously-skip-permissions`, `--effort …`, `--yolo`) are the TERMINAL launcher's flags and never reach a chat launch (`agent-host/main.ts` builds its refId index without them). Permissions come only from `runtimeMode`; `full-access` = `bypassPermissions` + `allowDangerouslySkipPermissions`; effort only from the model selection.*

- [ ] **Step 4: Run the adapter and orchestration suites, then everything** — `pnpm --filter @orquester/daemon test` → PASS (fixture replay tests included); `pnpm check` → clean. Search for any remaining `launchArgs` under `apps/daemon/src/agent-host`: `grep -rn launchArgs apps/daemon/src/agent-host` → no hits.

---

### Task 15: Host fix — non-image attachments reach every provider as path lines

Spec §8.4; the user's explicit request. Independent of Tasks 1–13 (host files only); must not run concurrently with Task 14 on `orchestrator.ts` — run Task 14 first (or the other way round), never both at once.

**Files:**
- Create: `apps/daemon/src/agent-host/orchestration/attachment-lines.ts`, `attachment-lines.test.ts`
- Modify: `apps/daemon/src/agent-host/adapter.ts` (add `ingestsAttachment(attachment: AttachmentRef): boolean` to `AgentAdapter`, next to `pendingSnapshot`; update the `SendTurnInput` doc: `input` = text + one `Attached file:` line per non-native attachment; `attachments` = only the native ones, with the stat'd size)
- Modify: `apps/daemon/src/agent-host/orchestration/slash.ts:55-57` (`providerInputFor(text, attachmentLines = "")` → `appendAttachmentLines`)
- Modify: `apps/daemon/src/agent-host/orchestration/orchestrator.ts`: replace `assertAttachmentWithinBounds` (1582-1610) with `resolveTurnAttachments`; resolve + partition at the top of `sendTurnEffect` (~1299) and pass `{ input: providerInputFor(turn.input, attachmentPathLines(flattened)), attachments: native }` (~1319-1325); delete `verifyAttachments` from `decide("turn")` (1815-1857 → `void runEffect(runtime, () => sendTurnEffect(runtime, queuedTurn))`); message-mode answer line at 1530 → `Attached file: <name>` (no id); native answer fold at 1554-1569 → `attachmentPathLine` / `unavailableAttachmentLine`
- Modify: `adapters/claude/session.ts` (~117: `export function claudeIngestsAttachment`; loop at 1533-1541 uses it; drop the unreachable throw; fix the comment), `adapters/claude/index.ts` (~502: `ingestsAttachment: claudeIngestsAttachment`), `adapters/claude/launch.ts:254-256` (comment)
- Modify: `adapters/codex/session.ts` (`export const codexIngestsAttachment = (a: AttachmentRef) => a.type === "image"`; use at 452-457; comment), `adapters/codex/index.ts` (~392)
- Modify: `adapters/opencode/session.ts` (`export function openCodeIngestsAttachment` wrapping lines 1625-1631 incl. the 20 MiB cap; used in `buildFileParts`; comments at 101 and 1633), `adapters/opencode/index.ts` (class method)
- Modify: `adapters/grok/index.ts` (`ingestsAttachment(): boolean { return false; }`; delete the resolution at 312-321 and the `attachments` pass-through; widen or drop the length guard at 295-297), `adapters/grok/session.ts` (delete the `attachments?` parameter at 666 and the block at 720-731)
- Modify: `apps/daemon/src/agent-host/orchestration/testing/scripted-adapter.ts:47-61, 133` (option `ingestsAttachment?`, default `() => false`)
- Tests: new `attachment-lines.test.ts`; extend `orchestration/validate.test.ts:109-113`, `orchestration/orchestrator.test.ts` (turn, file-only, slash+file, steer 171-187, queued 455-507, message-mode answer 1071-1110, native answer 1231-1267), `orchestration/fix-wave.test.ts:346-383`, `adapters/claude/lifecycle.test.ts:536-594`, `adapters/codex/session.test.ts:201-219`, `adapters/opencode/session.test.ts:~532-577`, `adapters/grok/lifecycle.test.ts:533-556`
- Docs: spec §4.1 / §6.2 *Built:* notes; `apps/daemon/src/agent-host/README.md` module map row for `attachment-lines.ts`

**Interfaces:**
```ts
// orchestration/attachment-lines.ts (pure, no I/O)
export interface ResolvedAttachment { readonly ref: AttachmentRef; readonly path: string }   // ref.sizeBytes = the STAT'd size
export const ATTACHMENT_LINE_NAME_MAX_CHARS = 255;
export const ATTACHMENT_LINES_MAX_CHARS: number;   // 8 lines × (name cap + path room), for Grok's guard
export function attachmentLineName(name: string): string;           // control chars → space, collapse, trim, cap at 255, "attachment" when empty
export function attachmentPathLine(entry: ResolvedAttachment): string;   // `Attached file: <name> (<absolute path>)`
export function unavailableAttachmentLine(ref: AttachmentRef): string;   // `Attached file: <name> (not available)`
export function attachmentPathLines(entries: readonly ResolvedAttachment[]): string;   // joined with "\n"
export function appendAttachmentLines(text: string, lines: string): string;   // "" → lines; else `${text}\n\n${lines}`; lines "" → text
export function partitionAttachments(resolved: readonly ResolvedAttachment[], ingests: (a: AttachmentRef) => boolean): { native: AttachmentRef[]; flattened: ResolvedAttachment[] };   // one pass, order kept
// adapter.ts
ingestsAttachment(attachment: AttachmentRef): boolean;   // required, synchronous, pure; judged on the stat'd sizeBytes
```

- [ ] **Step 1: Write the failing tests**

`orchestration/attachment-lines.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendAttachmentLines, attachmentLineName, attachmentPathLine, attachmentPathLines, partitionAttachments, unavailableAttachmentLine } from "./attachment-lines.ts";
import { isSlashInvocation, providerInputFor } from "./slash.ts";

const pdf = { ref: { type: "file" as const, id: "a1", name: "report.pdf", mimeType: "application/pdf", sizeBytes: 10 }, path: "/appdir/daemon/agent/threads/t/attachments/a1.pdf" };
const png = { ref: { type: "image" as const, id: "a2", name: "shot.png", mimeType: "image/png", sizeBytes: 5 }, path: "/appdir/daemon/agent/threads/t/attachments/a2.png" };

test("the canonical line format", () => {
  assert.equal(attachmentPathLine(pdf), "Attached file: report.pdf (/appdir/daemon/agent/threads/t/attachments/a1.pdf)");
  assert.equal(unavailableAttachmentLine(pdf.ref), "Attached file: report.pdf (not available)");
  assert.equal(attachmentPathLines([pdf, png]), `${attachmentPathLine(pdf)}\n${attachmentPathLine(png)}`);
});
test("names are flattened, capped and never empty", () => {
  assert.equal(attachmentLineName("a\nb c"), "a b c");
  assert.equal(attachmentLineName("   "), "attachment");
  assert.equal([...attachmentLineName("x".repeat(300))].length, 255);
});
test("lines go AFTER the text, so a slash command still dispatches", () => {
  assert.equal(appendAttachmentLines("", "L"), "L");
  assert.equal(appendAttachmentLines("hi", "L"), "hi\n\nL");
  assert.equal(appendAttachmentLines("hi", ""), "hi");
  assert.equal(providerInputFor("/review src", "L"), "/review src\n\nL");
  assert.equal(isSlashInvocation(providerInputFor("/review", "L")), true);
});
test("partition keeps order and splits on the predicate", () => {
  const r = partitionAttachments([pdf, png], (a) => a.type === "image");
  assert.deepEqual(r.native, [png.ref]); assert.deepEqual(r.flattened, [pdf]);
});
```
Then the orchestrator/adapter assertions listed in the investigator's §5, verbatim as behaviours:
- orchestrator turn test: an image + `report.pdf` → `lastTurn.input === "summarise\n\nAttached file: report.pdf (<dir>/report.pdf)"` and `lastTurn.attachments` = only the image with the stat'd size (use `createScriptedAdapter({ id: "claude", ingestsAttachment: (a) => a.type === "image" })` and real temp files via `putAttachment({ sourcePath })` as `fix-wave.test.ts:346-383` does);
- file-only turn → `input === "Attached file: data.csv (<dir>/data.csv)"`;
- `/review` + file → input still starts with `/review`;
- steer, queued-behind-compaction and message-mode answer → their `sendTurn` input contains the line; the message-mode answer's input is `"Which branch?\nmain\nAttached file: notes.md\n\nAttached file: notes.md (<path>)"` and the persisted `thread.message-sent` text contains no path;
- native answer expectation at `orchestrator.test.ts:1253` → `/^main\n\nAttached file: notes\.md \(\/tmp\/notes\.md\)$/`;
- `fix-wave.test.ts`: queued and message-mode paths with an oversized file record "Attachment rejected" and call no `sendTurn`;
- Claude: a host line stays inside the LAST text block; `claudeIngestsAttachment` true for a supported image, false for pdf/text/unknown-mime image;
- Codex: `codexIngestsAttachment` true only for `type:"image"`; a host line is forwarded verbatim;
- OpenCode: `openCodeIngestsAttachment` true for png / `text/csv` / pdf ≤ 20 MiB, false for zip, no type, or a 21 MiB pdf; parts are `[text, file(pdf)]` when the input carries a zip line;
- Grok: the echoed prompt contains the host's line verbatim and never `Attached files:`; `ingestsAttachment(image) === false`.

- [ ] **Step 2: Run to verify failure** — `node --import tsx --test src/agent-host/orchestration/attachment-lines.test.ts` (module missing) and the touched suites → FAIL.

- [ ] **Step 3: Make the change** — the module exactly as the interface above (`ATTACHMENT_LINES_MAX_CHARS = 8 * (ATTACHMENT_LINE_NAME_MAX_CHARS + 512)`), then the orchestrator, adapter and test-adapter edits listed under **Files**, in that order. `resolveTurnAttachments(threadId, refs)` does what `assertAttachmentWithinBounds` did (resolve → stat → size check against `MAX_TURN_IMAGE_BYTES` / `MAX_TURN_FILE_BYTES`, throwing `invalidCommand`) and returns `{ ref: { ...ref, sizeBytes: statSize }, path }[]`; a failure inside `sendTurnEffect` appends the existing "Attachment rejected" `provider.turn.start.failed` activity and returns. Grok's length guard at `index.ts:295-297` widens to `MAX_TURN_INPUT_CHARS + ATTACHMENT_LINES_MAX_CHARS`. Spec *Built:* notes: §4.1 (attachment delivery: native vs path line, the predicate) and §6.2 (the message-mode echo drops the id). README module map row.

- [ ] **Step 4: Run everything** — `pnpm --filter @orquester/daemon test` → PASS; `pnpm check` → clean; `grep -rn "already flattened\|flattened into the prompt" apps/daemon/src/agent-host` → no hits (the wrong comments are gone).

---

### Task 16: Final verification and whole-tree review

Runs last, after every other task.

- [ ] **Step 1:** `pnpm check` → clean. `pnpm test` (root) → every package passes. Paste the tail of both outputs into the task report.
- [ ] **Step 2:** `git status --short` — confirm the deletions (`mcp/terminal-control*.ts`, `mcp/keys*.ts`, `scripts/mcp-spike.ts`, `docs/terminal-control-mcp.md`), the move (`terminal-text.ts`), and that nothing under `.stage/` or `deploy/` changed. Nothing is committed.
- [ ] **Step 3:** Print the tool list once more (`node --import tsx -e 'import("./apps/daemon/src/mcp/server.ts").then(m => console.log(m.allTools().map(t => t.name).join("\n")))'`) and check it equals the spec's 29 (§7.10).
- [ ] **Step 4:** `grep -rn "PROMPT_HINT\|read_terminal\|send_keys\|wait_for_idle\|TerminalControl" apps packages docs AGENTS.md README.md --include=*.ts --include=*.tsx --include=*.md | grep -v node_modules` → only the v2 spec's audit section (§3) and this plan may mention them.
- [ ] **Step 5:** Hand the whole working tree to a fresh reviewer (spec compliance + code quality) per the subagent-driven-development skill; fix what it finds; re-run Step 1.
