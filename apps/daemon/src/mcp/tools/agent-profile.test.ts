/**
 * The agent-profile family (unified MCP design 2026-10-15 §4 rows 38–39, §4.1, §7): the ported
 * external tests (now `get_agent_profile` / `edit_agent_profile`, run through the executor as an
 * external caller: full trust, no card) and the chat cases — batch validation before the card,
 * secret values only from the card, flagged values, daemon-pointing warnings, preview completeness
 * per item kind, pins and `PREVIEW_STALE`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentProfileAgentId, AgentProfileSnapshot, ApprovalPreviewSection, ProfileItem, ProfileItemKind } from "@orquester/api";
import { FakeApprovalPort } from "../catalog/approval-double.ts";
import type { ApprovalRequest, ThreadCaller } from "../catalog/contract.ts";
import { ToolError } from "../errors.ts";
import { executeToolCall } from "../executor.ts";
import { FakeDaemonApi } from "../testing.ts";
import { looksLikeSecret, unifiedDiff } from "./agent-profile-preview.ts";

const SECRET = "private-profile-credential";
const base = "/api/agent-profile/claude";
const mcpPath = `${base}/items/mcp%3Ajira`;
const instructions = { path: "/home/u/.claude/CLAUDE.md", exists: true, bytes: 6, lines: 1, revision: "instructions-r1", warnings: [] };
const resultBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const reply = (body: unknown) => ({ status: 200, body });
const conflict = { status: 409, body: { error: { code: "PROFILE_CONFLICT", message: "Changed on disk." } } };
const CHECK = "/api/agent-profile/daemon-mcp-servers/check";

function item(kind: ProfileItemKind, name: string, patch: Partial<ProfileItem> = {}): ProfileItem {
  return { id: `${kind}:${name}`, kind, name, enabled: true, toggleable: true, editable: true, deletable: true, locked: false,
    source: { type: "user", label: "User" }, revision: "item-r1", warnings: [], ...patch };
}
function snapshot(items: ProfileItem[] = [], agent: AgentProfileAgentId = "claude"): AgentProfileSnapshot {
  return { agent, installed: true, revision: "snapshot-r1", instructions, items, fileErrors: [], readAt: "2026-09-29T12:00:00Z" };
}
const mcpDetail = { kind: "mcp", item: item("mcp", "jira"), mcp: { name: "jira", transport: "stdio", command: "node", args: ["jira.js"],
  env: [{ key: "TOKEN", set: true }, { key: "EMAIL", set: true }, { key: "REGION", set: true }], advanced: { timeout: 60000 } } };
const mutation = { snapshot: snapshot([item("mcp", "jira"), item("skill", "unrelated")]), itemIds: ["mcp:jira"], notes: [] };

function unwrap(result: Awaited<ReturnType<typeof executeToolCall>>): Record<string, unknown> {
  const structured = result.structuredContent as { code?: string; message?: string; detail?: unknown } & Record<string, unknown>;
  if (result.isError) throw new ToolError(structured.code!, structured.message!, structured.detail);
  return structured;
}

/** An external caller: full trust, no card (the pre-catalog behaviour). */
async function call(api: FakeDaemonApi, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return unwrap(await executeToolCall({ approvals: null }, { name, arguments: args }, { caller: { kind: "external" }, api, signal: new AbortController().signal }));
}
const edit = (api: FakeDaemonApi, agent: string, ...changes: Record<string, unknown>[]) => call(api, "edit_agent_profile", { agent, changes });

function thread(over: Partial<ThreadCaller> = {}): ThreadCaller {
  return { kind: "thread", threadId: "t1", title: "Chat", projectPath: "", workspace: "", cwd: "/tmp", agentId: "claude", callId: "c1",
    runtimeMode: "full-access", planning: false, workflowOwned: false, exchange: null, ...over };
}
/** A chat caller with the editing toolset on and an approval port double. */
async function chat(api: FakeDaemonApi, port: FakeApprovalPort, args: Record<string, unknown>, over: Partial<ThreadCaller> = {}) {
  return unwrap(await executeToolCall(
    { approvals: port, enabledToolsets: async () => new Set(["core", "reads", "agent-profile-editing"]) },
    { name: "edit_agent_profile", arguments: args },
    { caller: thread(over), api, signal: new AbortController().signal }
  ));
}

async function rejects(promise: Promise<unknown>, code: string): Promise<ToolError> {
  let error: unknown;
  await promise.then(() => assert.fail(`expected ${code}`), (caught) => { error = caught; });
  assert.ok(error instanceof ToolError, String(error));
  assert.equal(error.code, code, error.message);
  return error;
}
function request(api: FakeDaemonApi, method: string, path: string) {
  const found = api.calls.filter((entry) => entry.method === method && entry.path === path).at(-1);
  assert.ok(found, `${method} ${path}`);
  return found;
}
const writes = (api: FakeDaemonApi) => api.calls.filter((entry) => entry.method !== "GET" && entry.path !== CHECK);
function noSecret(value: unknown, secret = SECRET) { assert.ok(!JSON.stringify(value).includes(secret), "credential escaped"); }
const sectionsOf = (card: ApprovalRequest, kind: ApprovalPreviewSection["kind"]) => card.sections.filter((section) => section.kind === kind) as any[];

// ---------------------------------------------------------------------------
// get_agent_profile (ported reads)
// ---------------------------------------------------------------------------

test("get_agent_profile {}: every CLI's summary; mode arguments without agent are refused", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/agent-profile", reply({ agents: [
    { agent: "claude", installed: true, version: "2.1.0", counts: { mcp: 2 } },
    { agent: "grok", installed: false, counts: {} }, { agent: "opencode", installed: true, counts: {} }
  ] }));
  const all = await call(api, "get_agent_profile", {});
  assert.deepEqual((all.agents as { agent: string }[]).map((entry) => entry.agent), ["claude", "grok", "opencode"]);
  assert.deepEqual((all.agents as unknown[])[0], { agent: "claude", label: "Claude Code", installed: true, version: "2.1.0", counts: { mcp: 2 } });
  await rejects(call(api, "get_agent_profile", { itemId: "mcp:x" }), "INVALID_ARGUMENT");
  await rejects(call(api, "get_agent_profile", { agent: "claude", itemId: "mcp:x", instructions: true }), "INVALID_ARGUMENT");
  await rejects(call(api, "get_agent_profile", { agent: "claude", itemId: "mcp:x", kind: "mcp" }), "INVALID_ARGUMENT");
  await rejects(call(api, "get_agent_profile", { agent: "claude", offset: 3 }), "INVALID_ARGUMENT");
  await rejects(call(api, "get_agent_profile", { agent: "claude", installedOnly: true }), "INVALID_ARGUMENT");
});

test("get_agent_profile {agent}: filters by kind and case-insensitive source while preserving ownership and revision", async () => {
  const api = new FakeDaemonApi().on("GET", base, reply(snapshot([
    item("mcp", "jira"), item("skill", "handoff"), item("skill", "brainstorming", { editable: false, deletable: false,
      source: { type: "plugin", label: "Plugin · superpowers", pluginId: "superpowers@official" }, revision: "plugin-r4" })
  ])));
  const all = await call(api, "get_agent_profile", { agent: "claude" });
  assert.deepEqual(all.counts, { mcp: 1, skill: 2 });
  assert.equal(all.matched, 3);
  assert.ok(all.authoring);
  const skills = await call(api, "get_agent_profile", { agent: "claude", kind: "skill" });
  assert.deepEqual((skills.items as { id: string }[]).map((entry) => entry.id), ["skill:handoff", "skill:brainstorming"]);
  const result = await call(api, "get_agent_profile", { agent: "claude", query: "SUPERPOWERS" });
  const [entry] = result.items as Record<string, unknown>[];
  assert.equal(result.matched, 1);
  assert.deepEqual({ id: entry!.id, editable: entry!.editable, source: entry!.source, sourceType: entry!.sourceType, pluginId: entry!.pluginId, revision: entry!.revision },
    { id: "skill:brainstorming", editable: false, source: "Plugin · superpowers", sourceType: "plugin", pluginId: "superpowers@official", revision: "plugin-r4" });
  api.on("GET", base, reply({ ...snapshot(), installed: false }));
  assert.equal((await call(api, "get_agent_profile", { agent: "claude" })).installed, false);
});

test("get_agent_profile {agent}: oversized lists preserve a prefix and report omitted rows within the byte cap", async () => {
  const items = Array.from({ length: 1500 }, (_, i) => item("skill", `skill-${i}`, { description: "d".repeat(250) }));
  const api = new FakeDaemonApi().on("GET", base, reply(snapshot(items)));
  const result = await call(api, "get_agent_profile", { agent: "claude" });
  const kept = result.items as { id: string }[];
  assert.equal(result.truncated, true);
  assert.equal(result.matched, 1500);
  assert.ok(kept.length > 0 && kept.length < 1500);
  assert.equal(result.omitted, 1500 - kept.length);
  assert.deepEqual(kept.map((entry) => entry.id), items.slice(0, kept.length).map((entry) => entry.id));
  assert.ok(resultBytes(result) <= 60_000);
});

test("get_agent_profile {agent, itemId}: hostile env and header entries expose keys only", async () => {
  const api = new FakeDaemonApi().on("GET", mcpPath, reply({ ...mcpDetail, mcp: { ...mcpDetail.mcp,
    env: [{ key: "TOKEN", set: true, value: SECRET }], headers: [{ key: "Authorization", set: true, value: SECRET }] } }));
  const result = await call(api, "get_agent_profile", { agent: "claude", itemId: "mcp:jira" });
  const mcp = result.mcp as Record<string, unknown>;
  assert.deepEqual(mcp.env, [{ key: "TOKEN", set: true }]);
  assert.deepEqual(mcp.headers, [{ key: "Authorization", set: true }]);
  noSecret(result);
});

test("get_agent_profile {agent, itemId}: URL credentials are redacted but retained for an update that names no url", async () => {
  const api = new FakeDaemonApi().on("PUT", mcpPath, reply(mutation));
  for (const [url, shown] of [
    [`https://user:${SECRET}@git.example/r.git`, "https://***@git.example/r.git"],
    [`https://${SECRET}@git.example/r.git`, "https://***@git.example/r.git"],
    [`https://user:${SECRET}@git.example:8443/a@b?tag=@next#@end`, "https://***@git.example:8443/a@b?tag=@next#@end"],
    ["https://git.example/a@b", "https://git.example/a@b"], ["git@github.com:o/r.git", "git@github.com:o/r.git"]
  ]) {
    api.on("GET", mcpPath, reply({ ...mcpDetail, mcp: { name: "jira", transport: "http", url } }));
    const result = await call(api, "get_agent_profile", { agent: "claude", itemId: "mcp:jira" });
    assert.equal((result.mcp as { url: string }).url, shown);
    noSecret(result);
  }
  const url = `https://bot:prefix@${SECRET}${"x".repeat(300)}@mcp.example/x`;
  const remote = item("mcp", "jira", { description: url, meta: { url, target: url } });
  api.on("GET", mcpPath, reply({ ...mcpDetail, item: remote, mcp: { name: "jira", transport: "http", url } }));
  const detail = await call(api, "get_agent_profile", { agent: "claude", itemId: "mcp:jira" });
  const summary = detail.item as Record<string, unknown>;
  assert.equal(summary.description, "https://***@mcp.example/x", "redaction precedes truncation of long userinfo");
  assert.deepEqual(summary.meta, { url: "https://***@mcp.example/x", target: "https://***@mcp.example/x" });
  noSecret(detail);
  await edit(api, "claude", { action: "update", id: "mcp:jira", mcp: { headers: { "X-Extra": "1" } } });
  assert.deepEqual(request(api, "PUT", mcpPath).body, { revision: "item-r1", draft: { kind: "mcp", mcp: {
    name: "jira", transport: "http", url, headers: [{ key: "X-Extra", value: "1" }] } } });
  const source = `https://x:${SECRET}@git.example/m.git`;
  api.on("GET", `${base}/items/marketplace%3Aprivate`, reply({ kind: "marketplace",
    item: item("marketplace", "private", { description: source, meta: { source } }),
    marketplace: { name: "private", source: { type: "git", url: source, ref: "main" } } }));
  const result = await call(api, "get_agent_profile", { agent: "claude", itemId: "marketplace:private" });
  assert.deepEqual((result.marketplace as { source: unknown }).source, { type: "git", url: "https://***@git.example/m.git", ref: "main" });
  noSecret(result);
});

test("get_agent_profile {agent, itemId}: a long skill body is a Unicode-safe prefix marked as incomplete", async () => {
  const path = `${base}/items/skill%3Ahandoff`;
  const detail = { kind: "skill", item: item("skill", "handoff"), document: { frontmatter: { description: "Write a handoff" }, body: "# Handoff\nSteps." }, files: ["scripts/run.sh"] };
  const api = new FakeDaemonApi().on("GET", path, reply(detail));
  const small = await call(api, "get_agent_profile", { agent: "claude", itemId: "skill:handoff" });
  assert.deepEqual(small.document, { frontmatter: { description: "Write a handoff" }, body: "# Handoff\nSteps." });
  assert.deepEqual(small.files, ["scripts/run.sh"]);
  const original = "😀".repeat(40_000);
  api.on("GET", path, reply({ ...detail, document: { frontmatter: {}, body: original } }));
  const result = await call(api, "get_agent_profile", { agent: "claude", itemId: "skill:handoff" });
  const body = (result.document as { body: string }).body;
  assert.equal(result.bodyTruncated, true);
  assert.equal(result.bodyChars, 80_000);
  assert.ok(body.length > 0 && body.length < 80_000 && original.startsWith(body));
  assert.doesNotMatch(body, /[\uD800-\uDBFF]$/);
  assert.ok(resultBytes(result) <= 60_000);
});

test("get_agent_profile {agent, instructions}: Unicode pages reassemble; {agent, marketplace} lists plugins", async () => {
  const path = `${base}/instructions`;
  const original = "line — 😀\n".repeat(12_000);
  const api = new FakeDaemonApi().on("GET", path, reply({ text: original, info: instructions }))
    .on("GET", `${base}/marketplaces/official/plugins`, reply({ plugins: [{ name: "p", description: "d", version: "1", installed: true }] }));
  let assembled = "";
  let offset = 0;
  for (let pages = 0; pages < 10; pages += 1) {
    const page = await call(api, "get_agent_profile", { agent: "claude", instructions: true, ...(offset > 0 ? { offset } : {}) });
    assert.ok(resultBytes(page) <= 60_000);
    assembled += page.text as string;
    if (page.nextOffset === undefined) break;
    assert.ok((page.nextOffset as number) > offset);
    offset = page.nextOffset as number;
  }
  assert.equal(assembled, original);
  await rejects(call(api, "get_agent_profile", { agent: "claude", instructions: true, offset: original.length + 1 }), "INVALID_ARGUMENT");
  const plugins = await call(api, "get_agent_profile", { agent: "claude", marketplace: "official" });
  assert.deepEqual(plugins.plugins, [{ name: "p", description: "d", version: "1", installed: true }]);
});

// ---------------------------------------------------------------------------
// edit_agent_profile (ported writes, external callers)
// ---------------------------------------------------------------------------

test("edit_agent_profile: ambiguous, unsupported and malformed batches fail before any daemon request", async () => {
  const api = new FakeDaemonApi();
  for (const changes of [
    [], [{ action: "create" }], [{ action: "create", skill: { name: "a" }, command: { name: "b" } }],
    [{ action: "create", skill: { name: "a", descripton: "typo" } }],
    [{ action: "create", mcp: { name: "x", url: "https://x", command: "y" } }],
    [{ action: "create", mcp: { name: "x", transport: "stdio" } }], [{ action: "create", mcp: { name: "x", command: "c", env: { A: 1 } } }],
    [{ action: "create", mcp: { name: "x", command: "c", env: { A: null } } }],
    [{ action: "delete" }], [{ action: "delete", id: "mcp:a", text: "x" }], [{ action: "enable", id: "mcp:a", mcp: { name: "a" } }],
    [{ action: "update", id: "mcp:a" }], [{ action: "copy", id: "mcp:a", toAgent: "claude" }],
    [{ action: "delete", id: "mcp:a" }, { action: "disable", id: "mcp:a" }],
    [{ action: "write_instructions", text: "a" }, { action: "write_instructions", text: "b" }],
    [{ action: "import_pick", importId: "i" }], [{ action: "create", plugin: { plugin: "p" } }],
    Array.from({ length: 11 }, (_, i) => ({ action: "delete", id: `mcp:a${i}` })),
    // {ask: true} needs a card: external callers pass values.
    [{ action: "create", mcp: { name: "x", command: "c", env: { TOKEN: { ask: true } } } }]
  ]) await rejects(edit(api, "claude", ...changes), "INVALID_ARGUMENT");
  await rejects(call(api, "edit_agent_profile", { agent: "cursor", changes: [{ action: "create", skill: { name: "a" } }] }), "INVALID_ARGUMENT");
  await rejects(edit(api, "codex", { action: "create", command: { name: "pr", body: "x" } }), "KIND_NOT_SUPPORTED");
  await rejects(edit(api, "opencode", { action: "create", hook: { event: "Stop", command: "x" } }), "KIND_NOT_SUPPORTED");
  assert.deepEqual(api.calls, []);
});

test("edit_agent_profile create: compact arguments become daemon drafts and only changed items are returned", async () => {
  const path = `${base}/items`;
  const api = new FakeDaemonApi().on("POST", path, reply({ ...mutation, snapshot: { ...mutation.snapshot, privateCredential: SECRET } }));
  const result = await edit(api, "claude", { action: "create", mcp: { name: "jira", command: "node", args: ["jira.js"], env: { TOKEN: SECRET } } });
  assert.deepEqual(request(api, "POST", path).body, { onConflict: "fail", draft: { kind: "mcp", mcp: {
    name: "jira", transport: "stdio", command: "node", args: ["jira.js"], env: [{ key: "TOKEN", value: SECRET }] } } });
  const [first] = result.results as Record<string, unknown>[];
  assert.deepEqual((first!.items as { id: string }[]).map((entry) => entry.id), ["mcp:jira"]);
  assert.equal(result.changed, 1);
  assert.equal(result.approval, undefined);
  noSecret(result);
  await edit(api, "claude", { action: "create", mcp: { name: "remote", url: "https://mcp.example/x", headers: { Authorization: SECRET } }, onConflict: "replace" });
  assert.deepEqual(request(api, "POST", path).body, { onConflict: "replace", draft: { kind: "mcp", mcp: {
    name: "remote", transport: "http", url: "https://mcp.example/x", headers: [{ key: "Authorization", value: SECRET }] } } });
  await edit(api, "claude", { action: "create", skill: { name: "review", frontmatter: { description: "Review a diff" }, body: "Steps" } });
  assert.deepEqual(request(api, "POST", path).body, { onConflict: "fail", draft: { kind: "skill", document: { name: "review", frontmatter: { description: "Review a diff" }, body: "Steps" } } });
  await edit(api, "claude", { action: "create", command: { name: "git/pr" } });
  assert.deepEqual(request(api, "POST", path).body, { onConflict: "fail", draft: { kind: "command", document: { name: "git/pr", frontmatter: {}, body: "" } } });
  await edit(api, "claude", { action: "create", hook: { event: "Stop", matcher: "Bash", command: "notify" } }, { action: "create", plugin: { plugin: "p", marketplace: "m" } });
  assert.deepEqual(request(api, "POST", path).body, { onConflict: "fail", draft: { kind: "plugin", plugin: { plugin: "p", marketplace: "m" } } });
});

test("edit_agent_profile update: keep, replace, remove and add secrets without resolving their values", async () => {
  const api = new FakeDaemonApi().on("GET", mcpPath, reply(mcpDetail)).on("PUT", mcpPath, reply(mutation));
  const result = await edit(api, "claude", { action: "update", id: "mcp:jira", mcp: {
    args: ["jira.js", "--v2"], env: { TOKEN: SECRET, EMAIL: null, EXTRA: "new", ABSENT: null }, advanced: { timeout: null } } });
  assert.deepEqual(request(api, "PUT", mcpPath).body, { revision: "item-r1", draft: { kind: "mcp", mcp: {
    name: "jira", transport: "stdio", command: "node", args: ["jira.js", "--v2"],
    env: [{ key: "TOKEN", value: SECRET }, { key: "REGION", keep: true }, { key: "EXTRA", value: "new" }] } } });
  noSecret(result);
  await edit(api, "claude", { action: "update", id: "mcp:jira", mcp: { name: "renamed" } });
  assert.deepEqual((request(api, "PUT", mcpPath).body as { draft: { mcp: { env: unknown } } }).draft.mcp.env,
    [{ key: "TOKEN", keep: true }, { key: "EMAIL", keep: true }, { key: "REGION", keep: true }]);
  await rejects(edit(api, "claude", { action: "update", id: "mcp:jira", mcp: { transport: "http" } }), "INVALID_ARGUMENT");
  await rejects(edit(api, "claude", { action: "update", id: "mcp:jira", mcp: { transport: "stdio", headers: { A: "b" } } }), "INVALID_ARGUMENT");
  await edit(api, "claude", { action: "update", id: "mcp:jira", mcp: { name: "jira-cloud", transport: "http", url: "https://jira.example/mcp", headers: { Authorization: SECRET } } });
  assert.deepEqual(request(api, "PUT", mcpPath).body, { revision: "item-r1", draft: { kind: "mcp", mcp: {
    name: "jira-cloud", transport: "http", url: "https://jira.example/mcp", headers: [{ key: "Authorization", value: SECRET }], advanced: { timeout: 60000 } } } });
});

test("edit_agent_profile update: an external stale revision is sent as given; conflicts carry a fresh item, confirmed absence or the original refusal", async () => {
  const api = new FakeDaemonApi().on("GET", mcpPath, reply(mcpDetail)).on("PUT", mcpPath, conflict)
    .on("GET", base, reply(snapshot([item("mcp", "jira", { revision: "item-r2" })])));
  const change = { action: "update", id: "mcp:jira", revision: "old", mcp: { env: { TOKEN: SECRET } } };
  const error = await rejects(edit(api, "claude", change), "PROFILE_CONFLICT");
  assert.equal((request(api, "PUT", mcpPath).body as { revision: string }).revision, "old");
  const detail = error.detail as { cause: { item: { id: string; revision: string } }; failedIndex: number; completed: unknown[] };
  assert.equal(detail.cause.item.revision, "item-r2");
  assert.equal(detail.failedIndex, 0);
  assert.deepEqual(detail.completed, []);
  noSecret(error);
  api.on("GET", base, reply(snapshot()));
  assert.deepEqual(((await rejects(edit(api, "claude", change), "PROFILE_CONFLICT")).detail as { cause: unknown }).cause, { itemGone: true });
  const original = { code: "PROFILE_CONFLICT", message: "It changed on disk.", detail: { revision: "r-new" } };
  api.on("PUT", mcpPath, { status: 409, body: { error: original } });
  api.on("GET", base, { status: 503, body: { error: { code: "HOST_UNAVAILABLE", message: "The daemon is restarting." } } });
  const unreadable = await rejects(edit(api, "claude", change), "PROFILE_CONFLICT");
  assert.deepEqual((unreadable.detail as { cause: unknown }).cause, original.detail, "a failed snapshot read does not prove the item was deleted");
});

test("edit_agent_profile update: partial document and hook edits preserve omitted fields and reject a wrong kind", async () => {
  const skillPath = `${base}/items/skill%3Ahandoff`;
  const hookPath = `${base}/items/hook%3AStop%3Aaaaaaaaaaaaaaaaa`;
  const api = new FakeDaemonApi().on("GET", skillPath, reply({ kind: "skill", item: item("skill", "handoff"),
    document: { frontmatter: { description: "Old", model: "fast" }, body: "# Handoff\n\nSteps." } }))
    .on("PUT", skillPath, reply(mutation)).on("GET", hookPath, reply({ kind: "hook", item: item("hook", "Stop"),
      hook: { event: "Stop", matcher: "Bash", command: "notify", timeoutSec: 5 } })).on("PUT", hookPath, reply(mutation));
  await edit(api, "claude", { action: "update", id: "skill:handoff", skill: { frontmatter: { description: "New", model: null } } });
  assert.deepEqual(request(api, "PUT", skillPath).body, { revision: "item-r1", draft: { kind: "skill", document: {
    name: "handoff", frontmatter: { description: "New", model: null }, body: "# Handoff\n\nSteps." } } });
  await edit(api, "claude", { action: "update", id: "hook:Stop:aaaaaaaaaaaaaaaa", hook: { matcher: null, timeoutSec: 30 } });
  assert.deepEqual(request(api, "PUT", hookPath).body, { revision: "item-r1", draft: { kind: "hook", hook: { event: "Stop", command: "notify", timeoutSec: 30 } } });
  await rejects(edit(api, "claude", { action: "update", id: "skill:handoff", mcp: { args: [] } }), "INVALID_ARGUMENT");
  api.on("GET", `${base}/items/plugin%3Aofficial`, reply({ kind: "plugin", item: item("plugin", "official"), plugin: {} }));
  await rejects(edit(api, "claude", { action: "update", id: "plugin:official", skill: { body: "x" } }), "KIND_NOT_SUPPORTED");
});

test("edit_agent_profile enable/disable/delete/trust_hook/copy: current or explicit revisions, absent targets refused", async () => {
  const api = new FakeDaemonApi().on("GET", base, reply(snapshot([item("mcp", "jira")])))
    .on("POST", `${mcpPath}/enabled`, reply(mutation)).on("DELETE", mcpPath, reply(mutation));
  await edit(api, "claude", { action: "disable", id: "mcp:jira" });
  assert.deepEqual(request(api, "POST", `${mcpPath}/enabled`).body, { revision: "item-r1", enabled: false });
  await edit(api, "claude", { action: "enable", id: "mcp:jira", revision: "explicit-r0" });
  assert.deepEqual(request(api, "POST", `${mcpPath}/enabled`).body, { revision: "explicit-r0", enabled: true });
  await rejects(edit(api, "claude", { action: "enable", id: "skill:ghost" }), "ITEM_NOT_FOUND");
  const deleted = await edit(api, "claude", { action: "delete", id: "mcp:jira" });
  assert.deepEqual(request(api, "DELETE", mcpPath).query, { revision: "item-r1" });
  assert.deepEqual(deleted.results, [{ index: 0, action: "delete", deleted: true, id: "mcp:jira", notes: [] }]);
  api.on("POST", `${mcpPath}/copy`, reply({ snapshot: snapshot([item("mcp", "jira-copy")], "opencode"), itemIds: ["mcp:jira-copy"], notes: [] }));
  const copied = await edit(api, "claude", { action: "copy", id: "mcp:jira", toAgent: "opencode", onConflict: "keep-both" });
  assert.deepEqual(request(api, "POST", `${mcpPath}/copy`).body, { toAgent: "opencode", onConflict: "keep-both" });
  assert.deepEqual(((copied.results as Record<string, unknown>[])[0]!.items as { id: string }[]).map((entry) => entry.id), ["mcp:jira-copy"]);
  const hook = item("hook", "Stop", { id: "hook:Stop:bbbbbbbbbbbbbbbb", revision: "hook-r3" });
  const trust = "/api/agent-profile/codex/items/hook%3AStop%3Abbbbbbbbbbbbbbbb/trust";
  api.on("GET", "/api/agent-profile/codex", reply(snapshot([hook], "codex"))).on("POST", trust, reply({ snapshot: snapshot([hook], "codex"), itemIds: [hook.id], notes: [] }));
  await edit(api, "codex", { action: "trust_hook", id: hook.id });
  assert.deepEqual(request(api, "POST", trust).body, { revision: "hook-r3" });
  api.on("GET", base, reply({ ...snapshot(), installed: false }));
  await rejects(edit(api, "claude", { action: "enable", id: "mcp:jira" }), "AGENT_NOT_INSTALLED");
});

test("edit_agent_profile write_instructions and imports: whole-text writes, revision guards, private URLs, picks", async () => {
  const path = `${base}/instructions`;
  const api = new FakeDaemonApi().on("GET", path, reply({ text: "old", info: instructions })).on("PUT", path, reply(mutation));
  await edit(api, "claude", { action: "write_instructions", text: "# New rules\n" });
  assert.deepEqual(request(api, "PUT", path).body, { text: "# New rules\n", revision: "instructions-r1" });
  await edit(api, "claude", { action: "write_instructions", text: "Create only", revision: "" });
  assert.deepEqual(request(api, "PUT", path).body, { text: "Create only", revision: "" });
  api.on("PUT", path, conflict).on("GET", path, reply({ text: "Changed", info: { ...instructions, revision: "instructions-r2" } }));
  const error = await rejects(edit(api, "claude", { action: "write_instructions", text: "x", revision: "stale" }), "PROFILE_CONFLICT");
  assert.equal((error.detail as { cause: { instructions: { revision: string } } }).cause.instructions.revision, "instructions-r2");

  const url = `https://user:${SECRET}@git.example/skills.git`;
  api.on("POST", `${base}/imports/git`, reply({ importId: "scan-id", url,
    candidates: [{ ref: "skills/alpha", kind: "skill", name: "alpha", exists: false }, { ref: "skills/beta", kind: "skill", name: "beta", exists: true }], notes: [] }))
    .on("POST", `${base}/items`, reply(mutation));
  const scanned = await edit(api, "claude", { action: "import_scan", url });
  assert.deepEqual(request(api, "POST", `${base}/imports/git`).body, { url });
  const scan = (scanned.results as Record<string, unknown>[])[0]!;
  assert.equal(scan.importId, "scan-id");
  assert.deepEqual((scan.candidates as { ref: string; exists: boolean }[]).map((entry) => [entry.ref, entry.exists]), [["skills/alpha", false], ["skills/beta", true]]);
  noSecret(scanned);
  await edit(api, "claude", { action: "import_pick", importId: "scan-id", picks: ["skills/alpha"], onConflict: "replace" });
  assert.deepEqual(request(api, "POST", `${base}/items`).body, { import: { importId: "scan-id", picks: ["skills/alpha"] }, onConflict: "replace" });
});

test("edit_agent_profile: a batch runs in order and stops at the first failure, naming what was done", async () => {
  const api = new FakeDaemonApi().on("GET", base, reply(snapshot([item("mcp", "jira"), item("skill", "a")])))
    .on("POST", `${mcpPath}/enabled`, reply(mutation))
    .on("DELETE", `${base}/items/skill%3Aa`, { status: 403, body: { error: { code: "NOT_DELETABLE", message: "\"a\" cannot be deleted here." } } });
  const error = await rejects(edit(api, "claude", { action: "disable", id: "mcp:jira" }, { action: "delete", id: "skill:a" }, { action: "enable", id: "mcp:other" }), "NOT_DELETABLE");
  const detail = error.detail as { failedIndex: number; completed: { action: string }[] };
  assert.equal(detail.failedIndex, 1);
  assert.deepEqual(detail.completed.map((entry) => entry.action), ["disable"]);
  assert.match(error.message, /^changes\[1\] \(delete\): .*Changes 1–1 were made/);
});

// ---------------------------------------------------------------------------
// Chat callers: the card
// ---------------------------------------------------------------------------

test("chat: a skill is added after a card showing its whole SKILL.md; never grantable; the result reports the approval", async () => {
  const api = new FakeDaemonApi().on("POST", `${base}/items`, reply({ ...mutation, itemIds: ["skill:release-notes"], snapshot: snapshot([item("skill", "release-notes")]) }));
  const port = new FakeApprovalPort();
  const result = await chat(api, port, { agent: "claude", reason: "the user asked", changes: [{ action: "create",
    skill: { name: "release-notes", frontmatter: { description: "Draft release notes" }, body: "# Release notes\n\nList the merged PRs.\n" } }] });
  const [card] = port.cards;
  assert.equal(card!.kind, "admin");
  assert.equal(card!.family, "agent-profile");
  assert.equal(card!.title, "Claude wants to add the skill `release-notes` to Claude Code");
  assert.equal(card!.scope.label, "Global — every Claude Code chat");
  assert.deepEqual(card!.grantOptions, []);
  assert.equal(card!.reason, "the user asked");
  const [file] = sectionsOf(card!, "code");
  assert.equal(file.title, "release-notes/SKILL.md");
  assert.equal(file.text, "---\nname: release-notes\ndescription: Draft release notes\n---\n# Release notes\n\nList the merged PRs.\n");
  assert.deepEqual(result.approval, { outcome: "approved" });
  assert.equal(writes(api).length, 1);
  // Even a full-access caller with a project gets no grant: agent-profile is never grantable.
  assert.equal(port.grantQueries.length, 0);
});

test("chat: batch validation runs before any card or read; a stale revision is refused before the card", async () => {
  const api = new FakeDaemonApi().on("GET", base, reply(snapshot([item("skill", "a", { revision: "r2" })])));
  const port = new FakeApprovalPort();
  await rejects(chat(api, port, { agent: "claude", changes: [{ action: "delete", id: "skill:a" }, { action: "delete", id: "skill:a" }] }), "INVALID_ARGUMENT");
  await rejects(chat(api, port, { agent: "claude", changes: [{ action: "create", mcp: { name: "x", command: "c", env: { A: null } } }] }), "INVALID_ARGUMENT");
  assert.deepEqual(api.calls, []);
  await rejects(chat(api, port, { agent: "claude", changes: [{ action: "delete", id: "skill:a", revision: "r1" }] }), "PROFILE_CONFLICT");
  await rejects(chat(api, port, { agent: "claude", changes: [{ action: "delete", id: "skill:ghost" }] }), "ITEM_NOT_FOUND");
  assert.equal(port.cards.length, 0);
  assert.deepEqual(writes(api), []);
});

test("chat: {ask: true} values are card fields; the value goes from the card to the write and never back to the agent", async () => {
  const typed = "typed-in-the-card-0001";
  const api = new FakeDaemonApi().on("POST", CHECK, reply({ reason: null })).on("POST", `${base}/items`, reply(mutation));
  const port = new FakeApprovalPort((card) => ({ outcome: "approved", approvalId: "", secrets: Object.fromEntries(card.secretFields.map((field) => [field.key, typed])) }));
  const result = await chat(api, port, { agent: "claude", changes: [{ action: "create",
    mcp: { name: "jira", command: "node", args: ["jira.js"], env: { JIRA_TOKEN: { ask: true }, REGION: "eu" } } }] });
  const card = port.cards[0]!;
  assert.deepEqual(card.secretFields, [{ key: "c0.env.JIRA_TOKEN", label: "JIRA_TOKEN (env)" }]);
  const rows = sectionsOf(card, "fields")[0].rows as { label: string; value: string; state?: string }[];
  assert.deepEqual(rows.find((row) => row.label === "env JIRA_TOKEN"), { label: "env JIRA_TOKEN", value: "you type it in this card", state: "asked" });
  assert.deepEqual(rows.find((row) => row.label === "env REGION"), { label: "env REGION", value: "eu", state: "set" });
  assert.deepEqual(request(api, "POST", `${base}/items`).body, { onConflict: "fail", draft: { kind: "mcp", mcp: { name: "jira", transport: "stdio", command: "node", args: ["jira.js"],
    env: [{ key: "JIRA_TOKEN", value: typed }, { key: "REGION", value: "eu" }] } } });
  noSecret(result, typed);
  noSecret(card, typed);
  // The daemon-pointing check never sees an asked value either.
  noSecret(api.calls.filter((entry) => entry.path === CHECK), typed);
});

test("chat: plain values that look like secrets are flagged and masked; a server pointing at this daemon is flagged in red", async () => {
  const api = new FakeDaemonApi().on("POST", CHECK, reply({ reason: "url" })).on("POST", `${base}/items`, reply(mutation));
  const port = new FakeApprovalPort();
  await chat(api, port, { agent: "claude", changes: [{ action: "create",
    mcp: { name: "orq", url: "http://127.0.0.1:47831/mcp", headers: { Authorization: `Bearer ${SECRET}`, "X-Team": "blue" } } }] });
  const card = port.cards[0]!;
  noSecret(card);
  const rows = sectionsOf(card, "fields")[0].rows as { label: string; state?: string }[];
  assert.equal(rows.find((row) => row.label === "header Authorization")?.state, "flagged");
  assert.equal(rows.find((row) => row.label === "header X-Team")?.state, "set");
  const warnings = sectionsOf(card, "warning");
  assert.ok(warnings.some((w) => w.level === "caution" && /Authorization looks like a secret/.test(w.text)));
  assert.ok(warnings.some((w) => w.level === "danger" && /gives chats full control of Orquester without approvals/.test(w.text)));
  assert.deepEqual(request(api, "POST", CHECK).body, { agent: "claude", name: "orq", url: "http://127.0.0.1:47831/mcp", values: [`Bearer ${SECRET}`, "blue"] });
});

test("chat: an update's daemon-pointing check names the item so the daemon checks its current secret values too", async () => {
  const api = new FakeDaemonApi().on("GET", base, reply(snapshot([item("mcp", "jira")]))).on("GET", mcpPath, reply(mcpDetail))
    .on("POST", CHECK, reply({ reason: "bearer" })).on("PUT", mcpPath, reply(mutation));
  const port = new FakeApprovalPort();
  await chat(api, port, { agent: "claude", changes: [{ action: "update", id: "mcp:jira", mcp: { args: ["v2.js"] } }] });
  assert.deepEqual(request(api, "POST", CHECK).body, { agent: "claude", id: "mcp:jira", name: "jira", values: ["v2.js"] });
  assert.ok(sectionsOf(port.cards[0]!, "warning").some((w) => w.level === "danger" && /this Orquester's own credential/.test(w.text)));
  const rows = sectionsOf(port.cards[0]!, "fields")[0].rows as { label: string; value: string }[];
  assert.deepEqual(rows.filter((row) => row.label.startsWith("env ")).map((row) => row.value), ["kept as it is", "kept as it is", "kept as it is"]);
  assert.deepEqual(request(api, "PUT", mcpPath).body, { revision: "item-r1", draft: { kind: "mcp", mcp: { name: "jira", transport: "stdio", command: "node", args: ["v2.js"],
    env: [{ key: "TOKEN", keep: true }, { key: "EMAIL", keep: true }, { key: "REGION", keep: true }], advanced: { timeout: 60000 } } } });
});

const skillFiles = {
  itemId: "skill:handoff", revision: "item-r1", complete: true,
  files: [
    { path: "SKILL.md", size: 20, sha256: "a".repeat(64), text: "---\nname: handoff\n---\nSteps" },
    { path: "scripts/run.sh", size: 30, sha256: "b".repeat(64), flag: "executable", text: "#!/bin/sh\nrm -rf ~/x\n" },
    { path: "bin/tool", size: 9000, sha256: "c".repeat(64), flag: "binary" },
    { path: "link", size: 4, sha256: "d".repeat(64), flag: "symlink", target: "/etc" }
  ]
};

test("chat previews are complete per item kind: a copied skill's files, executables and binaries flagged with hashes", async () => {
  const api = new FakeDaemonApi().on("GET", base, reply(snapshot([item("skill", "handoff", { path: "/h/.claude/skills/handoff" })])))
    .on("GET", `${base}/items/skill%3Ahandoff/files`, reply(skillFiles))
    .on("POST", `${base}/items/skill%3Ahandoff/copy`, reply({ ...mutation, snapshot: snapshot([], "codex") }));
  const port = new FakeApprovalPort();
  await chat(api, port, { agent: "claude", changes: [{ action: "copy", id: "skill:handoff", toAgent: "codex" }] });
  const card = port.cards[0]!;
  assert.equal(card.title, "Claude wants to copy the skill `handoff` from Claude Code to Codex");
  assert.equal(card.scope.label, "Global — every Claude Code and Codex chat");
  const code = sectionsOf(card, "code").map((section) => [section.title, section.text, section.sha256]);
  assert.deepEqual(code, [["handoff/SKILL.md", skillFiles.files[0]!.text, "a".repeat(64)], ["handoff/scripts/run.sh", skillFiles.files[1]!.text, "b".repeat(64)]]);
  assert.deepEqual(sectionsOf(card, "file"), [
    { kind: "file", path: "handoff/scripts/run.sh", size: 30, sha256: "b".repeat(64), flag: "executable" },
    { kind: "file", path: "handoff/bin/tool", size: 9000, sha256: "c".repeat(64), flag: "binary" }
  ]);
  assert.ok(sectionsOf(card, "warning").some((w) => /handoff\/link is a symbolic link to \/etc/.test(w.text)));
});

test("chat previews: a plugin's provides with hook commands and MCP command lines, its files and the marketplace commit", async () => {
  const preview = {
    marketplace: "acme", plugin: "deploy", version: "1.2.0", commit: "f".repeat(40),
    source: { type: "local", complete: true, files: [
      { path: ".claude-plugin/plugin.json", size: 10, sha256: "1".repeat(64), text: "{\"name\":\"deploy\"}" },
      { path: "hooks/hooks.json", size: 10, sha256: "2".repeat(64), text: "{}" },
      { path: "hooks/post.sh", size: 10, sha256: "3".repeat(64), flag: "executable", text: "#!/bin/sh\ncurl evil\n" }
    ] },
    provides: { skills: ["ship"], commands: ["deploy"], agents: [], hooks: [{ event: "PostToolUse", matcher: "Bash", command: "${CLAUDE_PLUGIN_ROOT}/hooks/post.sh" }],
      mcpServers: [{ name: "deployer", command: "node", args: ["server.js"], envKeys: ["TOKEN"], headerKeys: [] }] }
  };
  const path = `${base}/marketplaces/acme/plugins/deploy`;
  const api = new FakeDaemonApi().on("GET", path, reply(preview)).on("POST", `${base}/items`, reply(mutation));
  const port = new FakeApprovalPort();
  await chat(api, port, { agent: "claude", changes: [{ action: "create", plugin: { plugin: "deploy", marketplace: "acme" } }] });
  const card = port.cards[0]!;
  assert.equal(card.title, "Claude wants to install the plugin `deploy` from `acme` in Claude Code");
  assert.ok((sectionsOf(card, "fields")[0].rows as { label: string; value: string }[]).some((row) => row.label === "Marketplace commit" && row.value === "f".repeat(40)));
  const provides = sectionsOf(card, "changes")[0].items as { label: string; detail?: string }[];
  assert.deepEqual(provides.map((entry) => entry.label), ["skill ship", "command /deploy", "hook PostToolUse (Bash)", "MCP server deployer"]);
  assert.equal(provides[2]!.detail, "${CLAUDE_PLUGIN_ROOT}/hooks/post.sh");
  assert.equal(provides[3]!.detail, "node server.js (env: TOKEN)");
  assert.ok(sectionsOf(card, "code").some((section) => section.title === "hooks/post.sh" && section.text.includes("curl evil")));
  assert.ok(sectionsOf(card, "file").some((section) => section.path === "hooks/post.sh" && section.flag === "executable"));

  // The marketplace advanced between the card and the write: PREVIEW_STALE, nothing installed.
  const stale = new FakeApprovalPort(() => {
    api.on("GET", path, reply({ ...preview, commit: "e".repeat(40) }));
    return { outcome: "approved", approvalId: "" };
  });
  api.calls = [];
  api.on("GET", path, reply(preview));
  await rejects(chat(api, stale, { agent: "claude", changes: [{ action: "create", plugin: { plugin: "deploy", marketplace: "acme" } }] }), "PREVIEW_STALE");
  assert.deepEqual(writes(api), []);

  // A plugin whose files are fetched at install: shown as such, in red.
  api.on("GET", path, reply({ ...preview, source: { type: "remote", description: "github acme/deploy" }, provides: { skills: [], commands: [], agents: [], hooks: [], mcpServers: [] } }));
  const remote = new FakeApprovalPort();
  await chat(api, remote, { agent: "claude", changes: [{ action: "create", plugin: { plugin: "deploy", marketplace: "acme" } }] });
  assert.ok(sectionsOf(remote.cards[0]!, "warning").some((w) => w.level === "danger" && /github acme\/deploy/.test(w.text)));
  // Too large to read whole: refused, never shown in part.
  api.on("GET", path, reply({ ...preview, source: { ...preview.source, complete: false } }));
  await rejects(chat(api, new FakeApprovalPort(), { agent: "claude", changes: [{ action: "create", plugin: { plugin: "deploy", marketplace: "acme" } }] }), "PREVIEW_TOO_LARGE");
});

test("chat previews: import picks in full with the commit; a checkout that changed after the card is PREVIEW_STALE", async () => {
  const detail = {
    importId: "imp", source: { type: "git", url: "https://git.example/skills.git", commit: "c".repeat(40) },
    candidates: [
      { ref: "skills/alpha", kind: "skill", name: "alpha", exists: false, complete: true, files: [{ path: "SKILL.md", size: 5, sha256: "1".repeat(64), text: "alpha body" }] },
      { ref: "skills/beta", kind: "skill", name: "beta", exists: true, complete: true, files: [{ path: "SKILL.md", size: 5, sha256: "2".repeat(64), text: "beta body" }] }
    ]
  };
  const path = `${base}/imports/imp`;
  const api = new FakeDaemonApi().on("GET", path, reply(detail)).on("POST", `${base}/items`, reply(mutation));
  const port = new FakeApprovalPort();
  await chat(api, port, { agent: "claude", changes: [{ action: "import_pick", importId: "imp", picks: ["skills/alpha"] }] });
  const card = port.cards[0]!;
  assert.deepEqual(sectionsOf(card, "code").map((section) => [section.title, section.text]), [["alpha/SKILL.md", "alpha body"]], "only the picked item, in full");
  assert.ok((sectionsOf(card, "fields")[0].rows as { label: string; value: string }[]).some((row) => row.label === "Commit" && row.value === "c".repeat(40)));
  assert.deepEqual(request(api, "POST", `${base}/items`).body, { import: { importId: "imp", picks: ["skills/alpha"] }, onConflict: "fail" });

  api.calls = [];
  const tamper = new FakeApprovalPort(() => {
    api.on("GET", path, reply({ ...detail, candidates: [{ ...detail.candidates[0]!, files: [{ path: "SKILL.md", size: 6, sha256: "9".repeat(64), text: "evil" }] }, detail.candidates[1]] }));
    return { outcome: "approved", approvalId: "" };
  });
  await rejects(chat(api, tamper, { agent: "claude", changes: [{ action: "import_pick", importId: "imp", picks: ["skills/alpha"] }] }), "PREVIEW_STALE");
  assert.deepEqual(writes(api), []);
  // import_scan is Admin too: a card before any network access.
  api.on("POST", `${base}/imports/git`, reply({ importId: "imp", candidates: [], notes: [] }));
  const scan = new FakeApprovalPort();
  await chat(api, scan, { agent: "claude", changes: [{ action: "import_scan", url: `https://u:${SECRET}@git.example/s.git` }] });
  assert.equal(scan.cards.length, 1);
  noSecret(scan.cards[0]);
});

test("chat TOCTOU: an item edited after the card is PREVIEW_STALE and nothing is written; instruction writes are diffs pinned to their revision", async () => {
  const hookPath = `${base}/items/hook%3AStop%3Aaaaaaaaaaaaaaaaa`;
  const hook = item("hook", "Stop", { id: "hook:Stop:aaaaaaaaaaaaaaaa" });
  const api = new FakeDaemonApi().on("GET", base, reply(snapshot([hook])))
    .on("GET", hookPath, reply({ kind: "hook", item: hook, hook: { event: "Stop", command: "notify-send done" } }))
    .on("DELETE", hookPath, reply(mutation));
  const port = new FakeApprovalPort(() => {
    api.on("GET", base, reply(snapshot([{ ...hook, revision: "item-r2" }])));
    return { outcome: "approved", approvalId: "" };
  });
  await rejects(chat(api, port, { agent: "claude", changes: [{ action: "delete", id: hook.id }] }), "PREVIEW_STALE");
  assert.ok(sectionsOf(port.cards[0]!, "code").some((section) => section.text === "notify-send done"), "the hook's command is shown in full");
  assert.deepEqual(writes(api), []);

  const path = `${base}/instructions`;
  api.on("GET", path, reply({ text: "# Rules\nBe brief.\n", info: instructions })).on("PUT", path, reply(mutation));
  const card = new FakeApprovalPort();
  await chat(api, card, { agent: "claude", changes: [{ action: "write_instructions", text: "# Rules\nBe thorough.\n" }] });
  const diff = sectionsOf(card.cards[0]!, "diff")[0];
  assert.equal(diff.unifiedDiff, "--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1,2 +1,2 @@\n # Rules\n-Be brief.\n+Be thorough.");
  assert.deepEqual(request(api, "PUT", path).body, { text: "# Rules\nBe thorough.\n", revision: "instructions-r1" });
});

test("chat gate: workflow-owned chats get ADMIN_NOT_AVAILABLE and planning chats are refused, both without a card", async () => {
  const api = new FakeDaemonApi();
  const port = new FakeApprovalPort();
  const args = { agent: "claude", changes: [{ action: "create", skill: { name: "x" } }] };
  await rejects(chat(api, port, args, { workflowOwned: true }), "ADMIN_NOT_AVAILABLE");
  await rejects(chat(api, port, args, { planning: true }), "PERMISSION_DENIED");
  assert.equal(port.cards.length, 0);
  const denied = new FakeApprovalPort({ outcome: "denied", approvalId: "", reason: "not now" });
  await rejects(chat(api, denied, args), "APPROVAL_DENIED");
  assert.deepEqual(writes(api), []);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test("unifiedDiff: hunks with context; additions to an empty file; no change", () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
  const after = before.replace("line 3", "line three").replace("line 18", "line eighteen");
  assert.equal(unifiedDiff(before, after, "a", "b"), [
    "--- a", "+++ b", "@@ -1,6 +1,6 @@", " line 1", " line 2", "-line 3", "+line three", " line 4", " line 5", " line 6",
    "@@ -15,6 +15,6 @@", " line 15", " line 16", " line 17", "-line 18", "+line eighteen", " line 19", " line 20"
  ].join("\n"));
  assert.equal(unifiedDiff("", "new\n", "a", "b"), "--- a\n+++ b\n@@ -0,0 +1,1 @@\n+new");
  assert.equal(unifiedDiff("same", "same", "a", "b"), "--- a\n+++ b\n(no change)");
});

test("looksLikeSecret: key names, known prefixes, bearer values and high-entropy strings; env references are fine", () => {
  for (const [key, value] of [["API_KEY", "x1"], ["Authorization", "Bearer abcdefgh123"], ["X", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["X", "sk-proj-abc"], ["DATA", "aZ3kP9qL2mX8vB1nR7tY4wE6uI0oS5dF"]]) assert.equal(looksLikeSecret(key, value), true, `${key}=${value}`);
  for (const [key, value] of [["TOKEN", "${GITHUB_TOKEN}"], ["API_KEY", "{env:KEY}"], ["REGION", "eu-west-1"], ["DEBUG", "1"], ["PATH_HINT", "/usr/local/bin"]]) {
    assert.equal(looksLikeSecret(key, value), false, `${key}=${value}`);
  }
});
