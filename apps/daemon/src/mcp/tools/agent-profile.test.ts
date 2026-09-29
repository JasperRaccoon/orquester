import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type {
  AgentProfileAgentId,
  McpServerDraft,
  ProfileItem,
  ProfileItemDetail,
  ProfileItemDraft,
  ProfileItemKind,
  SecretEntryDraft
} from "@orquester/api";
import type { DaemonMethod, DaemonResponse } from "../daemon-api.ts";
import { ToolError } from "../errors.ts";
import { ok, toSafeToolError } from "../result.ts";
import { FakeDaemonApi } from "../testing.ts";
import type { ToolContext } from "../tool.ts";
import { agentProfileTools, mergeSecretEntries, redactUrlCredentials } from "./agent-profile.ts";

type Result = Record<string, unknown>;
const resultBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

// Every secret value the tests ever write. None may appear in any result or error, anywhere.
const SECRETS = ["sk-live-SECRET-0001", "hunter2-SECRET-0002", "Bearer SECRET-0003", "SECRET-0004-rotated", "SECRET-0005-url-token"];

const err = (status: number, code: string, message: string): DaemonResponse => ({ status, body: { error: { code, message } } });

interface McpState { name: string; transport: "stdio" | "http" | "sse"; command?: string; args?: string[]; cwd?: string; url?: string; env: Record<string, string>; headers: Record<string, string>; advanced?: Record<string, unknown> }

/**
 * An in-memory agent-profile daemon: the routes of `agentProfileRoutes` answering what `@orquester/api`'s agent-profile
 * types promise, holding REAL secret values (as the adapters do) and — like the real routes — never answering one.
 * `leaky` makes the detail route misbehave (a secret value next to its key) to prove the tools strip it anyway.
 * FakeDaemonApi's own `on` routes still win, so a test can override any route.
 */
class FakeProfileDaemon extends FakeDaemonApi {
  items = new Map<AgentProfileAgentId, ProfileItem[]>([["claude", []], ["codex", []], ["grok", []], ["opencode", []]]);
  mcps = new Map<string, McpState>();
  docs = new Map<string, { frontmatter: Record<string, unknown>; body: string }>();
  hooks = new Map<string, { event: string; matcher?: string; command: string; timeoutSec?: number }>();
  instructions = new Map<AgentProfileAgentId, string>();
  installed = new Set<AgentProfileAgentId>(["claude", "codex", "opencode"]);
  imports = new Map<string, { ref: string; name: string }[]>();
  leaky = false;
  /** Drafts as they reached the daemon, for assertions on what the tool sent. */
  drafts: unknown[] = [];
  private rev = 0;

  nextRevision(): string { return `r${(this.rev += 1)}`; }

  add(agent: AgentProfileAgentId, kind: ProfileItemKind, name: string, patch: Partial<ProfileItem> = {}): ProfileItem {
    const item: ProfileItem = {
      id: `${kind}:${name}`, kind, name, enabled: true, toggleable: true, editable: true, deletable: true, locked: false,
      source: { type: "user", label: "User" }, revision: this.nextRevision(), warnings: [], ...patch
    };
    this.items.get(agent)!.push(item);
    return item;
  }

  find(agent: AgentProfileAgentId, id: string): ProfileItem | undefined { return this.items.get(agent)!.find((i) => i.id === id); }

  /** Something changed the item on disk behind the caller's back. */
  touch(agent: AgentProfileAgentId, id: string): string {
    const item = this.find(agent, id)!;
    item.revision = this.nextRevision();
    return item.revision;
  }

  override async request(method: DaemonMethod, path: string, opts?: { query?: Record<string, string>; body?: unknown }): Promise<DaemonResponse> {
    const canned = await super.request(method, path, opts);
    const miss = canned.status === 404 && typeof (canned.body as { message?: unknown })?.message === "string" && (canned.body as { message: string }).message.startsWith("no fake route");
    if (!miss) return canned;
    const parts = path.split("/").slice(1).map(decodeURIComponent); // ["api", "agent-profile", agent, …]
    if (parts[0] !== "api" || parts[1] !== "agent-profile") return { status: 404, body: { code: "NOT_FOUND", message: "not a route" } };
    if (parts.length === 2 && method === "GET") {
      return { status: 200, body: { agents: [...this.items.keys()].map((agent) => ({ agent, installed: this.installed.has(agent), ...(agent === "claude" ? { version: "2.1.0" } : {}), counts: this.counts(agent) })) } };
    }
    const agent = parts[2] as AgentProfileAgentId;
    if (!this.items.has(agent)) return err(404, "UNKNOWN_AGENT", `Unknown agent "${agent}".`);
    const rest = parts.slice(3);
    if (rest.length === 0 && method === "GET") return { status: 200, body: this.snapshot(agent) };
    if (!this.installed.has(agent)) return err(404, "AGENT_NOT_INSTALLED", "Grok is not installed on this host.");
    const body = (opts?.body ?? {}) as Record<string, unknown>;
    if (rest[0] === "items" && rest.length === 1 && method === "POST") return this.create(agent, body);
    if (rest[0] === "items" && rest.length >= 2) {
      const id = rest[1]!;
      const item = this.find(agent, id);
      if (!item) return err(404, "ITEM_NOT_FOUND", `No item "${id}".`);
      if (rest.length === 2 && method === "GET") return { status: 200, body: this.detail(agent, item) };
      if (rest[2] === "copy" && method === "POST") return this.copy(agent, item, body);
      const revision = method === "DELETE" ? opts?.query?.revision : body.revision;
      if (revision !== item.revision) return err(409, "PROFILE_CONFLICT", "It changed on disk since you loaded it. The list has been refreshed.");
      if (rest.length === 2 && method === "PUT") return this.update(agent, item, body.draft as ProfileItemDraft);
      if (rest.length === 2 && method === "DELETE") {
        this.items.set(agent, this.items.get(agent)!.filter((i) => i !== item));
        return this.mutation(agent, [id], ["Deleted."]);
      }
      if (rest[2] === "enabled" && method === "POST") {
        item.enabled = body.enabled as boolean;
        item.revision = this.nextRevision();
        return this.mutation(agent, [id]);
      }
      if (rest[2] === "trust" && method === "POST") {
        item.warnings = [];
        item.revision = this.nextRevision();
        return this.mutation(agent, [id]);
      }
    }
    if (rest[0] === "instructions" && method === "GET") return { status: 200, body: { text: this.instructions.get(agent) ?? "", info: this.info(agent) } };
    if (rest[0] === "instructions" && method === "PUT") {
      if (body.revision !== this.info(agent).revision) return err(409, "PROFILE_CONFLICT", "It changed on disk since you loaded it. The list has been refreshed.");
      this.instructions.set(agent, body.text as string);
      return this.mutation(agent, []);
    }
    if (rest[0] === "imports" && rest[1] === "git" && method === "POST") {
      // As the real route: the URL (which may carry a token) is never quoted back.
      const importId = `imp-${this.imports.size + 1}`;
      this.imports.set(importId, [{ ref: "skills/alpha", name: "alpha" }, { ref: "skills/beta", name: "beta" }]);
      return { status: 200, body: { importId, candidates: [{ ref: "skills/alpha", kind: "skill", name: "alpha", description: "Alpha", exists: false }, { ref: "skills/beta", kind: "skill", name: "beta", exists: true }], notes: ["Skipped symlink skills/x"] } };
    }
    if (rest[0] === "marketplaces" && rest[2] === "plugins" && method === "GET") {
      return { status: 200, body: { plugins: [{ name: "superpowers", description: "Skills", version: "1.0.0", installed: true }, { name: "other", installed: false }] } };
    }
    return { status: 404, body: { code: "NOT_FOUND", message: "not a route" } };
  }

  private counts(agent: AgentProfileAgentId): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const item of this.items.get(agent)!) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    return counts;
  }

  info(agent: AgentProfileAgentId) {
    const text = this.instructions.get(agent);
    return { path: `/home/u/.${agent}/AGENTS.md`, exists: text !== undefined, bytes: text?.length ?? 0, lines: text ? text.split("\n").length : 0, revision: text === undefined ? "" : `i-${text.length}-${text.slice(0, 8)}`, warnings: [] };
  }

  snapshot(agent: AgentProfileAgentId) {
    const installed = this.installed.has(agent);
    return { agent, installed, revision: this.nextRevision(), instructions: this.info(agent), items: installed ? this.items.get(agent)!.map((i) => ({ ...i })) : [], fileErrors: [], readAt: "2026-09-29T10:00:00.000Z" };
  }

  private mutation(agent: AgentProfileAgentId, itemIds: string[], notes: string[] = []): DaemonResponse {
    return { status: 200, body: { snapshot: this.snapshot(agent), itemIds, notes } };
  }

  private keys(map: Record<string, string>) {
    return Object.entries(map).map(([key, value]) => (this.leaky ? { key, set: true, value } : { key, set: true }));
  }

  private detail(agent: AgentProfileAgentId, item: ProfileItem): ProfileItemDetail {
    const key = `${agent}/${item.id}`;
    if (item.kind === "mcp") {
      const m = this.mcps.get(key)!;
      const mcp = { name: m.name, transport: m.transport, ...(m.command ? { command: m.command } : {}), ...(m.args ? { args: m.args } : {}), ...(m.cwd ? { cwd: m.cwd } : {}), ...(m.url ? { url: m.url } : {}), env: this.keys(m.env), headers: this.keys(m.headers), ...(m.advanced ? { advanced: m.advanced } : {}) };
      return { kind: "mcp", item, mcp } as ProfileItemDetail;
    }
    if (item.kind === "skill" || item.kind === "command") return { kind: item.kind, item, document: this.docs.get(key)!, ...(item.kind === "skill" ? { files: ["scripts/run.sh"] } : {}) };
    if (item.kind === "hook") return { kind: "hook", item, hook: this.hooks.get(key)! };
    if (item.kind === "plugin") return { kind: "plugin", item, plugin: { id: item.id, name: item.name } };
    return { kind: "marketplace", item, marketplace: { name: item.name, source: { type: "github", repo: "o/r" } } };
  }

  /** Secret drafts resolved against the stored values, as the adapters do (`keep` needs a current value). */
  private resolve(drafts: SecretEntryDraft[] | undefined, current: Record<string, string>): Record<string, string> | DaemonResponse {
    const out: Record<string, string> = {};
    for (const d of drafts ?? []) {
      if ("keep" in d) {
        if (!(d.key in current)) return err(400, "INVALID_ITEM", `"${d.key}" has no current value to keep; enter one.`);
        out[d.key] = current[d.key]!;
      } else out[d.key] = d.value;
    }
    return out;
  }

  private storeMcp(agent: AgentProfileAgentId, id: string, draft: McpServerDraft, current?: McpState): DaemonResponse | null {
    const env = this.resolve(draft.env, current?.env ?? {});
    if ("status" in env) return env as DaemonResponse;
    const headers = this.resolve(draft.headers, current?.headers ?? {});
    if ("status" in headers) return headers as DaemonResponse;
    this.mcps.set(`${agent}/${id}`, { name: draft.name, transport: draft.transport, command: draft.command, args: draft.args, cwd: draft.cwd, url: draft.url, env: env as Record<string, string>, headers: headers as Record<string, string>, advanced: draft.advanced });
    return null;
  }

  private create(agent: AgentProfileAgentId, body: Record<string, unknown>): DaemonResponse {
    if (body.import) {
      const { importId, picks } = body.import as { importId: string; picks: string[] };
      const found = this.imports.get(importId);
      if (!found) return err(404, "IMPORT_NOT_FOUND", `Import "${importId}" expired or does not exist. Scan again.`);
      const ids = found.filter((c) => picks.includes(c.ref)).map((c) => {
        const item = this.add(agent, "skill", c.name);
        this.docs.set(`${agent}/${item.id}`, { frontmatter: { name: c.name }, body: "" });
        return item.id;
      });
      return { status: 201, body: { snapshot: this.snapshot(agent), itemIds: ids, notes: [] } };
    }
    const draft = body.draft as ProfileItemDraft;
    this.drafts.push(draft);
    const name = draft.kind === "mcp" ? draft.mcp.name : draft.kind === "skill" || draft.kind === "command" ? draft.document.name : draft.kind === "hook" ? `${draft.hook.event}-hook` : draft.kind === "plugin" ? ("plugin" in draft.plugin ? `${draft.plugin.plugin}@${draft.plugin.marketplace}` : draft.plugin.spec) : draft.marketplace.name ?? "market";
    const id = `${draft.kind}:${name}`;
    if (this.find(agent, id) && body.onConflict === "fail") return err(409, "ITEM_EXISTS", `"${name}" already exists.`);
    const item = this.add(agent, draft.kind, name, draft.kind === "mcp" ? { meta: { transport: draft.mcp.transport } } : {});
    if (draft.kind === "mcp") {
      const refused = this.storeMcp(agent, item.id, draft.mcp);
      if (refused) return refused;
    }
    if (draft.kind === "skill" || draft.kind === "command") this.docs.set(`${agent}/${item.id}`, { frontmatter: draft.document.frontmatter, body: draft.document.body });
    if (draft.kind === "hook") this.hooks.set(`${agent}/${item.id}`, draft.hook);
    return { status: 201, body: { snapshot: this.snapshot(agent), itemIds: [item.id], notes: draft.kind === "mcp" ? ["Servers restart when idle."] : [] } };
  }

  private update(agent: AgentProfileAgentId, item: ProfileItem, draft: ProfileItemDraft): DaemonResponse {
    this.drafts.push(draft);
    const oldKey = `${agent}/${item.id}`;
    if (draft.kind === "mcp") {
      const refused = this.storeMcp(agent, `mcp:${draft.mcp.name}`, draft.mcp, this.mcps.get(oldKey));
      if (refused) return refused;
      if (draft.mcp.name !== item.name) this.mcps.delete(oldKey);
      item.name = draft.mcp.name;
      item.id = `mcp:${draft.mcp.name}`;
    } else if (draft.kind === "skill" || draft.kind === "command") {
      const current = this.docs.get(oldKey)!;
      const frontmatter: Record<string, unknown> = { ...current.frontmatter };
      for (const [k, v] of Object.entries(draft.document.frontmatter)) if (v === null) delete frontmatter[k]; else frontmatter[k] = v;
      this.docs.delete(oldKey);
      item.name = draft.document.name;
      item.id = `${draft.kind}:${draft.document.name}`;
      this.docs.set(`${agent}/${item.id}`, { frontmatter, body: draft.document.body });
    } else if (draft.kind === "hook") {
      this.hooks.delete(oldKey);
      item.id = `hook:${draft.hook.event}:${String(this.rev).padStart(16, "0")}`;
      this.hooks.set(`${agent}/${item.id}`, draft.hook);
    }
    item.revision = this.nextRevision();
    return this.mutation(agent, [item.id]);
  }

  private copy(agent: AgentProfileAgentId, item: ProfileItem, body: Record<string, unknown>): DaemonResponse {
    const to = body.toAgent as AgentProfileAgentId;
    const copy = this.add(to, item.kind, item.name);
    if (item.kind === "mcp") this.mcps.set(`${to}/${copy.id}`, { ...this.mcps.get(`${agent}/${item.id}`)! });
    return this.mutation(to, [copy.id], ["Dropped Claude-only settings: timeout."]);
  }
}

const ctx = (api: FakeDaemonApi): ToolContext => ({ api, todos: {} as never, files: {} as never, signal: new AbortController().signal, now: () => Date.parse("2026-09-29T12:00:00.000Z") });

/** Everything every tool answered in a test — results and errors — for the secret sweep. */
const seen: string[] = [];

/** A tool call as tools/call makes it: the strict schema (defaults applied), then run, then ok()'s cap. */
async function call(api: FakeDaemonApi, name: string, args: Record<string, unknown>): Promise<Result> {
  const tool = agentProfileTools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name}`);
  const parsed = z.object(tool.input).strict().safeParse(args);
  if (!parsed.success) {
    const error = new ToolError("INVALID_ARGUMENT", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    seen.push(JSON.stringify(toSafeToolError(error)));
    throw error;
  }
  try {
    const result = await tool.run(parsed.data as never, ctx(api));
    seen.push(JSON.stringify(ok(result)));
    assert.ok(resultBytes(result) <= 60_000, `${name} stays under the cap (${resultBytes(result)} bytes)`);
    assert.equal(ok(result).structuredContent, result, `${name} is never cut by ok()`);
    return result;
  } catch (error) {
    seen.push(JSON.stringify(toSafeToolError(error)));
    throw error;
  }
}

async function rejects(p: Promise<unknown>, code: string, match?: RegExp): Promise<ToolError> {
  let caught: unknown;
  await p.then(() => assert.fail(`expected ${code}`), (e) => { caught = e; });
  assert.ok(caught instanceof ToolError, `a ToolError, got ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  if (match) assert.match(caught.message, match);
  return caught;
}

function assertNoSecrets(text: string, where: string): void {
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `${where} leaks ${secret}`);
}

const routes = (api: FakeDaemonApi) => api.calls.map((c) => `${c.method} ${c.path}`);

/** A daemon holding one stdio MCP server with two secrets, a skill, a hook and instructions. */
function seeded(): FakeProfileDaemon {
  const api = new FakeProfileDaemon();
  api.add("claude", "mcp", "jira", { description: "Jira tools", meta: { transport: "stdio" } });
  api.mcps.set("claude/mcp:jira", { name: "jira", transport: "stdio", command: "node", args: ["jira.js"], env: { JIRA_TOKEN: SECRETS[0]!, JIRA_EMAIL: SECRETS[1]! }, headers: {}, advanced: { timeout: 60000 } });
  api.add("claude", "skill", "handoff", { description: "Write a handoff" });
  api.docs.set("claude/skill:handoff", { frontmatter: { name: "handoff", description: "Write a handoff" }, body: "# Handoff\n\nSteps." });
  api.add("claude", "hook", "Stop", { id: "hook:Stop:aaaaaaaaaaaaaaaa" });
  api.hooks.set("claude/hook:Stop:aaaaaaaaaaaaaaaa", { event: "Stop", matcher: "Bash", command: "notify", timeoutSec: 5 });
  api.add("claude", "plugin", "superpowers@official", { source: { type: "user", label: "User" }, toggleable: true });
  api.add("claude", "skill", "brainstorming", { editable: false, deletable: false, source: { type: "plugin", label: "Plugin · superpowers", pluginId: "superpowers@official" } });
  api.instructions.set("claude", "# Rules\n\nBe brief.\n");
  return api;
}

// ---------------------------------------------------------------------------

test("list_agent_profiles: every agent with installed, version and counts; installedOnly filters", async () => {
  const api = seeded();
  const all = await call(api, "list_agent_profiles", {});
  const agents = all.agents as { agent: string; installed: boolean; version?: string; counts: Record<string, number>; label: string }[];
  assert.deepEqual(agents.map((a) => a.agent), ["claude", "codex", "grok", "opencode"]);
  assert.deepEqual(agents[0], { agent: "claude", label: "Claude", installed: true, version: "2.1.0", counts: { mcp: 1, skill: 2, hook: 1, plugin: 1 } });
  const installed = await call(api, "list_agent_profiles", { installedOnly: true });
  assert.deepEqual((installed.agents as { agent: string }[]).map((a) => a.agent), ["claude", "codex", "opencode"]);
});

test("get_agent_profile: items with their flags and revisions, instructions, authoring; kind and query filter", async () => {
  const api = seeded();
  const r = await call(api, "get_agent_profile", { agent: "claude" });
  assert.equal(r.installed, true);
  assert.equal(r.truncated, false);
  assert.equal(r.matched, 5);
  assert.deepEqual(r.counts, { mcp: 1, skill: 2, hook: 1, plugin: 1 });
  const items = r.items as Record<string, unknown>[];
  const brainstorming = items.find((i) => i.id === "skill:brainstorming")!;
  assert.equal(brainstorming.editable, false);
  assert.equal(brainstorming.sourceType, "plugin");
  assert.equal(brainstorming.pluginId, "superpowers@official");
  assert.equal(brainstorming.source, "Plugin · superpowers");
  assert.equal(typeof brainstorming.revision, "string");
  assert.deepEqual((r.instructions as Record<string, unknown>).exists, true);
  const authoring = r.authoring as Record<string, unknown>;
  assert.ok((authoring.creatableKinds as string[]).includes("command"));
  assert.ok((authoring.hookEvents as string[]).includes("PreToolUse"));
  assert.deepEqual(authoring.mcpTransports, ["stdio", "http", "sse"]);

  const skills = await call(api, "get_agent_profile", { agent: "claude", kind: "skill" });
  assert.deepEqual((skills.items as { id: string }[]).map((i) => i.id), ["skill:handoff", "skill:brainstorming"]);
  const query = await call(api, "get_agent_profile", { agent: "claude", query: "SUPERPOWERS" });
  assert.deepEqual((query.items as { id: string }[]).map((i) => i.id).sort(), ["plugin:superpowers@official", "skill:brainstorming"]);

  // Codex cannot create commands: authoring says so.
  const codex = await call(api, "get_agent_profile", { agent: "codex" });
  assert.ok(!((codex.authoring as Record<string, string[]>).creatableKinds).includes("command"));
  // A not-installed agent answers with a note, not an error.
  const grok = await call(api, "get_agent_profile", { agent: "grok" });
  assert.equal(grok.installed, false);
  assert.match(String(grok.note), /not installed/);
});

test("get_agent_profile: a list too big for one result keeps its head and says so", async () => {
  const api = new FakeProfileDaemon();
  for (let i = 0; i < 1_500; i += 1) api.add("claude", "skill", `skill-${i}`, { description: "d".repeat(250) });
  const r = await call(api, "get_agent_profile", { agent: "claude" });
  assert.equal(r.truncated, true);
  assert.equal(r.matched, 1_500);
  const kept = (r.items as unknown[]).length;
  assert.ok(kept > 50 && kept < 1_500, `${kept} kept`);
  assert.equal(r.omitted, 1_500 - kept);
  assert.match(String(r.note), /kind or query/);
});

test("get_agent_profile_item: an MCP server shows its secret KEYS only — even when the daemon sends a value", async () => {
  const api = seeded();
  api.leaky = true;
  const r = await call(api, "get_agent_profile_item", { agent: "claude", id: "mcp:jira" });
  const mcp = r.mcp as Record<string, unknown>;
  assert.deepEqual(mcp.env, [{ key: "JIRA_TOKEN", set: true }, { key: "JIRA_EMAIL", set: true }]);
  assert.deepEqual(mcp.headers, []);
  assert.equal(mcp.command, "node");
  assert.deepEqual(mcp.advanced, { timeout: 60000 });
  assertNoSecrets(JSON.stringify(ok(r)), "get_agent_profile_item");
  assert.match(String(r.secretsNote), /write-only/);
});

test("get_agent_profile_item: credentials written into a server or marketplace URL are shown as ***", async () => {
  assert.equal(redactUrlCredentials(`https://user:${SECRETS[4]}@git.example/r.git`), "https://***@git.example/r.git");
  assert.equal(redactUrlCredentials(`https://${SECRETS[4]}@git.example/r.git`), "https://***@git.example/r.git");
  assert.equal(redactUrlCredentials(`https://user:prefix@${SECRETS[4]}@git.example/r.git`), "https://***@git.example/r.git");
  assert.equal(redactUrlCredentials("https://git.example/a@b"), "https://git.example/a@b", "an @ in the path is no credential");
  assert.equal(redactUrlCredentials(`https://user:${SECRETS[4]}@git.example:8443/a@b?tag=@next#@end`), "https://***@git.example:8443/a@b?tag=@next#@end");
  assert.equal(redactUrlCredentials("git@github.com:o/r.git"), "git@github.com:o/r.git");
  const api = seeded();
  const url = `https://bot:prefix@${SECRETS[4]}${"x".repeat(300)}@mcp.example/x`;
  // Codex descriptions, OpenCode URLs and Claude targets all carry the server URL in summaries.
  api.add("claude", "mcp", "remote", { description: url, meta: { url, target: url } });
  api.mcps.set("claude/mcp:remote", { name: "remote", transport: "http", url, env: {}, headers: { Authorization: SECRETS[3]! } });
  const remote = await call(api, "get_agent_profile_item", { agent: "claude", id: "mcp:remote" });
  const mcp = remote.mcp as Record<string, unknown>;
  assert.equal(mcp.url, "https://***@mcp.example/x");
  assert.deepEqual(mcp.headers, [{ key: "Authorization", set: true }]);
  const item = remote.item as Record<string, unknown>;
  assert.equal(item.description, "https://***@mcp.example/x", "redact before truncating a long userinfo");
  assert.deepEqual(item.meta, { url: "https://***@mcp.example/x", target: "https://***@mcp.example/x" });
  const listed = await call(api, "get_agent_profile", { agent: "claude", query: "remote" });
  assert.deepEqual((listed.items as Record<string, unknown>[])[0]!.meta, item.meta);
  assertNoSecrets(JSON.stringify(listed), "the profile list");
  // An update that does not name url keeps the real one daemon-side.
  await call(api, "update_agent_profile_item", { agent: "claude", id: "mcp:remote", mcp: { headers: { "X-Extra": "1" } } });
  assert.equal(api.mcps.get("claude/mcp:remote")!.url, url);
  api.add("claude", "marketplace", "private", {
    description: `https://x:${SECRETS[4]}@git.example/m.git`,
    meta: { source: `https://x:${SECRETS[4]}@git.example/m.git` }
  });
  api.on("GET", "/api/agent-profile/claude/items/marketplace%3Aprivate", { status: 200, body: { kind: "marketplace", item: api.find("claude", "marketplace:private"), marketplace: { name: "private", source: { type: "git", url: `https://x:${SECRETS[4]}@git.example/m.git`, ref: "main" } } } });
  const market = await call(api, "get_agent_profile_item", { agent: "claude", id: "marketplace:private" });
  assert.deepEqual((market.marketplace as { source: unknown }).source, { type: "git", url: "https://***@git.example/m.git", ref: "main" });
  assert.equal((market.item as Record<string, unknown>).description, "https://***@git.example/m.git");
  assert.deepEqual((market.item as Record<string, unknown>).meta, { source: "https://***@git.example/m.git" });
});

test("get_agent_profile_item: a skill's frontmatter, body and files; a body too big is cut and flagged", async () => {
  const api = seeded();
  const r = await call(api, "get_agent_profile_item", { agent: "claude", id: "skill:handoff" });
  assert.deepEqual(r.document, { frontmatter: { name: "handoff", description: "Write a handoff" }, body: "# Handoff\n\nSteps." });
  assert.deepEqual(r.files, ["scripts/run.sh"]);
  assert.equal(r.bodyTruncated, undefined);

  api.docs.set("claude/skill:handoff", { frontmatter: { name: "handoff" }, body: "😀".repeat(40_000) });
  const big = await call(api, "get_agent_profile_item", { agent: "claude", id: "skill:handoff" });
  assert.equal(big.bodyTruncated, true);
  assert.equal(big.bodyChars, 80_000);
  assert.match(String(big.bodyNote), /Never send a cut body back/);
  const body = (big.document as { body: string }).body;
  assert.ok(body.length > 0 && body.length < 80_000);
  assert.ok(!/[\uD800-\uDBFF]$/.test(body), "no split surrogate pair");

  const hook = await call(api, "get_agent_profile_item", { agent: "claude", id: "hook:Stop:aaaaaaaaaaaaaaaa" });
  assert.deepEqual(hook.hook, { event: "Stop", matcher: "Bash", command: "notify", timeoutSec: 5 });
  await rejects(call(api, "get_agent_profile_item", { agent: "claude", id: "mcp:nope" }), "ITEM_NOT_FOUND", /get_agent_profile lists the items/);
});

test("create_agent_profile_item: exactly one kind object; a kind the agent cannot create is refused before any call", async () => {
  const api = seeded();
  await rejects(call(api, "create_agent_profile_item", { agent: "claude" }), "INVALID_ARGUMENT", /pass one of mcp, skill/);
  await rejects(call(api, "create_agent_profile_item", { agent: "claude", skill: { name: "a" }, command: { name: "b" } }), "INVALID_ARGUMENT", /exactly one.*skill, command/);
  await rejects(call(api, "create_agent_profile_item", { agent: "codex", command: { name: "pr", body: "x" } }), "KIND_NOT_SUPPORTED", /Codex cannot create commands.*mcp, skill/);
  await rejects(call(api, "create_agent_profile_item", { agent: "opencode", hook: { event: "Stop", command: "x" } }), "KIND_NOT_SUPPORTED");
  // The schemas are strict and agent ids are an enum.
  await rejects(call(api, "create_agent_profile_item", { agent: "cursor", skill: { name: "a" } }), "INVALID_ARGUMENT", /agent/);
  await rejects(call(api, "create_agent_profile_item", { agent: "claude", skill: { name: "a", descripton: "typo" } }), "INVALID_ARGUMENT", /descripton/);
  await rejects(call(api, "create_agent_profile_item", { agent: "claude", mcp: { name: "x", url: "https://x", command: "y" } }), "INVALID_ARGUMENT", /command is not for an http server/);
  await rejects(call(api, "create_agent_profile_item", { agent: "claude", mcp: { name: "x", transport: "stdio" } }), "INVALID_ARGUMENT", /command is required/);
  await rejects(call(api, "create_agent_profile_item", { agent: "claude", mcp: { name: "x", env: { A: 1 } } }), "INVALID_ARGUMENT", /env\.A/);
  assert.deepEqual(api.calls, [], "nothing reached the daemon");
});

test("create_agent_profile_item: MCP env/headers maps become SecretEntryDrafts; the answer names ids, notes and a summary — no value", async () => {
  const api = seeded();
  const r = await call(api, "create_agent_profile_item", { agent: "claude", mcp: { name: "centur", command: "node", args: ["c.js"], env: { CENTUR_PASSWORD: SECRETS[2]! } } });
  assert.deepEqual(api.drafts.at(-1), { kind: "mcp", mcp: { name: "centur", transport: "stdio", command: "node", args: ["c.js"], env: [{ key: "CENTUR_PASSWORD", value: SECRETS[2] }] } });
  assert.equal(r.created, true);
  assert.equal(r.kind, "mcp");
  assert.deepEqual(r.itemIds, ["mcp:centur"]);
  assert.deepEqual(r.notes, ["Servers restart when idle."]);
  assert.deepEqual((r.items as { id: string }[]).map((i) => i.id), ["mcp:centur"]);
  assert.equal(r.snapshot, undefined, "never the whole snapshot");
  assertNoSecrets(JSON.stringify(ok(r)), "create_agent_profile_item");
  assert.deepEqual(api.calls.map((c) => c.body && (c.body as { onConflict?: string }).onConflict), ["fail"]);

  // A URL alone means http; headers go along.
  await call(api, "create_agent_profile_item", { agent: "claude", mcp: { name: "remote", url: "https://mcp.example/x", headers: { Authorization: SECRETS[3]! } } });
  assert.deepEqual(api.drafts.at(-1), { kind: "mcp", mcp: { name: "remote", transport: "http", url: "https://mcp.example/x", headers: [{ key: "Authorization", value: SECRETS[3] }] } });

  // Skills, commands, hooks, plugins and marketplaces go as the wire's drafts.
  await call(api, "create_agent_profile_item", { agent: "claude", skill: { name: "review", frontmatter: { description: "Review a diff" }, body: "Steps" } });
  assert.deepEqual(api.drafts.at(-1), { kind: "skill", document: { name: "review", frontmatter: { description: "Review a diff" }, body: "Steps" } });
  await call(api, "create_agent_profile_item", { agent: "claude", command: { name: "git/pr" } });
  assert.deepEqual(api.drafts.at(-1), { kind: "command", document: { name: "git/pr", frontmatter: {}, body: "" } });
  await call(api, "create_agent_profile_item", { agent: "claude", hook: { event: "PreToolUse", matcher: "Bash", command: "check", timeoutSec: 10 } });
  assert.deepEqual(api.drafts.at(-1), { kind: "hook", hook: { event: "PreToolUse", command: "check", matcher: "Bash", timeoutSec: 10 } });
  await call(api, "create_agent_profile_item", { agent: "claude", plugin: { plugin: "superpowers", marketplace: "official" }, onConflict: "replace" });
  assert.deepEqual(api.drafts.at(-1), { kind: "plugin", plugin: { plugin: "superpowers", marketplace: "official" } });
  await call(api, "create_agent_profile_item", { agent: "claude", marketplace: { source: { type: "github", repo: "o/r" } } });
  assert.deepEqual(api.drafts.at(-1), { kind: "marketplace", marketplace: { source: { type: "github", repo: "o/r" } } });

  // A name collision is the daemon's ITEM_EXISTS, passed through with a hint.
  await rejects(call(api, "create_agent_profile_item", { agent: "claude", skill: { name: "review" } }), "ITEM_EXISTS", /already exists.*onConflict/);
});

test("mergeSecretEntries: unnamed keys are kept, a string replaces, null removes, new keys are added", () => {
  const current = [{ key: "A", set: true as const }, { key: "B", set: true as const }, { key: "C", set: true as const }];
  assert.deepEqual(mergeSecretEntries(current, { B: "new-b", C: null, D: "new-d", E: null }), [
    { key: "A", keep: true }, { key: "B", value: "new-b" }, { key: "D", value: "new-d" }
  ]);
  assert.deepEqual(mergeSecretEntries(current, undefined), [{ key: "A", keep: true }, { key: "B", keep: true }, { key: "C", keep: true }]);
  assert.deepEqual(mergeSecretEntries(undefined, { X: "x" }), [{ key: "X", value: "x" }]);
});

test("update_agent_profile_item (MCP): reads the current revision, keeps unnamed secrets, replaces and removes named ones", async () => {
  const api = seeded();
  const before = api.find("claude", "mcp:jira")!.revision;
  const r = await call(api, "update_agent_profile_item", { agent: "claude", id: "mcp:jira", mcp: { args: ["jira.js", "--v2"], env: { JIRA_EMAIL: null, JIRA_REGION: "eu" }, advanced: { timeout: null } } });
  assert.deepEqual(routes(api), ["GET /api/agent-profile/claude/items/mcp%3Ajira", "PUT /api/agent-profile/claude/items/mcp%3Ajira"]);
  assert.equal((api.calls[1]!.body as { revision: string }).revision, before, "the revision read just before writing");
  assert.deepEqual(api.drafts.at(-1), { kind: "mcp", mcp: { name: "jira", transport: "stdio", command: "node", args: ["jira.js", "--v2"], env: [{ key: "JIRA_TOKEN", keep: true }, { key: "JIRA_REGION", value: "eu" }] } });
  assert.deepEqual(api.mcps.get("claude/mcp:jira")!.env, { JIRA_TOKEN: SECRETS[0], JIRA_REGION: "eu" }, "the kept secret kept its value daemon-side");
  assert.equal(r.updated, true);
  assert.deepEqual(r.itemIds, ["mcp:jira"]);
  assertNoSecrets(JSON.stringify(ok(r)), "update_agent_profile_item");

  // A rename, and a switch to http that must name the new side's url.
  await rejects(call(api, "update_agent_profile_item", { agent: "claude", id: "mcp:jira", mcp: { transport: "http" } }), "INVALID_ARGUMENT", /url is required/);
  await rejects(call(api, "update_agent_profile_item", { agent: "claude", id: "mcp:jira", mcp: { headers: { A: "b" } } }), "INVALID_ARGUMENT", /headers is not for a stdio server/);
  const renamed = await call(api, "update_agent_profile_item", { agent: "claude", id: "mcp:jira", mcp: { name: "jira-cloud", transport: "http", url: "https://jira.example/mcp", headers: { Authorization: SECRETS[4]! } } });
  assert.deepEqual(api.drafts.at(-1), { kind: "mcp", mcp: { name: "jira-cloud", transport: "http", url: "https://jira.example/mcp", headers: [{ key: "Authorization", value: SECRETS[4] }] } });
  assert.deepEqual(renamed.itemIds, ["mcp:jira-cloud"]);
  assert.equal(renamed.previousId, "mcp:jira");
  assertNoSecrets(JSON.stringify(ok(renamed)), "the rename");
});

test("update_agent_profile_item: a stale revision answers PROFILE_CONFLICT with the fresh item, and nothing was written", async () => {
  const api = seeded();
  const stale = api.find("claude", "mcp:jira")!.revision;
  const fresh = api.touch("claude", "mcp:jira");
  const error = await rejects(call(api, "update_agent_profile_item", { agent: "claude", id: "mcp:jira", revision: stale, mcp: { env: { JIRA_TOKEN: SECRETS[3]! } } }), "PROFILE_CONFLICT", /changed on disk.*now at revision/);
  assert.match(error.message, new RegExp(fresh));
  const detail = error.detail as { item: Record<string, unknown> };
  assert.equal(detail.item.id, "mcp:jira");
  assert.equal(detail.item.revision, fresh);
  assert.equal(api.mcps.get("claude/mcp:jira")!.env.JIRA_TOKEN, SECRETS[0], "nothing was written");
  assertNoSecrets(JSON.stringify(toSafeToolError(error)), "the conflict");
  // With the fresh revision it goes through.
  await call(api, "update_agent_profile_item", { agent: "claude", id: "mcp:jira", revision: fresh, mcp: { env: { JIRA_TOKEN: SECRETS[3]! } } });
  assert.equal(api.mcps.get("claude/mcp:jira")!.env.JIRA_TOKEN, SECRETS[3]);
  // An item deleted under the caller: the conflict says it is gone.
  api.on("PUT", "/api/agent-profile/claude/items/skill%3Ahandoff", () => {
    api.items.set("claude", api.items.get("claude")!.filter((i) => i.id !== "skill:handoff"));
    return err(409, "PROFILE_CONFLICT", "It changed on disk since you loaded it.");
  });
  const gone = await rejects(call(api, "update_agent_profile_item", { agent: "claude", id: "skill:handoff", skill: { body: "x" } }), "PROFILE_CONFLICT", /no longer exists/);
  assert.deepEqual(gone.detail, { itemGone: true });
});

test("update_agent_profile_item: a failed conflict snapshot reread preserves the original refusal", async () => {
  const api = seeded();
  const original = { code: "PROFILE_CONFLICT", message: "It changed on disk.", detail: { revision: "r-new" } };
  api.on("PUT", "/api/agent-profile/claude/items/mcp%3Ajira", { status: 409, body: { error: original } });
  api.on("GET", "/api/agent-profile/claude", err(503, "HOST_UNAVAILABLE", "The daemon is restarting."));
  const conflict = await rejects(call(api, "update_agent_profile_item", {
    agent: "claude", id: "mcp:jira", revision: "stale", mcp: { args: ["changed.js"] }
  }), "PROFILE_CONFLICT");
  assert.equal(conflict.message, original.message);
  assert.deepEqual(conflict.detail, original.detail);
  assert.ok(api.find("claude", "mcp:jira"), "a failed read does not mean the item was deleted");
});

test("update_agent_profile_item (skill, hook): the body is kept when omitted, frontmatter keys pass through, null clears a hook field", async () => {
  const api = seeded();
  await call(api, "update_agent_profile_item", { agent: "claude", id: "skill:handoff", skill: { frontmatter: { description: "New", model: null } } });
  assert.deepEqual(api.drafts.at(-1), { kind: "skill", document: { name: "handoff", frontmatter: { description: "New", model: null }, body: "# Handoff\n\nSteps." } });
  const renamed = await call(api, "update_agent_profile_item", { agent: "claude", id: "skill:handoff", skill: { name: "hand-off", body: "New body" } });
  assert.deepEqual(renamed.itemIds, ["skill:hand-off"]);
  assert.deepEqual(api.docs.get("claude/skill:hand-off"), { frontmatter: { name: "handoff", description: "New" }, body: "New body" });

  const hook = await call(api, "update_agent_profile_item", { agent: "claude", id: "hook:Stop:aaaaaaaaaaaaaaaa", hook: { matcher: null, timeoutSec: 30 } });
  assert.deepEqual(api.drafts.at(-1), { kind: "hook", hook: { event: "Stop", command: "notify", timeoutSec: 30 } });
  assert.notEqual((hook.itemIds as string[])[0], "hook:Stop:aaaaaaaaaaaaaaaa", "a hook's id moves with its content");

  await rejects(call(api, "update_agent_profile_item", { agent: "claude", id: "skill:hand-off", mcp: { args: [] } }), "INVALID_ARGUMENT", /is a skill: pass its changes as skill/);
  await rejects(call(api, "update_agent_profile_item", { agent: "claude", id: "plugin:superpowers@official", skill: { body: "x" } }), "KIND_NOT_SUPPORTED", /cannot be edited/);
  await rejects(call(api, "update_agent_profile_item", { agent: "claude", id: "skill:hand-off" }), "INVALID_ARGUMENT", /pass one of mcp, skill, command, hook/);
  await rejects(call(api, "update_agent_profile_item", { agent: "claude", id: "skill:hand-off", plugin: { spec: "x" } }), "INVALID_ARGUMENT", /plugin/);
});

test("set_agent_profile_item_enabled: without revision the current one is read first; with one, no read", async () => {
  const api = seeded();
  const r = await call(api, "set_agent_profile_item_enabled", { agent: "claude", id: "skill:handoff", enabled: false });
  assert.deepEqual(routes(api), ["GET /api/agent-profile/claude", "POST /api/agent-profile/claude/items/skill%3Ahandoff/enabled"]);
  assert.equal(r.enabled, false);
  assert.equal((r.items as { enabled: boolean }[])[0]!.enabled, false);
  api.calls.length = 0;
  const revision = api.find("claude", "skill:handoff")!.revision;
  await call(api, "set_agent_profile_item_enabled", { agent: "claude", id: "skill:handoff", enabled: true, revision });
  assert.deepEqual(routes(api), ["POST /api/agent-profile/claude/items/skill%3Ahandoff/enabled"]);
  await rejects(call(api, "set_agent_profile_item_enabled", { agent: "claude", id: "skill:ghost", enabled: true }), "ITEM_NOT_FOUND", /Claude has no item "skill:ghost".*get_agent_profile/);
  api.installed.delete("claude");
  await rejects(call(api, "set_agent_profile_item_enabled", { agent: "claude", id: "skill:handoff", enabled: true }), "AGENT_NOT_INSTALLED", /list_agent_profiles/);
  // A stale explicit revision: the fresh item comes back.
  api.installed.add("claude");
  const conflict = await rejects(call(api, "set_agent_profile_item_enabled", { agent: "claude", id: "skill:handoff", enabled: false, revision: "old" }), "PROFILE_CONFLICT");
  assert.equal((conflict.detail as { item: { revision: string } }).item.revision, api.find("claude", "skill:handoff")!.revision);
});

test("delete_agent_profile_item: needs confirm: true; reads the revision; answers the id and notes", async () => {
  const api = seeded();
  await rejects(call(api, "delete_agent_profile_item", { agent: "claude", id: "skill:handoff" }), "INVALID_ARGUMENT", /confirm/);
  await rejects(call(api, "delete_agent_profile_item", { agent: "claude", id: "skill:handoff", confirm: false }), "INVALID_ARGUMENT", /confirm/);
  const r = await call(api, "delete_agent_profile_item", { agent: "claude", id: "skill:handoff", confirm: true });
  assert.deepEqual(r, { deleted: true, agent: "claude", id: "skill:handoff", notes: ["Deleted."] });
  assert.equal(api.find("claude", "skill:handoff"), undefined);
  assert.equal(api.calls.at(-1)!.query!.revision !== undefined, true);
});

test("copy_agent_profile_item and trust_agent_profile_hook: the target's ids, notes and summary", async () => {
  const api = seeded();
  const r = await call(api, "copy_agent_profile_item", { agent: "claude", id: "mcp:jira", toAgent: "opencode", onConflict: "keep-both" });
  assert.deepEqual(api.calls.at(-1)!.body, { toAgent: "opencode", onConflict: "keep-both" });
  assert.equal(r.copied, true);
  assert.equal(r.agent, "opencode");
  assert.equal(r.fromAgent, "claude");
  assert.deepEqual(r.itemIds, ["mcp:jira"]);
  assert.deepEqual(r.notes, ["Dropped Claude-only settings: timeout."]);
  assertNoSecrets(JSON.stringify(ok(r)), "copy");

  api.add("codex", "hook", "Stop", { id: "hook:Stop:bbbbbbbbbbbbbbbb", warnings: [{ code: "codex-untrusted", message: "Not trusted by Codex", action: "trust" }] });
  const trusted = await call(api, "trust_agent_profile_hook", { agent: "codex", id: "hook:Stop:bbbbbbbbbbbbbbbb" });
  assert.equal(trusted.trusted, true);
  assert.equal((trusted.items as { warnings?: unknown }[])[0]!.warnings, undefined);
});

test("get_agent_instructions pages a long text; write_agent_instructions reads the revision, and a conflict names the fresh one", async () => {
  const api = seeded();
  const r = await call(api, "get_agent_instructions", { agent: "claude" });
  assert.equal(r.text, "# Rules\n\nBe brief.\n");
  assert.equal(r.truncated, undefined);
  assert.equal((r.instructions as { exists: boolean }).exists, true);

  const long = Array.from({ length: 6_000 }, (_, i) => `line ${i} — ✓ ${"x".repeat(10)}`).join("\n");
  api.instructions.set("claude", long);
  let text = "";
  let offset = 0;
  for (let pages = 0; pages < 10; pages += 1) {
    const page = await call(api, "get_agent_instructions", { agent: "claude", offset });
    text += page.text as string;
    if (page.nextOffset === undefined) break;
    offset = page.nextOffset as number;
  }
  assert.equal(text, long, "the pages reassemble the file");
  await rejects(call(api, "get_agent_instructions", { agent: "claude", offset: long.length + 1 }), "INVALID_ARGUMENT", /past the end/);

  api.instructions.set("claude", "old");
  const written = await call(api, "write_agent_instructions", { agent: "claude", text: "# New rules\n" });
  assert.deepEqual(routes(api).slice(-2), ["GET /api/agent-profile/claude/instructions", "PUT /api/agent-profile/claude/instructions"]);
  assert.equal(written.written, true);
  assert.equal((written.instructions as { bytes: number }).bytes, 12);
  const conflict = await rejects(call(api, "write_agent_instructions", { agent: "claude", text: "x", revision: "stale" }), "PROFILE_CONFLICT", /get_agent_instructions/);
  assert.equal((conflict.detail as { instructions: { revision: string } }).instructions.revision, api.info("claude").revision);
  // "" creates a file that does not exist yet.
  await call(api, "write_agent_instructions", { agent: "codex", text: "hi", revision: "" });
  assert.equal(api.instructions.get("codex"), "hi");
});

test("import_agent_profile_items: scan by url (never echoed), then import by importId and picks", async () => {
  const api = seeded();
  const url = `https://user:${SECRETS[4]}@git.example/skills.git`;
  await rejects(call(api, "import_agent_profile_items", { agent: "claude" }), "INVALID_ARGUMENT", /url.*importId and picks/);
  await rejects(call(api, "import_agent_profile_items", { agent: "claude", url, importId: "imp-1", picks: ["a"] }), "INVALID_ARGUMENT");
  await rejects(call(api, "import_agent_profile_items", { agent: "claude", importId: "imp-1" }), "INVALID_ARGUMENT");
  const scan = await call(api, "import_agent_profile_items", { agent: "claude", url });
  assert.equal(scan.scanned, true);
  assert.equal(scan.importId, "imp-1");
  assert.deepEqual((scan.candidates as { ref: string; exists: boolean }[]).map((c) => [c.ref, c.exists]), [["skills/alpha", false], ["skills/beta", true]]);
  assert.deepEqual(scan.notes, ["Skipped symlink skills/x"]);
  assertNoSecrets(JSON.stringify(ok(scan)), "the scan");
  const taken = await call(api, "import_agent_profile_items", { agent: "claude", importId: "imp-1", picks: ["skills/alpha"], onConflict: "replace" });
  assert.deepEqual(api.calls.at(-1)!.body, { import: { importId: "imp-1", picks: ["skills/alpha"] }, onConflict: "replace" });
  assert.equal(taken.imported, true);
  assert.deepEqual(taken.itemIds, ["skill:alpha"]);
  await rejects(call(api, "import_agent_profile_items", { agent: "claude", importId: "imp-9", picks: ["x"] }), "IMPORT_NOT_FOUND", /Scan again/);
});

test("list_marketplace_plugins: the catalogue", async () => {
  const api = seeded();
  const r = await call(api, "list_marketplace_plugins", { agent: "claude", marketplace: "official" });
  assert.deepEqual(routes(api), ["GET /api/agent-profile/claude/marketplaces/official/plugins"]);
  assert.deepEqual(r.plugins, [{ name: "superpowers", description: "Skills", version: "1.0.0", installed: true }, { name: "other", installed: false }]);
});

test("daemon errors keep their codes; a 5xx body is never echoed", async () => {
  const api = seeded();
  api.on("GET", "/api/agent-profile/claude", err(409, "CONFIG_UNREADABLE", "/home/u/.claude.json could not be read (bad JSON). Fix the file before changing it here."));
  await rejects(call(api, "get_agent_profile", { agent: "claude" }), "CONFIG_UNREADABLE", /fixed by hand/);
  api.on("GET", "/api/agent-profile/codex", { status: 500, body: { statusCode: 500, error: "Internal Server Error", message: `boom at /secret/path ${SECRETS[0]}` } });
  const internal = await rejects(call(api, "get_agent_profile", { agent: "codex" }), "INTERNAL");
  assert.doesNotMatch(internal.message, /secret\/path/);
  api.on("GET", "/api/agent-profile/opencode", err(502, "AGENT_CLI_FAILED", "opencode failed: exit 1"));
  await rejects(call(api, "get_agent_profile", { agent: "opencode" }), "AGENT_CLI_FAILED", /opencode failed/);
});

test("no secret value appears in any result or error any test produced", () => {
  assert.ok(seen.length > 50, `${seen.length} answers swept`);
  for (const [i, text] of seen.entries()) assertNoSecrets(text, `answer ${i}`);
});
