// End to end: the MCP agent-profile tools through the REAL MCP server (`registerMcp`, JSON-RPC over `POST /mcp`), the
// REAL agent-profile routes and service, the daemon's own `InjectDaemonApi`, the real converter and import store —
// with the REAL OpenCode adapter on a temp HOME (it needs no CLI for these writes) and the fake adapter standing in
// for Claude as a copy target. Nothing touches a real agent home. The tools' unit tests run against an in-memory fake
// daemon; this is where the two are held to agree — and where secret values are proven to reach the files on disk
// while never coming back through the MCP.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { agentProfileBackupsDir, agentProfileImportsDir, agentProfileStashDir } from "@orquester/config";
import { Broadcaster } from "../broadcaster.ts";
import { InjectDaemonApi } from "../mcp/daemon-api.ts";
import { ToolError } from "../mcp/errors.ts";
import { registerMcp } from "../mcp/server.ts";
import type { AgentHomes } from "./adapters/types.ts";
import { OpenCodeProfileAdapter } from "./adapters/opencode/index.ts";
import { createProfileConverter } from "./convert.ts";
import { ProfileImportStore } from "./import.ts";
import { ProfileBackups, ProfileStash } from "./infra/index.ts";
import { registerAgentProfileRoutes } from "./routes.ts";
import { AgentProfileService } from "./service.ts";
import { FakeProfileAdapter } from "./testing.ts";

type Result = Record<string, unknown>;

const SECRETS = ["e2e-SECRET-token-0001", "e2e-SECRET-email-0002", "e2e-SECRET-rotated-0003", "e2e-SECRET-git-0004"];

let root: string;
let config: string;
let opencodeDir: string;
let claude: FakeProfileAdapter;
let service: AgentProfileService;
let imports: ProfileImportStore;
let app: FastifyInstance;
let mcp: FastifyInstance;
/** Every JSON-RPC response body the MCP answered, for the secret sweep. */
const answers: string[] = [];

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "orq-profile-mcp-e2e-")));
  const home = join(root, "home");
  const appdir = join(root, "appdir");
  opencodeDir = join(home, ".config", "opencode");
  config = join(opencodeDir, "opencode.jsonc");
  await mkdir(join(opencodeDir, "skills"), { recursive: true });
  await writeFile(config, "{\n  // the owner's own config\n  \"$schema\": \"https://opencode.ai/config.json\"\n}\n");
  await writeFile(join(opencodeDir, "AGENTS.md"), "# Global rules\n\nBe brief.\n");
  const homes: AgentHomes = {
    home,
    claudeDir: join(home, ".claude"),
    claudeJson: join(home, ".claude.json"),
    codexHome: join(home, ".codex"),
    grokHome: join(home, ".grok"),
    opencodeDir,
    agentsSkillsDir: join(home, ".agents", "skills")
  };
  const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const now = () => new Date();
  const opencode = new OpenCodeProfileAdapter(
    { homes, appdir, bin: "/usr/bin/opencode", accountHomes: async () => [], logger: quiet, now },
    { backups: new ProfileBackups({ dir: agentProfileBackupsDir(appdir), now }), stash: new ProfileStash({ dir: agentProfileStashDir(appdir), now }) }
  );
  claude = new FakeProfileAdapter("claude");
  imports = new ProfileImportStore({
    dir: agentProfileImportsDir(appdir),
    existing: async (agent) => new Set((await service.snapshot(agent)).items.map((item) => `${item.kind}:${item.name}`)),
    // Stands in for `git clone`: a repository holding two skills.
    clone: async (_url, _ref, dest) => {
      for (const name of ["alpha", "beta"]) {
        await mkdir(join(dest, "skills", name), { recursive: true });
        await writeFile(join(dest, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} skill\n---\nDo ${name}.\n`);
      }
    },
    logger: quiet
  });
  service = new AgentProfileService({
    adapters: { opencode, claude },
    agentInfo: (agent) => (agent === "opencode" ? { installed: true, version: "1.2.3" } : { installed: agent === "claude" }),
    homes,
    converter: createProfileConverter({ tempRoot: agentProfileImportsDir(appdir) }),
    imports,
    logger: quiet
  });
  app = Fastify({ logger: false });
  registerAgentProfileRoutes(app, { service, importsDir: agentProfileImportsDir(appdir) });
  await app.ready();
  const api = new InjectDaemonApi({ app, authorization: undefined, agentChat: null, broadcaster: new Broadcaster(), fsRoot: root, workspacesDir: root });
  mcp = Fastify();
  registerMcp(mcp, { createApi: () => api, todos: {} as never, files: {} as never });
  // Match IncomingMessage after Fastify has consumed its body (light-my-request omits it).
  mcp.addHook("preHandler", async (request) => { (request.raw as unknown as { destroyed: boolean }).destroyed = true; });
  await mcp.ready();
});

after(async () => {
  await mcp.close();
  await app.close();
  await service.stop();
  await imports.stop();
  await rm(root, { recursive: true, force: true });
});

/** One tools/call through the public MCP envelope; an isError answer is thrown as the ToolError it carries. */
async function call(name: string, args: Record<string, unknown>): Promise<Result> {
  const response = await mcp.inject({
    method: "POST", url: "/mcp",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }
  });
  assert.equal(response.statusCode, 200, response.body);
  answers.push(response.body);
  const envelope = response.json().result;
  const result = envelope.structuredContent;
  if (envelope.isError) {
    assert.equal(envelope.content[0].text, `${result.code}: ${result.message}`, "the <CODE>: <message> envelope");
    throw new ToolError(result.code, result.message, result.detail);
  }
  return result;
}

async function rejects(promise: Promise<unknown>, code: string, match?: RegExp): Promise<ToolError> {
  let caught: unknown;
  await promise.then(() => assert.fail(`expected ${code}`), (error) => { caught = error; });
  assert.ok(caught instanceof ToolError, `a ToolError, got ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  if (match) assert.match(caught.message, match);
  return caught;
}

describe("e2e: the MCP agent-profile tools against the real routes and the OpenCode adapter", () => {
  test("an MCP server: created with secrets, read back as keys, edited key by key, turned off and on, copied, deleted", async () => {
    const overview = await call("list_agent_profiles", { installedOnly: true });
    assert.deepEqual((overview.agents as { agent: string }[]).map((a) => a.agent), ["claude", "opencode"]);

    const created = await call("create_agent_profile_item", {
      agent: "opencode",
      mcp: { name: "jira", command: "node", args: ["/srv/jira/index.js"], env: { JIRA_API_TOKEN: SECRETS[0], JIRA_EMAIL: SECRETS[1] }, advanced: { timeout: 60000 } }
    });
    assert.deepEqual(created.itemIds, ["mcp:jira"]);
    const summary = (created.items as Record<string, unknown>[])[0]!;
    assert.equal(summary.enabled, true);
    assert.equal(summary.editable, true);
    const onDisk = await readFile(config, "utf8");
    assert.ok(onDisk.includes(SECRETS[0]!) && onDisk.includes(SECRETS[1]!), "the values reached OpenCode's config");
    assert.ok(onDisk.includes("the owner's own config"), "the owner's comment survived");

    const detail = await call("get_agent_profile_item", { agent: "opencode", id: "mcp:jira" });
    const view = detail.mcp as Record<string, unknown>;
    assert.equal(view.transport, "stdio");
    assert.deepEqual((view.env as { key: string; set: boolean }[]).map((e) => e.key).sort(), ["JIRA_API_TOKEN", "JIRA_EMAIL"]);
    assert.ok((view.env as Record<string, unknown>[]).every((e) => Object.keys(e).sort().join() === "key,set"));

    // No revision: the tool reads it. JIRA_API_TOKEN is not named, so it keeps its value; JIRA_EMAIL is removed.
    const updated = await call("update_agent_profile_item", { agent: "opencode", id: "mcp:jira", mcp: { env: { JIRA_EMAIL: null, JIRA_REGION: "eu" } } });
    assert.deepEqual(updated.itemIds, ["mcp:jira"]);
    const afterUpdate = await readFile(config, "utf8");
    assert.ok(afterUpdate.includes(SECRETS[0]!), "the unnamed secret kept its value");
    assert.ok(!afterUpdate.includes(SECRETS[1]!), "the removed secret is gone");
    assert.ok(afterUpdate.includes("JIRA_REGION"));
    assert.ok(afterUpdate.includes("60000"), "advanced settings not named were kept");

    // A stale revision: PROFILE_CONFLICT with the item's fresh summary, and the file untouched.
    const stale = summary.revision as string;
    const conflict = await rejects(call("update_agent_profile_item", { agent: "opencode", id: "mcp:jira", revision: stale, mcp: { env: { JIRA_API_TOKEN: SECRETS[2] } } }), "PROFILE_CONFLICT", /now at revision/);
    const fresh = (conflict.detail as { item: { id: string; revision: string } }).item;
    assert.equal(fresh.id, "mcp:jira");
    assert.notEqual(fresh.revision, stale);
    assert.equal(await readFile(config, "utf8"), afterUpdate, "nothing was written");
    await call("update_agent_profile_item", { agent: "opencode", id: "mcp:jira", revision: fresh.revision, mcp: { env: { JIRA_API_TOKEN: SECRETS[2] } } });
    assert.ok((await readFile(config, "utf8")).includes(SECRETS[2]!));

    const off = await call("set_agent_profile_item_enabled", { agent: "opencode", id: "mcp:jira", enabled: false });
    assert.equal((off.items as { enabled: boolean }[])[0]!.enabled, false);
    const on = await call("set_agent_profile_item_enabled", { agent: "opencode", id: "mcp:jira", enabled: true });
    assert.equal((on.items as { enabled: boolean }[])[0]!.enabled, true);

    // Copy to Claude: the secret value moves daemon-side (the target adapter holds it), never through the MCP.
    const copied = await call("copy_agent_profile_item", { agent: "opencode", id: "mcp:jira", toAgent: "claude" });
    assert.equal(copied.agent, "claude");
    assert.deepEqual(copied.itemIds, ["mcp:jira"]);
    const moved = claude.imported.at(-1)!;
    assert.equal(moved.kind, "mcp");
    assert.equal(moved.kind === "mcp" ? moved.server.env?.JIRA_API_TOKEN : undefined, SECRETS[2]);

    const listed = await call("get_agent_profile", { agent: "opencode", kind: "mcp" });
    assert.deepEqual((listed.items as { id: string }[]).map((i) => i.id), ["mcp:jira"]);
    assert.equal(listed.installed, true);
    assert.equal(listed.version, "1.2.3");

    await rejects(call("delete_agent_profile_item", { agent: "opencode", id: "mcp:jira" }), "INVALID_ARGUMENT", /confirm/);
    const deleted = await call("delete_agent_profile_item", { agent: "opencode", id: "mcp:jira", confirm: true });
    assert.equal(deleted.deleted, true);
    assert.ok(!(await readFile(config, "utf8")).includes("JIRA_API_TOKEN"));
    await rejects(call("get_agent_profile_item", { agent: "opencode", id: "mcp:jira" }), "ITEM_NOT_FOUND", /get_agent_profile/);
  });

  test("a skill: created, read, edited with its body kept, renamed; the daemon's own refusals pass through", async () => {
    const created = await call("create_agent_profile_item", { agent: "opencode", skill: { name: "review", frontmatter: { description: "Review a diff" }, body: "# Review\n\nRead the diff.\n" } });
    assert.deepEqual(created.itemIds, ["skill:review"]);
    await rejects(call("create_agent_profile_item", { agent: "opencode", skill: { name: "review", frontmatter: { description: "Again" } } }), "ITEM_EXISTS", /onConflict/);
    // OpenCode's own rule, from the adapter.
    await rejects(call("create_agent_profile_item", { agent: "opencode", skill: { name: "nodesc" } }), "INVALID_ITEM", /description/);
    await rejects(call("create_agent_profile_item", { agent: "opencode", hook: { event: "Stop", command: "true" } }), "KIND_NOT_SUPPORTED");

    const edited = await call("update_agent_profile_item", { agent: "opencode", id: "skill:review", skill: { frontmatter: { description: "Review a diff carefully" } } });
    assert.deepEqual(edited.itemIds, ["skill:review"]);
    const file = await readFile(join(opencodeDir, "skills", "review", "SKILL.md"), "utf8");
    assert.match(file, /Review a diff carefully/);
    assert.match(file, /Read the diff\./, "the body was kept");

    const renamed = await call("update_agent_profile_item", { agent: "opencode", id: "skill:review", skill: { name: "code-review" } });
    assert.deepEqual(renamed.itemIds, ["skill:code-review"]);
    const detail = await call("get_agent_profile_item", { agent: "opencode", id: "skill:code-review" });
    assert.match((detail.document as { body: string }).body, /Read the diff\./);
    assert.equal(((detail.document as { frontmatter: Record<string, unknown> }).frontmatter).description, "Review a diff carefully");
  });

  test("the instruction file: read, written with the revision read for it, and a stale write refused", async () => {
    const read = await call("get_agent_instructions", { agent: "opencode" });
    assert.equal(read.text, "# Global rules\n\nBe brief.\n");
    const revision = (read.instructions as { revision: string }).revision;
    const written = await call("write_agent_instructions", { agent: "opencode", text: "# Global rules\n\nBe brief. Be kind.\n" });
    assert.equal(written.written, true);
    assert.equal(await readFile(join(opencodeDir, "AGENTS.md"), "utf8"), "# Global rules\n\nBe brief. Be kind.\n");
    const conflict = await rejects(call("write_agent_instructions", { agent: "opencode", text: "lost", revision }), "PROFILE_CONFLICT", /get_agent_instructions/);
    assert.equal((conflict.detail as { instructions: { revision: string } }).instructions.revision, (written.instructions as { revision: string }).revision);
    assert.equal(await readFile(join(opencodeDir, "AGENTS.md"), "utf8"), "# Global rules\n\nBe brief. Be kind.\n");
  });

  test("an import from Git: scan, then take the picks", async () => {
    // A URL carrying credentials is the daemon's refusal — and the token is not quoted back.
    await rejects(call("import_agent_profile_items", { agent: "opencode", url: `https://oauth2:${SECRETS[3]}@github.com/acme/skills` }), "IMPORT_FAILED", /may not contain credentials/);
    const scan = await call("import_agent_profile_items", { agent: "opencode", url: "https://github.com/acme/skills" });
    const candidates = scan.candidates as { ref: string; name: string; exists: boolean }[];
    assert.deepEqual(candidates.map((c) => c.name).sort(), ["alpha", "beta"]);
    const alpha = candidates.find((c) => c.name === "alpha")!;
    const taken = await call("import_agent_profile_items", { agent: "opencode", importId: scan.importId, picks: [alpha.ref] });
    assert.deepEqual(taken.itemIds, ["skill:alpha"]);
    assert.match(await readFile(join(opencodeDir, "skills", "alpha", "SKILL.md"), "utf8"), /Do alpha\./);
    await rejects(call("import_agent_profile_items", { agent: "opencode", importId: scan.importId, picks: [alpha.ref] }), "IMPORT_NOT_FOUND", /Scan again/);
  });

  test("an agent that is not installed, an unknown kind for the agent, a marketplace on an agent without any", async () => {
    await rejects(call("get_agent_profile_item", { agent: "codex", id: "mcp:x" }), "AGENT_NOT_INSTALLED", /list_agent_profiles/);
    await rejects(call("list_marketplace_plugins", { agent: "opencode", marketplace: "official" }), "KIND_NOT_SUPPORTED");
    await rejects(call("get_agent_profile", { agent: "cursor" }), "INVALID_ARGUMENT", /agent/);
  });

  test("no secret value came back in any MCP answer", () => {
    assert.ok(answers.length > 20, `${answers.length} answers`);
    for (const [i, body] of answers.entries()) {
      for (const secret of SECRETS) assert.ok(!body.includes(secret), `answer ${i} leaks ${secret}`);
    }
  });
});
