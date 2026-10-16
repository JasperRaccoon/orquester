/**
 * list_saved_prompts / update_saved_prompts (unified MCP design 2026-10-15 §4 rows 24–25, §4.1
 * D-16): through the executor, the in-process client with the caller's principal, and the daemon's
 * real `/api/saved-prompts` routes over a real library — so `createdBy` is what the daemon stamps
 * from the principal. Tiers: Act on an agent-created prompt no workflow uses, Admin `saved-prompts`
 * on the user's, Admin `workflows` (never grantable, the card naming the workflows) on a referenced
 * one; no pinning from chats.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createWriteStream, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TOOLSETS, type SavedPrompt } from "@orquester/api";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";
import { createServer } from "../../index.ts";
import { SavedPromptsService } from "../../saved-prompts.ts";
import { FakeApprovalPort } from "../catalog/approval-double.ts";
import type { ThreadCaller } from "../catalog/contract.ts";
import { InjectDaemonApi } from "../daemon-api.ts";
import { executeToolCall } from "../executor.ts";
import { unifiedDiff } from "./saved-prompts.ts";

type CreateServerArgs = Parameters<typeof createServer>;
type Outcome = { ok: true; value: Record<string, unknown> } | { ok: false; code: string; message: string };
type Row = SavedPrompt & { scope: string; bodyChars: number };

const ALL = new Set(TOOLSETS.map((toolset) => toolset.id));

/**
 * Workspaces `acme` (`api`, `api-2`, `web`) and `beta` (`app`); a real library behind the daemon's
 * routes; a mutable workflow list. `remotes` ("ws/project" → origin URL) is each checkout's Git
 * origin as the library reads it (none: a folder without one).
 */
async function harness(t: TestContext, options: { remotes?: Record<string, string> } = {}) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "mcp-saved-prompts-")));
  const workspacesDir = join(root, "workspaces");
  for (const dir of ["acme/api", "acme/api-2", "acme/web", "beta/app"]) await mkdir(join(workspacesDir, dir), { recursive: true });
  const file = join(root, "daemon", "saved-prompts.json");
  await mkdir(join(root, "daemon"), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, prompts: [] }));
  const remotes = new Map(Object.entries(options.remotes ?? {}).map(([ref, url]) => [join(workspacesDir, ref), url]));
  const git = { topLevel: async (cwd: string) => cwd, remoteUrl: async (cwd: string) => remotes.get(cwd) ?? null };
  const library = new SavedPromptsService({ file, workspacesDir: () => workspacesDir, fsRoot: () => workspacesDir, git, logger: { warn() {}, error() {} } });
  await library.load();
  const workflows: { id: string; name: string; project?: unknown; nodes: unknown[] }[] = [];
  let workflowReads = 0;
  const workflowsList = { list: () => { workflowReads += 1; return hooks.workflows(workflowReads); } };
  const hooks = { workflows: (_read: number) => workflows };
  const resolved = { daemonDir: join(root, "daemon"), workspacesDir, workspacesMetaFile: join(root, "workspaces.json"), fsRoot: workspacesDir };
  const app = createServer(
    createDefaultDaemonConfig({ env: {} }),
    resolved as unknown as CreateServerArgs[1],
    createDefaultClientConfig(join(root, "daemon.sock")),
    createWriteStream("/dev/null"),
    { savedPrompts: library, workflows: workflowsList } as unknown as CreateServerArgs[4],
    { authRequired: false, mode: "local" }
  );
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const api = new InjectDaemonApi({ app, authorization: undefined, agentChat: null, broadcaster: { add() {}, remove() {} } as never, fsRoot: workspacesDir, workspacesDir });
  const own = join(workspacesDir, "acme", "api");
  const chat = (over: Partial<ThreadCaller> = {}): ThreadCaller => ({
    kind: "thread", threadId: "me", title: "Release prep", projectPath: own, workspace: "acme", cwd: own, agentId: "claude", callId: "c1",
    runtimeMode: "full-access", planning: false, workflowOwned: false, exchange: null, ...over
  });
  const call = async (name: string, args: Record<string, unknown>, caller?: ThreadCaller, port = new FakeApprovalPort()): Promise<Outcome> => {
    const result: CallToolResult = await executeToolCall(
      { approvals: port, enabledToolsets: async () => ALL },
      { name, arguments: args },
      { caller: caller ?? { kind: "external" }, api, signal: new AbortController().signal }
    );
    const content = result.structuredContent as Record<string, unknown>;
    return result.isError ? { ok: false, code: content.code as string, message: content.message as string } : { ok: true, value: content };
  };
  const value = async (name: string, args: Record<string, unknown>, caller?: ThreadCaller, port?: FakeApprovalPort) => {
    const outcome = await call(name, args, caller, port);
    assert.ok(outcome.ok, outcome.ok ? "" : `${outcome.code}: ${outcome.message}`);
    return outcome.value;
  };
  const refused = async (name: string, args: Record<string, unknown>, code: string, caller?: ThreadCaller, port?: FakeApprovalPort) => {
    const outcome = await call(name, args, caller, port);
    assert.ok(!outcome.ok, `${name} succeeded`);
    assert.equal(outcome.code, code, outcome.message);
    return outcome.message;
  };
  /** A prompt the user made in the right rail (no principal). */
  const userPrompt = (fields: Partial<{ title: string; body: string; projectPath: string | null }> = {}) =>
    library.create({ title: "Mine", body: "Review {diff}", projectPath: null, ...fields });
  const reference = (prompt: { id: string }, workflow = { id: "wf_1", name: "Nightly review" }, projectPath = own) =>
    workflows.push({ ...workflow, project: { kind: "existing", projectPath }, nodes: [{ id: "n1", name: "Agent", type: "agent", config: { prompt: { kind: "saved", promptId: prompt.id } } }] } as never);
  return { root, remotes, library, workflows, hooks, own, workspacesDir, chat, call, value, refused, userPrompt, reference };
}

test("from a chat: add a per-project prompt (the chat's project by default) and a global one — Act, no card, createdBy stamped by the daemon", async (t) => {
  const h = await harness(t);
  const port = new FakeApprovalPort();
  const local = (await h.value("update_saved_prompts", { action: "create", title: "Release notes", body: "Summarise {diff}", tags: ["Docs"] }, h.chat({ runtimeMode: "approval-required" }), port)).prompt as Row;
  assert.equal(local.projectPath, h.own);
  assert.equal(local.scope, "project");
  assert.deepEqual(local.createdBy, { kind: "agent", threadId: "me", agent: "claude", title: "Release prep" });
  const global = (await h.value("update_saved_prompts", { action: "create", title: "Explain", body: "Explain this", global: true }, h.chat({ runtimeMode: "approval-required" }), port)).prompt as Row;
  assert.equal(global.projectPath, null);
  assert.equal(global.createdBy?.kind, "agent");
  assert.equal(port.cards.length, 0);
  // Stored as such: the right rail shows the "by Claude" badge from it.
  assert.deepEqual(h.library.get(local.id)!.createdBy, local.createdBy);
  // Another project of the workspace, named: allowed for a Full-access chat.
  const web = (await h.value("update_saved_prompts", { action: "create", title: "Web", body: "w", project: "acme/web" }, h.chat(), port)).prompt as Row;
  assert.equal(web.projectPath, join(h.workspacesDir, "acme", "web"));
});

test("create: project and global are exclusive; external callers name one; chats cannot pin; an external pin of an agent prompt is refused", async (t) => {
  const h = await harness(t);
  await h.refused("update_saved_prompts", { action: "create", title: "t", body: "b", global: true, project: "acme/api" }, "INVALID_ARGUMENT", h.chat());
  assert.match(await h.refused("update_saved_prompts", { action: "create", title: "t", body: "b" }, "INVALID_ARGUMENT"), /project, or global/);
  await h.refused("update_saved_prompts", { action: "create", title: "t", body: "b", pinned: true }, "INVALID_ARGUMENT", h.chat());
  assert.match(await h.refused("update_saved_prompts", { action: "create", title: "t", body: "b" }, "INVALID_ARGUMENT", h.chat({ projectPath: "", workspace: "" })), /global: true/);
  const agents = (await h.value("update_saved_prompts", { action: "create", title: "A", body: "a" }, h.chat())).prompt as Row;
  assert.equal(await h.refused("update_saved_prompts", { action: "update", id: agents.id, project: "acme/api", pinned: true }, "AGENT_PROMPT_PIN_REFUSED").then(() => true), true);
  const mine = await h.userPrompt();
  const pinned = (await h.value("update_saved_prompts", { action: "update", id: mine.id, pinned: true })).prompt as Row;
  assert.equal(pinned.pinned, true, "an external client pins the user's prompt");
  const created = (await h.value("update_saved_prompts", { action: "create", title: "E", body: "e", global: true, pinned: true })).prompt as Row;
  assert.equal(created.pinned, true);
  assert.equal(created.createdBy, undefined, "an external client's prompt is the user's");
});

test("an agent-created prompt no workflow uses: update and delete are Act, with no card", async (t) => {
  const h = await harness(t);
  const port = new FakeApprovalPort();
  const created = (await h.value("update_saved_prompts", { action: "create", title: "Draft", body: "one" }, h.chat({ runtimeMode: "approval-required" }), port)).prompt as Row;
  const updated = (await h.value("update_saved_prompts", { action: "update", id: created.id, body: "two" }, h.chat({ runtimeMode: "approval-required" }), port)).prompt as Row;
  assert.equal(updated.body, "two");
  assert.deepEqual(await h.value("update_saved_prompts", { action: "delete", id: created.id }, h.chat({ runtimeMode: "approval-required" }), port), { deleted: true, id: created.id });
  assert.equal(port.cards.length, 0);
});

test("the user's prompt: Admin saved-prompts — a card with the diff; grantable for this chat in Full access only, and the grant covers the next edit", async (t) => {
  const h = await harness(t);
  const mine = await h.userPrompt({ title: "Review", body: "line 1\nline 2\nline 3" });
  const port = new FakeApprovalPort();
  await h.value("update_saved_prompts", { action: "update", id: mine.id, body: "line 1\nline two\nline 3", reason: "fix wording" }, h.chat({ runtimeMode: "approval-required" }), port);
  const card = port.cards[0]!;
  assert.deepEqual([card.kind, card.family, card.reason], ["admin", "saved-prompts", "fix wording"]);
  assert.deepEqual(card.grantOptions, []);
  assert.match(card.title, /edit the saved prompt "Review"/);
  const diff = card.sections.find((section) => section.kind === "diff");
  assert.ok(diff && diff.kind === "diff" && diff.unifiedDiff.includes("-line 2\n+line two"));
  assert.ok(card.sections.some((section) => section.kind === "text" && section.text === "Created by you."));
  assert.equal(h.library.get(mine.id)!.body, "line 1\nline two\nline 3");
  // Full access, its own (global) target: the card offers a chat grant; with it, the next edit runs card-free.
  await h.value("update_saved_prompts", { action: "update", id: mine.id, title: "Review 2" }, h.chat(), port);
  assert.deepEqual(port.cards[1]!.grantOptions, ["chat"]);
  port.grant({ family: "saved-prompts", scope: "chat", threadId: "me", projectPath: h.own });
  await h.value("update_saved_prompts", { action: "update", id: mine.id, title: "Review 3" }, h.chat(), port);
  assert.equal(port.cards.length, 2, "covered by the grant");
  // Denied: nothing changes, and the agent is told not to retry.
  const denying = new FakeApprovalPort({ outcome: "denied", approvalId: "", reason: "keep it" });
  assert.match(await h.refused("update_saved_prompts", { action: "delete", id: mine.id }, "APPROVAL_DENIED", h.chat({ runtimeMode: "approval-required" }), denying), /keep it/);
  assert.ok(h.library.get(mine.id));
  const deleteCard = denying.cards[0]!;
  assert.ok(deleteCard.sections.some((section) => section.kind === "code" && section.title === "Body (deleted)" && section.text === "line 1\nline two\nline 3"));
});

test("a prompt a workflow uses: Admin workflows — the card names the workflows, never a grant, even under a saved-prompts grant", async (t) => {
  const h = await harness(t);
  const created = (await h.value("update_saved_prompts", { action: "create", title: "Nightly", body: "Check {branch}" }, h.chat())).prompt as Row;
  h.reference(created);
  const port = new FakeApprovalPort().grant({ family: "saved-prompts", scope: "chat", threadId: "me", projectPath: h.own });
  await h.value("update_saved_prompts", { action: "update", id: created.id, body: "Check {branch} twice" }, h.chat(), port);
  const card = port.cards[0]!;
  assert.deepEqual([card.kind, card.family, card.workflowReferencedPrompt], ["admin", "workflows", true]);
  assert.deepEqual(card.grantOptions, []);
  const changes = card.sections.find((section) => section.kind === "changes");
  assert.ok(changes && changes.kind === "changes" && changes.items.some((item) => item.label === "Nightly review" && item.detail === "wf_1"));
  assert.ok(card.sections.some((section) => section.kind === "warning" && section.level === "danger"));
  assert.ok(card.sections.some((section) => section.kind === "diff" && section.unifiedDiff.includes("+Check {branch} twice")));
  // A workflow-owned chat never gets the card.
  await h.refused("update_saved_prompts", { action: "update", id: created.id, title: "x" }, "ADMIN_NOT_AVAILABLE", h.chat({ workflowOwned: true }));
});

test("what is approved is what runs: a prompt edited while its card waits is PREVIEW_STALE; one a workflow started using is refused", async (t) => {
  const h = await harness(t);
  const mine = await h.userPrompt({ title: "Shared", body: "v1" });
  const port = new FakeApprovalPort(async () => {
    await h.library.update(mine.id, { body: "changed by the user meanwhile" });
    return { outcome: "approved", approvalId: "" };
  });
  await h.refused("update_saved_prompts", { action: "update", id: mine.id, body: "v2" }, "PREVIEW_STALE", h.chat(), port);
  assert.equal(h.library.get(mine.id)!.body, "changed by the user meanwhile");
  // An agent's own prompt passes as Act at the gate; a workflow references it before the write.
  const created = (await h.value("update_saved_prompts", { action: "create", title: "Mine", body: "a" }, h.chat())).prompt as Row;
  const used = [{ id: "wf_9", name: "Late", nodes: [{ id: "n", name: "A", type: "agent", config: { prompt: { kind: "saved", promptId: created.id } } }] }];
  let reads = 0;
  h.hooks.workflows = () => (++reads >= 2 ? used : []);
  assert.match(await h.refused("update_saved_prompts", { action: "update", id: created.id, body: "b" }, "PERMISSION_DENIED", h.chat()), /approval/);
  assert.equal(h.library.get(created.id)!.body, "a");
});

test("update/delete find the prompt among the global ones and the named (or own) project's; another workspace's user prompt is a cross-project card", async (t) => {
  const h = await harness(t);
  const beta = await h.userPrompt({ title: "Beta", projectPath: join(h.workspacesDir, "beta", "app") });
  assert.match(await h.refused("update_saved_prompts", { action: "update", id: beta.id, title: "x" }, "SAVED_PROMPT_NOT_FOUND", h.chat()), /pass the prompt's project/);
  const port = new FakeApprovalPort();
  await h.value("update_saved_prompts", { action: "update", id: beta.id, project: "beta/app", title: "Beta 2" }, h.chat(), port);
  assert.equal(port.cards[0]!.family, "saved-prompts");
  assert.deepEqual(port.cards[0]!.grantOptions, [], "an Admin call outside the chat's project is never grantable");
  assert.equal(h.library.get(beta.id)!.title, "Beta 2");
  await h.refused("update_saved_prompts", { action: "update", id: beta.id, title: "x", global: true }, "INVALID_ARGUMENT", h.chat());
  await h.refused("update_saved_prompts", { action: "delete", id: beta.id, project: "beta/app", body: "x" }, "INVALID_ARGUMENT", h.chat());
  assert.match(await h.refused("update_saved_prompts", { action: "create", title: "t", body: "b" }, "PERMISSION_DENIED", h.chat({ planning: true })), /planning/);
});

test("list_saved_prompts: the chat's project and the global prompts, with createdBy and usedByWorkflows; bodies on request; query", async (t) => {
  const h = await harness(t);
  const mine = await h.userPrompt({ title: "Global one", body: "global body" });
  h.reference(mine);
  await h.userPrompt({ title: "Web only", projectPath: join(h.workspacesDir, "acme", "web") });
  const agents = (await h.value("update_saved_prompts", { action: "create", title: "Api prompt", body: "api body" }, h.chat())).prompt as Row;
  const listed = (await h.value("list_saved_prompts", {}, h.chat({ runtimeMode: "approval-required" }))).prompts as Row[];
  assert.deepEqual(listed.map((row) => row.title), ["Api prompt", "Global one"], "the project's own first, then the global ones");
  assert.equal(listed[0]!.createdBy?.kind, "agent");
  assert.deepEqual(listed[1]!.usedByWorkflows, [{ workflowId: "wf_1", name: "Nightly review", workspace: "acme" }]);
  assert.equal("body" in listed[0]!, false);
  assert.equal(listed[0]!.bodyChars, "api body".length);
  const bodies = (await h.value("list_saved_prompts", { includeBody: true, query: "API" }, h.chat())).prompts as Row[];
  assert.deepEqual(bodies.map((row) => [row.id, row.body]), [[agents.id, "api body"]]);
  // External: the global prompts unless a project is named.
  assert.deepEqual(((await h.value("list_saved_prompts", {})).prompts as Row[]).map((row) => row.title), ["Global one"]);
  // Another workspace's prompts are a metadata read: a card below Full access.
  const port = new FakeApprovalPort();
  await h.value("list_saved_prompts", { project: "beta/app" }, h.chat({ runtimeMode: "auto" }), port);
  assert.equal(port.cards[0]?.family, "cross-workspace-read");
});

test("unifiedDiff: every changed line, three lines of context, separate hunks for distant changes", () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
  const after = before.replace("line 2", "LINE 2").replace("line 18", "LINE 18");
  const diff = unifiedDiff(before, after, "body");
  assert.equal(diff.split("\n").filter((line) => line.startsWith("@@")).length, 2);
  assert.ok(diff.startsWith("--- a/body\n+++ b/body\n@@ -1,5 +1,5 @@\n line 1\n-line 2\n+LINE 2\n line 3"));
  assert.ok(diff.includes("@@ -15,6 +15,6 @@\n line 15\n line 16\n line 17\n-line 18\n+LINE 18\n line 19\n line 20"));
  assert.equal(unifiedDiff("a", "a\nb", "t"), "--- a/t\n+++ b/t\n@@ -1,1 +1,2 @@\n a\n+b");
});

test("ruling S13: workflows of another workspace reach a chat below Full access only as a count; the user's card still names them", async (t) => {
  const h = await harness(t);
  const created = (await h.value("update_saved_prompts", { action: "create", title: "Shared", body: "b", global: true }, h.chat())).prompt as Row;
  h.reference(created, { id: "wf_own", name: "Own nightly" });
  h.reference(created, { id: "wf_beta", name: "Beta secret" }, join(h.workspacesDir, "beta", "app"));
  const rowFor = async (mode: ThreadCaller["runtimeMode"]) =>
    ((await h.value("list_saved_prompts", {}, h.chat({ runtimeMode: mode }))).prompts as (Row & { usedByWorkflowsElsewhere?: number })[]).find((row) => row.id === created.id)!;
  const narrow = await rowFor("auto");
  assert.deepEqual(narrow.usedByWorkflows, [{ workflowId: "wf_own", name: "Own nightly", workspace: "acme" }]);
  assert.equal(narrow.usedByWorkflowsElsewhere, 1);
  assert.ok(!JSON.stringify(narrow).includes("Beta secret"));
  const wide = await rowFor("full-access");
  assert.equal(wide.usedByWorkflows?.length, 2);
  assert.equal("usedByWorkflowsElsewhere" in wide, false);
  // The update's result row follows the same rule; the card (shown to the user, never to the agent) names both.
  const port = new FakeApprovalPort();
  const result = await h.value("update_saved_prompts", { action: "update", id: created.id, title: "Shared 2" }, h.chat({ runtimeMode: "auto" }), port);
  assert.ok(!JSON.stringify(result).includes("Beta secret"));
  assert.equal((result.prompt as { usedByWorkflowsElsewhere?: number }).usedByWorkflowsElsewhere, 1);
  assert.ok(JSON.stringify(port.cards[0]!.sections).includes("Beta secret"));
});

const SITE = "git@github.com:acme/site.git";

test("repository prompts: the gate judges a prompt by its first checkout — a sibling checkout below Full access gets the same-workspace card, none at Full access", async (t) => {
  const h = await harness(t, { remotes: { "acme/api": SITE, "acme/api-2": SITE } });
  const sibling = join(h.workspacesDir, "acme", "api-2");
  const inSibling = (over: Partial<ThreadCaller> = {}) => h.chat({ projectPath: sibling, cwd: sibling, ...over });
  const quiet = new FakeApprovalPort();
  const created = (await h.value("update_saved_prompts", { action: "create", title: "Release", body: "r" }, h.chat({ runtimeMode: "approval-required" }), quiet)).prompt as Row;
  assert.equal(created.repoKey, "github.com/acme/site");
  assert.equal(created.projectPath, h.own, "a create stamps the caller's own project");
  assert.equal(quiet.cards.length, 0);
  // Listed in the sibling (same workspace: shown as acme/api's prompts are), but it is acme/api's prompt.
  assert.deepEqual(((await h.value("list_saved_prompts", { includeBody: true }, inSibling({ runtimeMode: "approval-required" }))).prompts as Row[]).map((row) => [row.id, row.body]), [[created.id, "r"]]);
  for (const project of [undefined, "acme/api", "acme/api-2"]) {
    const port = new FakeApprovalPort();
    await h.value("update_saved_prompts", { action: "update", id: created.id, body: `via ${project}`, ...(project ? { project } : {}) }, inSibling({ runtimeMode: "approval-required" }), port);
    assert.deepEqual([port.cards[0]?.kind, port.cards[0]?.family], ["boundary", "cross-project"], String(project));
    assert.equal(port.cards[0]!.scope.label, "Project acme/api — shared by every checkout of github.com/acme/site");
  }
  const full = new FakeApprovalPort();
  await h.value("update_saved_prompts", { action: "update", id: created.id, body: "full" }, inSibling(), full);
  assert.equal(full.cards.length, 0, "a same-workspace Act needs no card at Full access");
  // The user's prompt of acme/api from the sibling: Admin, cross-project, never grantable.
  const mine = await h.userPrompt({ title: "Mine", projectPath: h.own });
  await h.value("update_saved_prompts", { action: "update", id: mine.id, title: "Mine 2" }, inSibling(), full);
  assert.deepEqual([full.cards[0]?.kind, full.cards[0]?.family, full.cards[0]?.grantOptions], ["admin", "saved-prompts", []]);
});

test("an agent that rewrote its origin to another repository gets no card-free access: hidden rows, cards for every edit, createdBy reduced", async (t) => {
  const victim = "https://github.com/beta/app.git";
  const h = await harness(t, { remotes: { "beta/app": victim } });
  const app = join(h.workspacesDir, "beta", "app");
  const web = join(h.workspacesDir, "acme", "web");
  const inBeta = h.chat({ projectPath: app, cwd: app, workspace: "beta", threadId: "beta-chat", title: "Beta chat" });
  const theirs = (await h.value("update_saved_prompts", { action: "create", title: "Beta agent prompt", body: "beta secret body" }, inBeta)).prompt as Row;
  const users = await h.userPrompt({ title: "Beta user prompt", body: "user secret body", projectPath: app });
  // The attacker's checkout now claims the victim's origin.
  h.remotes.set(web, victim);
  const attacker = (over: Partial<ThreadCaller> = {}) => h.chat({ projectPath: web, cwd: web, runtimeMode: "auto", ...over });
  const listed = await h.value("list_saved_prompts", { includeBody: true }, attacker());
  assert.deepEqual(listed.prompts, [], "another workspace's prompts reach a chat below Full access only as a count");
  assert.equal(listed.sharedElsewhere, 2);
  assert.ok(!JSON.stringify(listed).includes("secret body"));
  // Every edit is a card: another workspace's Act, and the user's prompt as a cross-project Admin.
  const denying = new FakeApprovalPort({ outcome: "denied", approvalId: "", reason: "no" });
  await h.refused("update_saved_prompts", { action: "update", id: theirs.id, body: "planted" }, "APPROVAL_DENIED", attacker(), denying);
  await h.refused("update_saved_prompts", { action: "update", id: users.id, body: "planted" }, "APPROVAL_DENIED", attacker({ runtimeMode: "full-access" }), denying);
  assert.deepEqual(denying.cards.map((card) => [card.kind, card.family, card.grantOptions]), [["boundary", "cross-project", []], ["admin", "saved-prompts", []]]);
  assert.equal(denying.cards[0]!.scope.label, "Project beta/app — shared by every checkout of github.com/beta/app");
  assert.equal(h.library.get(theirs.id)!.body, "beta secret body");
  assert.equal(h.library.get(users.id)!.body, "user secret body");
  // Approved, the result row keeps the other workspace's details out: no path, createdBy only its kind.
  const result = (await h.value("update_saved_prompts", { action: "update", id: theirs.id, title: "Renamed" }, attacker(), new FakeApprovalPort())).prompt as Row;
  assert.equal("projectPath" in result, false);
  assert.deepEqual(result.createdBy, { kind: "agent" });
  // A prompt it plants in its own project is shared by key, but to the victim's chats it is acme/web's: a card.
  const planted = (await h.value("update_saved_prompts", { action: "create", title: "Planted", body: "p" }, attacker())).prompt as Row;
  assert.equal(planted.repoKey, "github.com/beta/app");
  const port = new FakeApprovalPort();
  await h.value("update_saved_prompts", { action: "update", id: planted.id, body: "q" }, { ...inBeta, runtimeMode: "auto" }, port);
  assert.deepEqual([port.cards[0]?.kind, port.cards[0]?.family], ["boundary", "cross-project"]);
  // Full access sees them in full (other-workspace metadata), still never as its own.
  const wide = ((await h.value("list_saved_prompts", {}, attacker({ runtimeMode: "full-access" }))).prompts as Row[]).find((row) => row.id === users.id)!;
  assert.equal(wide.projectPath, app);
});

test("a first checkout that no longer exists: an ungrantable boundary card naming it, in every mode; a checkout deleted while the card waits is PREVIEW_STALE", async (t) => {
  const h = await harness(t, { remotes: { "acme/api": SITE, "acme/api-2": SITE } });
  const sibling = join(h.workspacesDir, "acme", "api-2");
  const inSibling = (mode: ThreadCaller["runtimeMode"]) => h.chat({ projectPath: sibling, cwd: sibling, runtimeMode: mode });
  const created = (await h.value("update_saved_prompts", { action: "create", title: "Orphan", body: "o" }, h.chat())).prompt as Row;
  const mine = await h.userPrompt({ title: "Mine", projectPath: h.own });
  // Deleted while a card about it waits: the claim changed under the approval.
  const racing = new FakeApprovalPort(async () => {
    await rm(h.own, { recursive: true, force: true });
    return { outcome: "approved", approvalId: "" };
  });
  await h.refused("update_saved_prompts", { action: "update", id: created.id, body: "x" }, "PREVIEW_STALE", inSibling("approval-required"), racing);
  assert.equal(h.library.get(created.id)!.body, "o");
  for (const mode of ["approval-required", "full-access"] as const) {
    const port = new FakeApprovalPort();
    await h.value("update_saved_prompts", { action: "update", id: created.id, body: `in ${mode}` }, inSibling(mode), port);
    assert.deepEqual([port.cards[0]?.kind, port.cards[0]?.family, port.cards[0]?.grantOptions], ["boundary", "cross-project", []], mode);
    assert.equal(port.cards[0]!.scope.label, "Project acme/api (no longer a project) — shared by every checkout of github.com/acme/site");
    assert.equal(h.library.get(created.id)!.body, `in ${mode}`);
  }
  const port = new FakeApprovalPort().grant({ family: "saved-prompts", scope: "chat", threadId: "me", projectPath: sibling });
  await h.value("update_saved_prompts", { action: "update", id: mine.id, title: "Mine 2" }, inSibling("full-access"), port);
  assert.deepEqual([port.cards[0]?.kind, port.cards[0]?.grantOptions], ["admin", []], "no grant covers it");
});

test("a stale stored key: list_saved_prompts still lists the prompt in its own folder", async (t) => {
  const h = await harness(t, { remotes: { "acme/api": SITE } });
  const created = (await h.value("update_saved_prompts", { action: "create", title: "Kept", body: "k" }, h.chat())).prompt as Row;
  h.remotes.set(h.own, "git@github.com:acme/renamed.git");
  const rows = (await h.value("list_saved_prompts", {}, h.chat({ runtimeMode: "approval-required" }))).prompts as Row[];
  assert.deepEqual(rows.map((row) => [row.id, row.repoKey]), [[created.id, "github.com/acme/site"]]);
});
