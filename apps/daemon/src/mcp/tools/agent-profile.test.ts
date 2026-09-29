import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { AgentProfileAgentId, AgentProfileSnapshot, ProfileItem, ProfileItemKind } from "@orquester/api";
import { ToolError } from "../errors.ts";
import { toSafeToolError } from "../result.ts";
import { FakeDaemonApi } from "../testing.ts";
import type { ToolContext } from "../tool.ts";
import { agentProfileTools } from "./agent-profile.ts";

const SECRET = "private-profile-credential";
const base = "/api/agent-profile/claude";
const mcpPath = `${base}/items/mcp%3Ajira`;
const instructions = { path: "/home/u/.claude/CLAUDE.md", exists: true, bytes: 6, lines: 1, revision: "instructions-r1", warnings: [] };
const resultBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const reply = (body: unknown) => ({ status: 200, body });
const conflict = { status: 409, body: { error: { code: "PROFILE_CONFLICT", message: "Changed on disk." } } };

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
const ctx = (api: FakeDaemonApi): ToolContext => ({ api, todos: {} as never, files: {} as never, signal: new AbortController().signal, now: () => 0 });

async function call(api: FakeDaemonApi, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = agentProfileTools.find((candidate) => candidate.name === name)!;
  const parsed = z.object(tool.input).strict().safeParse(args);
  if (!parsed.success) throw new ToolError("INVALID_ARGUMENT", parsed.error.message);
  return tool.run(parsed.data as never, ctx(api));
}
async function rejects(promise: Promise<unknown>, code: string): Promise<ToolError> {
  let error: unknown;
  await promise.then(() => assert.fail(`expected ${code}`), (caught) => { error = caught; });
  assert.ok(error instanceof ToolError);
  assert.equal(error.code, code);
  return error;
}
function request(api: FakeDaemonApi, method: string, path: string) {
  const found = api.calls.filter((entry) => entry.method === method && entry.path === path).at(-1);
  assert.ok(found, `${method} ${path}`);
  return found;
}
function noSecret(value: unknown) { assert.ok(!JSON.stringify(value).includes(SECRET), "credential escaped in the response"); }

// docs/orquester-mcp.md §13: these fixtures are fixed daemon replies, not an implementation of profile storage.
test("list_agent_profiles: installedOnly excludes unavailable agents", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/agent-profile", reply({ agents: [
    { agent: "claude", installed: true, version: "2.1.0", counts: { mcp: 2 } },
    { agent: "grok", installed: false, counts: {} }, { agent: "opencode", installed: true, counts: {} }
  ] }));
  const all = await call(api, "list_agent_profiles", {});
  assert.deepEqual((all.agents as { agent: string }[]).map((entry) => entry.agent), ["claude", "grok", "opencode"]);
  assert.deepEqual((all.agents as unknown[])[0], { agent: "claude", label: "Claude", installed: true, version: "2.1.0", counts: { mcp: 2 } });
  const installed = await call(api, "list_agent_profiles", { installedOnly: true });
  assert.deepEqual((installed.agents as { agent: string }[]).map((entry) => entry.agent), ["claude", "opencode"]);
});

test("get_agent_profile: filters by kind and case-insensitive source while preserving ownership and revision", async () => {
  const api = new FakeDaemonApi().on("GET", base, reply(snapshot([
    item("mcp", "jira"), item("skill", "handoff"), item("skill", "brainstorming", { editable: false, deletable: false,
      source: { type: "plugin", label: "Plugin · superpowers", pluginId: "superpowers@official" }, revision: "plugin-r4" })
  ])));
  const all = await call(api, "get_agent_profile", { agent: "claude" });
  assert.deepEqual(all.counts, { mcp: 1, skill: 2 });
  assert.equal(all.matched, 3);
  const skills = await call(api, "get_agent_profile", { agent: "claude", kind: "skill" });
  assert.deepEqual((skills.items as { id: string }[]).map((entry) => entry.id), ["skill:handoff", "skill:brainstorming"]);
  const result = await call(api, "get_agent_profile", { agent: "claude", query: "SUPERPOWERS" });
  const [entry] = result.items as Record<string, unknown>[];
  assert.equal(result.matched, 1);
  assert.deepEqual({ id: entry!.id, editable: entry!.editable, source: entry!.source, sourceType: entry!.sourceType,
    pluginId: entry!.pluginId, revision: entry!.revision }, { id: "skill:brainstorming", editable: false, source: "Plugin · superpowers",
    sourceType: "plugin", pluginId: "superpowers@official", revision: "plugin-r4" });
  api.on("GET", base, reply({ ...snapshot(), installed: false }));
  assert.equal((await call(api, "get_agent_profile", { agent: "claude" })).installed, false);
});

test("get_agent_profile: oversized lists preserve a prefix and report omitted rows within the byte cap", async () => {
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

test("get_agent_profile_item: hostile env and header entries expose keys only", async () => {
  const api = new FakeDaemonApi().on("GET", mcpPath, reply({ ...mcpDetail, mcp: { ...mcpDetail.mcp,
    env: [{ key: "TOKEN", set: true, value: SECRET }], headers: [{ key: "Authorization", set: true, value: SECRET }] } }));
  const result = await call(api, "get_agent_profile_item", { agent: "claude", id: "mcp:jira" });
  const mcp = result.mcp as Record<string, unknown>;
  assert.deepEqual(mcp.env, [{ key: "TOKEN", set: true }]);
  assert.deepEqual(mcp.headers, [{ key: "Authorization", set: true }]);
  noSecret(result);
});

test("get_agent_profile_item: URL credentials are redacted but retained for an unnamed-url update", async () => {
  const api = new FakeDaemonApi().on("PUT", mcpPath, reply(mutation));
  for (const [url, shown] of [
    [`https://user:${SECRET}@git.example/r.git`, "https://***@git.example/r.git"],
    [`https://${SECRET}@git.example/r.git`, "https://***@git.example/r.git"],
    ["https://git.example/a@b", "https://git.example/a@b"], ["git@github.com:o/r.git", "git@github.com:o/r.git"]
  ]) {
    api.on("GET", mcpPath, reply({ ...mcpDetail, mcp: { name: "jira", transport: "http", url } }));
    const result = await call(api, "get_agent_profile_item", { agent: "claude", id: "mcp:jira" });
    assert.equal((result.mcp as { url: string }).url, shown);
    noSecret(result);
  }
  const url = `https://bot:${SECRET}@mcp.example/x`;
  api.on("GET", mcpPath, reply({ ...mcpDetail, mcp: { name: "jira", transport: "http", url } }));
  await call(api, "update_agent_profile_item", { agent: "claude", id: "mcp:jira", mcp: { headers: { "X-Extra": "1" } } });
  assert.deepEqual(request(api, "PUT", mcpPath).body, { revision: "item-r1", draft: { kind: "mcp", mcp: {
    name: "jira", transport: "http", url, headers: [{ key: "X-Extra", value: "1" }] } } });
  api.on("GET", `${base}/items/marketplace%3Aprivate`, reply({ kind: "marketplace", item: item("marketplace", "private"),
    marketplace: { name: "private", source: { type: "git", url: `https://x:${SECRET}@git.example/m.git`, ref: "main" } } }));
  const result = await call(api, "get_agent_profile_item", { agent: "claude", id: "marketplace:private" });
  assert.deepEqual((result.marketplace as { source: unknown }).source, { type: "git", url: "https://***@git.example/m.git", ref: "main" });
  noSecret(result);
});

test("get_agent_profile_item: a long skill body is a Unicode-safe prefix marked as incomplete", async () => {
  const path = `${base}/items/skill%3Ahandoff`;
  const detail = { kind: "skill", item: item("skill", "handoff"), document: { frontmatter: { description: "Write a handoff" }, body: "# Handoff\nSteps." }, files: ["scripts/run.sh"] };
  const api = new FakeDaemonApi().on("GET", path, reply(detail));
  const small = await call(api, "get_agent_profile_item", { agent: "claude", id: "skill:handoff" });
  assert.deepEqual(small.document, { frontmatter: { description: "Write a handoff" }, body: "# Handoff\nSteps." });
  assert.deepEqual(small.files, ["scripts/run.sh"]);
  assert.equal(small.bodyTruncated, undefined);
  const original = "😀".repeat(40_000);
  api.on("GET", path, reply({ ...detail, document: { frontmatter: {}, body: original } }));
  const result = await call(api, "get_agent_profile_item", { agent: "claude", id: "skill:handoff" });
  const body = (result.document as { body: string }).body;
  assert.equal(result.bodyTruncated, true);
  assert.equal(result.bodyChars, 80_000);
  assert.ok(body.length > 0 && body.length < 80_000 && original.startsWith(body));
  assert.doesNotMatch(body, /[\uD800-\uDBFF]$/);
  assert.ok(resultBytes(result) <= 60_000);
});

test("create_agent_profile_item: ambiguous, unsupported and malformed drafts fail before any daemon request", async () => {
  const api = new FakeDaemonApi();
  for (const args of [
    { agent: "claude" }, { agent: "claude", skill: { name: "a" }, command: { name: "b" } },
    { agent: "cursor", skill: { name: "a" } }, { agent: "claude", skill: { name: "a", descripton: "typo" } },
    { agent: "claude", mcp: { name: "x", url: "https://x", command: "y" } },
    { agent: "claude", mcp: { name: "x", transport: "stdio" } }, { agent: "claude", mcp: { name: "x", env: { A: 1 } } }
  ]) await rejects(call(api, "create_agent_profile_item", args), "INVALID_ARGUMENT");
  await rejects(call(api, "create_agent_profile_item", { agent: "codex", command: { name: "pr", body: "x" } }), "KIND_NOT_SUPPORTED");
  await rejects(call(api, "create_agent_profile_item", { agent: "opencode", hook: { event: "Stop", command: "x" } }), "KIND_NOT_SUPPORTED");
  assert.deepEqual(api.calls, []);
});

test("create_agent_profile_item: compact arguments become daemon drafts and only changed items are returned", async () => {
  const path = `${base}/items`;
  const api = new FakeDaemonApi().on("POST", path, reply({ ...mutation, snapshot: { ...mutation.snapshot, privateCredential: SECRET } }));
  const result = await call(api, "create_agent_profile_item", { agent: "claude", mcp: { name: "jira", command: "node", args: ["jira.js"], env: { TOKEN: SECRET } } });
  assert.deepEqual(request(api, "POST", path).body, { onConflict: "fail", draft: { kind: "mcp", mcp: {
    name: "jira", transport: "stdio", command: "node", args: ["jira.js"], env: [{ key: "TOKEN", value: SECRET }] } } });
  assert.deepEqual((result.items as { id: string }[]).map((entry) => entry.id), ["mcp:jira"]);
  assert.equal(result.snapshot, undefined);
  noSecret(result);
  await call(api, "create_agent_profile_item", { agent: "claude", mcp: { name: "remote", url: "https://mcp.example/x", headers: { Authorization: SECRET } }, onConflict: "replace" });
  assert.deepEqual(request(api, "POST", path).body, { onConflict: "replace", draft: { kind: "mcp", mcp: {
    name: "remote", transport: "http", url: "https://mcp.example/x", headers: [{ key: "Authorization", value: SECRET }] } } });
  await call(api, "create_agent_profile_item", { agent: "claude", skill: { name: "review", frontmatter: { description: "Review a diff" }, body: "Steps" } });
  assert.deepEqual(request(api, "POST", path).body, { onConflict: "fail", draft: { kind: "skill", document: {
    name: "review", frontmatter: { description: "Review a diff" }, body: "Steps" } } });
  await call(api, "create_agent_profile_item", { agent: "claude", command: { name: "git/pr" } });
  assert.deepEqual(request(api, "POST", path).body, { onConflict: "fail", draft: { kind: "command", document: { name: "git/pr", frontmatter: {}, body: "" } } });
});

test("update_agent_profile_item: keep, replace, remove and add secrets without resolving their values", async () => {
  const api = new FakeDaemonApi().on("GET", mcpPath, reply(mcpDetail)).on("PUT", mcpPath, reply(mutation));
  const result = await call(api, "update_agent_profile_item", { agent: "claude", id: "mcp:jira", mcp: {
    args: ["jira.js", "--v2"], env: { TOKEN: SECRET, EMAIL: null, EXTRA: "new", ABSENT: null }, advanced: { timeout: null } } });
  assert.deepEqual(request(api, "PUT", mcpPath).body, { revision: "item-r1", draft: { kind: "mcp", mcp: {
    name: "jira", transport: "stdio", command: "node", args: ["jira.js", "--v2"],
    env: [{ key: "TOKEN", value: SECRET }, { key: "REGION", keep: true }, { key: "EXTRA", value: "new" }] } } });
  noSecret(result);
  await call(api, "update_agent_profile_item", { agent: "claude", id: "mcp:jira", mcp: { name: "renamed" } });
  assert.deepEqual((request(api, "PUT", mcpPath).body as { draft: { mcp: { env: unknown } } }).draft.mcp.env,
    [{ key: "TOKEN", keep: true }, { key: "EMAIL", keep: true }, { key: "REGION", keep: true }]);
  await rejects(call(api, "update_agent_profile_item", { agent: "claude", id: "mcp:jira", mcp: { transport: "http" } }), "INVALID_ARGUMENT");
  await rejects(call(api, "update_agent_profile_item", { agent: "claude", id: "mcp:jira", mcp: { headers: { A: "b" } } }), "INVALID_ARGUMENT");
  await call(api, "update_agent_profile_item", { agent: "claude", id: "mcp:jira", mcp: { name: "jira-cloud", transport: "http", url: "https://jira.example/mcp", headers: { Authorization: SECRET } } });
  assert.deepEqual(request(api, "PUT", mcpPath).body, { revision: "item-r1", draft: { kind: "mcp", mcp: {
    name: "jira-cloud", transport: "http", url: "https://jira.example/mcp", headers: [{ key: "Authorization", value: SECRET }], advanced: { timeout: 60000 } } } });
});

test("update_agent_profile_item: explicit stale revisions survive and conflicts include the fresh item or itemGone", async () => {
  const api = new FakeDaemonApi().on("GET", mcpPath, reply(mcpDetail)).on("PUT", mcpPath, conflict)
    .on("GET", base, reply(snapshot([item("mcp", "jira", { revision: "item-r2" })])));
  const args = { agent: "claude", id: "mcp:jira", revision: "old", mcp: { env: { TOKEN: SECRET } } };
  const error = await rejects(call(api, "update_agent_profile_item", args), "PROFILE_CONFLICT");
  assert.equal((request(api, "PUT", mcpPath).body as { revision: string }).revision, "old");
  const detail = error.detail as { item: { id: string; revision: string } };
  assert.equal(detail.item.id, "mcp:jira");
  assert.equal(detail.item.revision, "item-r2");
  noSecret(toSafeToolError(error));
  api.on("GET", base, reply(snapshot()));
  assert.deepEqual((await rejects(call(api, "update_agent_profile_item", args), "PROFILE_CONFLICT")).detail, { itemGone: true });
});

test("update_agent_profile_item: partial document and hook edits preserve omitted fields and reject a wrong kind", async () => {
  const skillPath = `${base}/items/skill%3Ahandoff`;
  const hookPath = `${base}/items/hook%3AStop%3Aaaaaaaaaaaaaaaaa`;
  const api = new FakeDaemonApi().on("GET", skillPath, reply({ kind: "skill", item: item("skill", "handoff"),
    document: { frontmatter: { description: "Old", model: "fast" }, body: "# Handoff\n\nSteps." } }))
    .on("PUT", skillPath, reply(mutation)).on("GET", hookPath, reply({ kind: "hook", item: item("hook", "Stop"),
      hook: { event: "Stop", matcher: "Bash", command: "notify", timeoutSec: 5 } })).on("PUT", hookPath, reply(mutation));
  await call(api, "update_agent_profile_item", { agent: "claude", id: "skill:handoff", skill: { frontmatter: { description: "New", model: null } } });
  assert.deepEqual(request(api, "PUT", skillPath).body, { revision: "item-r1", draft: { kind: "skill", document: {
    name: "handoff", frontmatter: { description: "New", model: null }, body: "# Handoff\n\nSteps." } } });
  await call(api, "update_agent_profile_item", { agent: "claude", id: "skill:handoff", skill: { name: "hand-off", body: "New body" } });
  assert.deepEqual(request(api, "PUT", skillPath).body, { revision: "item-r1", draft: { kind: "skill", document: { name: "hand-off", frontmatter: {}, body: "New body" } } });
  await call(api, "update_agent_profile_item", { agent: "claude", id: "hook:Stop:aaaaaaaaaaaaaaaa", hook: { matcher: null, timeoutSec: 30 } });
  assert.deepEqual(request(api, "PUT", hookPath).body, { revision: "item-r1", draft: { kind: "hook", hook: { event: "Stop", command: "notify", timeoutSec: 30 } } });
  await rejects(call(api, "update_agent_profile_item", { agent: "claude", id: "skill:handoff", mcp: { args: [] } }), "INVALID_ARGUMENT");
  await rejects(call(api, "update_agent_profile_item", { agent: "claude", id: "skill:handoff" }), "INVALID_ARGUMENT");
  api.on("GET", `${base}/items/plugin%3Aofficial`, reply({ kind: "plugin", item: item("plugin", "official"), plugin: {} }));
  await rejects(call(api, "update_agent_profile_item", { agent: "claude", id: "plugin:official", skill: { body: "x" } }), "KIND_NOT_SUPPORTED");
});

test("set_agent_profile_item_enabled: uses current or explicit revision and refuses absent targets", async () => {
  const path = `${mcpPath}/enabled`;
  const api = new FakeDaemonApi().on("GET", base, reply(snapshot([item("mcp", "jira")])))
    .on("POST", path, reply(mutation));
  await call(api, "set_agent_profile_item_enabled", { agent: "claude", id: "mcp:jira", enabled: false });
  assert.deepEqual(request(api, "POST", path).body, { revision: "item-r1", enabled: false });
  await call(api, "set_agent_profile_item_enabled", { agent: "claude", id: "mcp:jira", enabled: true, revision: "explicit-r0" });
  assert.deepEqual(request(api, "POST", path).body, { revision: "explicit-r0", enabled: true });
  await rejects(call(api, "set_agent_profile_item_enabled", { agent: "claude", id: "skill:ghost", enabled: true }), "ITEM_NOT_FOUND");
  api.on("GET", base, reply({ ...snapshot(), installed: false }));
  await rejects(call(api, "set_agent_profile_item_enabled", { agent: "claude", id: "mcp:jira", enabled: true }), "AGENT_NOT_INSTALLED");
});

test("delete_agent_profile_item: confirmation is required and the current revision guards deletion", async () => {
  const api = new FakeDaemonApi().on("GET", base, reply(snapshot([item("mcp", "jira")]))).on("DELETE", mcpPath, reply(mutation));
  await rejects(call(api, "delete_agent_profile_item", { agent: "claude", id: "mcp:jira" }), "INVALID_ARGUMENT");
  await rejects(call(api, "delete_agent_profile_item", { agent: "claude", id: "mcp:jira", confirm: false }), "INVALID_ARGUMENT");
  assert.deepEqual(api.calls, []);
  const result = await call(api, "delete_agent_profile_item", { agent: "claude", id: "mcp:jira", confirm: true });
  assert.deepEqual(request(api, "DELETE", mcpPath).query, { revision: "item-r1" });
  assert.deepEqual(result, { deleted: true, agent: "claude", id: "mcp:jira", notes: [] });
});

test("copy_agent_profile_item and trust_agent_profile_hook: target identity, collision policy and hook revision", async () => {
  const api = new FakeDaemonApi().on("POST", `${mcpPath}/copy`, reply({ snapshot: snapshot([item("mcp", "jira-copy")], "opencode"), itemIds: ["mcp:jira-copy"], notes: [] }));
  const result = await call(api, "copy_agent_profile_item", { agent: "claude", id: "mcp:jira", toAgent: "opencode", onConflict: "keep-both" });
  assert.deepEqual(request(api, "POST", `${mcpPath}/copy`).body, { toAgent: "opencode", onConflict: "keep-both" });
  assert.equal(result.agent, "opencode");
  assert.equal(result.fromAgent, "claude");
  assert.equal(result.fromId, "mcp:jira");
  assert.deepEqual((result.items as { id: string }[]).map((entry) => entry.id), ["mcp:jira-copy"]);
  const hook = item("hook", "Stop", { id: "hook:Stop:bbbbbbbbbbbbbbbb", revision: "hook-r3" });
  const path = "/api/agent-profile/codex/items/hook%3AStop%3Abbbbbbbbbbbbbbbb/trust";
  api.on("GET", "/api/agent-profile/codex", reply(snapshot([hook], "codex"))).on("POST", path, reply({ snapshot: snapshot([hook], "codex"), itemIds: [hook.id], notes: [] }));
  await call(api, "trust_agent_profile_hook", { agent: "codex", id: "hook:Stop:bbbbbbbbbbbbbbbb" });
  assert.deepEqual(request(api, "POST", path).body, { revision: "hook-r3" });
});

test("agent instructions: Unicode pages reassemble; writes preserve complete text and revision guards; conflicts name fresh info", async () => {
  const path = `${base}/instructions`;
  const original = "line — 😀\n".repeat(12_000);
  const api = new FakeDaemonApi().on("GET", path, reply({ text: original, info: instructions })).on("PUT", path, reply(mutation));
  let assembled = "";
  let offset = 0;
  for (let pages = 0; pages < 10; pages += 1) {
    const page = await call(api, "get_agent_instructions", { agent: "claude", offset });
    assert.ok(resultBytes(page) <= 60_000);
    assembled += page.text as string;
    if (page.nextOffset === undefined) break;
    assert.equal(page.truncated, true);
    assert.ok((page.nextOffset as number) > offset);
    offset = page.nextOffset as number;
  }
  assert.equal(assembled, original);
  await rejects(call(api, "get_agent_instructions", { agent: "claude", offset: original.length + 1 }), "INVALID_ARGUMENT");
  await call(api, "write_agent_instructions", { agent: "claude", text: "# New rules\n" });
  assert.deepEqual(request(api, "PUT", path).body, { text: "# New rules\n", revision: "instructions-r1" });
  await call(api, "write_agent_instructions", { agent: "claude", text: "Create only", revision: "" });
  assert.deepEqual(request(api, "PUT", path).body, { text: "Create only", revision: "" });
  api.on("PUT", path, conflict).on("GET", path, reply({ text: "Changed", info: { ...instructions, revision: "instructions-r2" } }));
  const error = await rejects(call(api, "write_agent_instructions", { agent: "claude", text: "x", revision: "stale" }), "PROFILE_CONFLICT");
  assert.deepEqual(request(api, "PUT", path).body, { text: "x", revision: "stale" });
  assert.equal((error.detail as { instructions: { revision: string } }).instructions.revision, "instructions-r2");
});

test("import_agent_profile_items: scan and take are exclusive; URL stays private and selected refs become the import request", async () => {
  const url = `https://user:${SECRET}@git.example/skills.git`;
  const api = new FakeDaemonApi().on("POST", `${base}/imports/git`, reply({ importId: "scan-id", url,
    candidates: [{ ref: "skills/alpha", kind: "skill", name: "alpha", exists: false }, { ref: "skills/beta", kind: "skill", name: "beta", exists: true }], notes: [] }))
    .on("POST", `${base}/items`, reply(mutation));
  await rejects(call(api, "import_agent_profile_items", { agent: "claude" }), "INVALID_ARGUMENT");
  await rejects(call(api, "import_agent_profile_items", { agent: "claude", url, importId: "scan-id", picks: ["a"] }), "INVALID_ARGUMENT");
  await rejects(call(api, "import_agent_profile_items", { agent: "claude", importId: "scan-id" }), "INVALID_ARGUMENT");
  assert.deepEqual(api.calls, []);
  const result = await call(api, "import_agent_profile_items", { agent: "claude", url });
  assert.deepEqual(request(api, "POST", `${base}/imports/git`).body, { url });
  assert.equal(result.importId, "scan-id");
  assert.deepEqual((result.candidates as { ref: string; exists: boolean }[]).map((entry) => [entry.ref, entry.exists]), [["skills/alpha", false], ["skills/beta", true]]);
  assert.equal(result.url, undefined);
  noSecret(result);
  await call(api, "import_agent_profile_items", { agent: "claude", importId: "scan-id", picks: ["skills/alpha"], onConflict: "replace" });
  assert.deepEqual(request(api, "POST", `${base}/items`).body, { import: { importId: "scan-id", picks: ["skills/alpha"] }, onConflict: "replace" });
});
