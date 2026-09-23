import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDaemonApi } from "../testing.ts";
import { activity, chatSummary, shellSummary, snapshot, stamp } from "../fixtures.ts";
import type { ToolContext } from "../tool.ts";
import { requestTools } from "./requests.ts";

// harness() and its constants are copied from sessions.test.ts: the tool test files never import each other.
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
  const root = await mkdtemp(join(tmpdir(), "mcp-req-"));
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

test("answer_question validates every question before uploading any attachment", async (t) => {
  const two = snapshot({ pending: { approvals: [], userInputs: [{ requestId: "q5", createdAt: stamp(1), dismissible: false, questions: [
    { id: "Log", header: "Log", question: "Attach the log", options: [], multiSelect: false, allowCustomAnswer: true },
    { id: "Why", header: "Why", question: "Why did it fail?", options: [], multiSelect: false, allowCustomAnswer: true }
  ] }] } });
  const h = await harness([chatSummary({ hasPendingUserInput: true })], two); t.after(h.close);
  await assert.rejects(tool("answer_question").run({ sessionId: "c1", answers: {}, attachments: { Log: [{ name: "app.log", base64: "YQ==" }] } }, h.ctx),
    (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /Missing: Why\./.test(e.message));
  assert.equal(h.api.uploads.length, 0);
  assert.ok(!h.api.calls.some((c) => c.method === "POST"));
});

test("answer_question keys: an exact id beats a 1-based index, and a question named twice is refused", async (t) => {
  const numbered = snapshot({ pending: { approvals: [], userInputs: [{ requestId: "q6", createdAt: stamp(1), dismissible: false, questions: [
    { id: "2", header: "Ship", question: "Ship it?", options: [{ label: "Yes", description: "" }, { label: "No", description: "" }], multiSelect: false, allowCustomAnswer: false },
    { id: "Env", header: "Env", question: "Which env?", options: [{ label: "prod", description: "" }, { label: "staging", description: "" }], multiSelect: false, allowCustomAnswer: false }
  ] }] } });
  const h = await harness([chatSummary({ hasPendingUserInput: true })], numbered); t.after(h.close);
  h.api.on("POST", "/api/sessions/c1/answer", { status: 200, body: { seq: 33 } });
  const run = (answers: Record<string, unknown>) => tool("answer_question").run({ sessionId: "c1", answers }, h.ctx);
  // "2" is the first question's id, so it never reaches the second question by index.
  await assert.rejects(run({ "2": "Yes" }), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /Missing: Env\./.test(e.message));
  // "1" (its index) and "2" (its id) both name the first question.
  await assert.rejects(run({ "1": "Yes", "2": "No", Env: "prod" }), (e: { message: string }) => /"Ship" is named twice/.test(e.message));
  assert.ok(!h.api.calls.some((c) => c.method === "POST"));
  await run({ "2": "No", Env: "staging" });
  const body = h.api.calls.find((c) => c.path === "/api/sessions/c1/answer")!.body as { answers: Record<string, unknown> };
  assert.deepEqual(body.answers, { "2": "No", Env: "staging" });
});

test("answer_question reports every problem at once, treats blank answers as unanswered, dedupes selections and takes files only where the GUI offers them", async (t) => {
  const h = await harness([chatSummary({ hasPendingUserInput: true })], asked()); t.after(h.close);
  h.api.on("POST", "/api/sessions/c1/answer", { status: 200, body: { seq: 34 } });
  const run = (a: Record<string, unknown>) => tool("answer_question").run({ sessionId: "c1", ...a }, h.ctx);
  await assert.rejects(run({ answers: { "1": "Postgres", Modules: ["Nope"] } }), (e: { message: string }) => /"Nope" is not an option of "Modules"/.test(e.message) && /Missing: Token\./.test(e.message));
  await assert.rejects(run({ answers: { "1": "  ", Modules: [], Token: "x" } }), (e: { message: string }) => /Missing: DB, Modules\./.test(e.message));
  // The GUI offers no attachments on an options-only question (`allowsAnswerAttachments`).
  await assert.rejects(run({ answers: { "1": "Postgres", Modules: ["Auth"], Token: "x" }, attachments: { Modules: [{ name: "a.txt", base64: "YQ==" }] } }), (e: { message: string }) => /"Modules" takes only its listed options/.test(e.message));
  assert.equal(h.api.uploads.length, 0);
  assert.ok(!h.api.calls.some((c) => c.method === "POST"));
  await run({ answers: { "1": "Postgres", Modules: ["Auth", "auth", "bill"], Token: "x" } });
  const body = h.api.calls.find((c) => c.path === "/api/sessions/c1/answer")!.body as { answers: Record<string, unknown> };
  assert.deepEqual(body.answers.Modules, ["Auth", "bill"]);
});

test("answer_question: a blank answer beside files is attachment-only, and a failed upload names its question and sends nothing", async (t) => {
  const withFile = snapshot({ pending: { approvals: [], userInputs: [{ requestId: "q2", createdAt: stamp(1), dismissible: false, questions: [{ id: "Upload", header: "U", question: "Upload the log", options: [], multiSelect: false, allowCustomAnswer: true }] }] } });
  const h = await harness([chatSummary({ hasPendingUserInput: true })], withFile); t.after(h.close);
  h.api.on("POST", "/api/sessions/c1/answer", { status: 200, body: { seq: 35 } });
  const run = (a: Record<string, unknown>) => tool("answer_question").run({ sessionId: "c1", ...a }, h.ctx);
  await assert.rejects(run({ answers: { Upload: "see the log" }, attachments: { Upload: [{ name: "app.log", base64: "not base64!!" }] } }),
    (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /^Attachments for "U": .*malformed/.test(e.message));
  assert.ok(!h.api.calls.some((c) => c.method === "POST"));
  await run({ answers: { Upload: " " }, attachments: { Upload: [{ name: "app.log", base64: "YQ==" }] } });
  const body = h.api.calls.find((c) => c.path === "/api/sessions/c1/answer")!.body as { answers: Record<string, unknown>; attachmentsByQuestionId: Record<string, { name: string }[]> };
  assert.deepEqual(body.answers, { Upload: "" }); assert.deepEqual(body.attachmentsByQuestionId.Upload.map((a) => a.name), ["app.log"]);
});

test("resolve_approval lists every pending id when several are open, and resolves the one requested", async (t) => {
  const two = snapshot({ pending: { userInputs: [], approvals: [{ requestId: "r1", requestKind: "command", createdAt: stamp(1) }, { requestId: "r2", requestKind: "file-change", createdAt: stamp(2) }] } });
  const h = await harness([chatSummary({ hasPendingApprovals: true })], two); t.after(h.close);
  h.api.on("POST", "/api/sessions/c1/approval", { status: 200, body: { seq: 42 } });
  await assert.rejects(tool("resolve_approval").run({ sessionId: "c1", decision: "accept" }, h.ctx), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /r1, r2/.test(e.message));
  // No advertised options: the default four apply, so acceptForSession is offered.
  assert.equal((await tool("resolve_approval").run({ sessionId: "c1", requestId: "r2", decision: "acceptForSession" }, h.ctx)).seq, 42);
  const body = h.api.calls.find((c) => c.path === "/api/sessions/c1/approval")!.body as { requestId: string; decision: string };
  assert.equal(body.requestId, "r2"); assert.equal(body.decision, "acceptForSession");
});
