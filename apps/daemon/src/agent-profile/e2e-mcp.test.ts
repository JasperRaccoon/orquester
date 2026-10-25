// Assembled workflows: public MCP calls persist native configuration while secrets remain host-only; a chat adds a skill through its approval card.
// Lower owner tests cover individual draft rules, conflicts, imports and native adapter mutations.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { agentProfileBackupsDir, agentProfileImportsDir, agentProfileStashDir } from "@orquester/config";
import { Broadcaster } from "../broadcaster.ts";
import { InjectDaemonApi } from "../mcp/daemon-api.ts";
import { registerMcp } from "../mcp/server.ts";
import { FakeApprovalPort } from "../mcp/catalog/approval-double.ts";
import type { ThreadCaller } from "../mcp/catalog/contract.ts";
import { executeToolCall } from "../mcp/executor.ts";
import { ClaudeProfileAdapter } from "./adapters/claude/index.ts";
import type { AgentHomes } from "./adapters/types.ts";
import { OpenCodeProfileAdapter } from "./adapters/opencode/index.ts";
import { createProfileConverter } from "./convert.ts";
import { ProfileImportStore } from "./import.ts";
import { ProfileBackups, ProfileStash, parseMarkdownDocument } from "./infra/index.ts";
import { registerAgentProfileRoutes } from "./routes.ts";
import { AgentProfileService } from "./service.ts";

test("MCP profile creation and partial edits persist secrets without returning them", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orq-profile-mcp-e2e-")));
  let app: FastifyInstance | undefined;
  let mcp: FastifyInstance | undefined;
  let service: AgentProfileService | undefined;
  t.after(async () => {
    await mcp?.close();
    await app?.close();
    await service?.stop();
    await rm(root, { recursive: true, force: true });
  });

  const home = join(root, "home");
  const appdir = join(root, "appdir");
  const opencodeDir = join(home, ".config", "opencode");
  const config = join(opencodeDir, "opencode.jsonc");
  await mkdir(opencodeDir, { recursive: true });
  await writeFile(config, "{}\n");
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
  const opencode = new OpenCodeProfileAdapter(
    { homes, appdir, bin: "/unused/opencode", accountHomes: async () => [], logger: quiet, now: () => new Date() },
    { backups: new ProfileBackups({ dir: agentProfileBackupsDir(appdir) }), stash: new ProfileStash({ dir: agentProfileStashDir(appdir) }) }
  );
  service = new AgentProfileService({
    adapters: { opencode }, agentInfo: (agent) => ({ installed: agent === "opencode" }), homes, logger: quiet,
    converter: createProfileConverter({ tempRoot: agentProfileImportsDir(appdir) })
  });
  app = Fastify({ logger: false });
  registerAgentProfileRoutes(app, { service, importsDir: agentProfileImportsDir(appdir) });
  await app.ready();
  const api = new InjectDaemonApi({ app, authorization: undefined, agentChat: null, broadcaster: new Broadcaster(), fsRoot: root, workspacesDir: root });
  mcp = Fastify({ logger: false });
  registerMcp(mcp, { createApi: () => api });
  const address = await mcp.listen({ host: "127.0.0.1", port: 0 });

  const token = "e2e-SECRET-token-0001";
  const email = "e2e-SECRET-email-0002";
  const region = "e2e-SECRET-region-0003";
  const urlSecret = "e2e-SECRET-url-0005";
  let requestId = 0;
  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(`${address}/mcp`, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } })
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    for (const secret of [token, email, region, urlSecret]) assert.ok(!text.includes(secret), `${name} returned a secret`);
    const envelope = JSON.parse(text);
    assert.equal(envelope.error, undefined, text);
    assert.notEqual(envelope.result?.isError, true, text);
    assert.ok(envelope.result?.structuredContent, text);
    return envelope.result.structuredContent;
  }

  await call("edit_agent_profile", { agent: "opencode", changes: [{
    action: "create",
    mcp: { name: "jira", command: "node", args: ["/srv/jira/index.js"], env: { JIRA_API_TOKEN: token, JIRA_EMAIL: email }, advanced: { timeout: 60000 } }
  }] });
  assert.deepEqual(JSON.parse(await readFile(config, "utf8")).mcp.jira.environment, { JIRA_API_TOKEN: token, JIRA_EMAIL: email });

  await call("edit_agent_profile", { agent: "opencode", changes: [{
    action: "update", id: "mcp:jira", mcp: { env: { JIRA_EMAIL: null, JIRA_REGION: region } }
  }] });
  const nativeConfig = JSON.parse(await readFile(config, "utf8"));
  assert.deepEqual(nativeConfig.mcp.jira, {
    type: "local", command: ["node", "/srv/jira/index.js"], environment: { JIRA_API_TOKEN: token, JIRA_REGION: region }, timeout: 60000
  });
  const detail = await call("get_agent_profile", { agent: "opencode", itemId: "mcp:jira" });
  const view = detail.mcp as { env: { key: string; set: boolean }[] };
  assert.deepEqual([...view.env].sort((a, b) => a.key.localeCompare(b.key)), [
    { key: "JIRA_API_TOKEN", set: true },
    { key: "JIRA_REGION", set: true }
  ]);

  const id = "mcp:remote-credentials";
  const url = `https://user:first@${urlSecret}@mcp.example/x?view=1`;
  const redacted = "https://***@mcp.example/x?view=1";
  const created = (await call("edit_agent_profile", {
    agent: "opencode", changes: [{ action: "create", mcp: { name: "remote-credentials", transport: "http", url } }]
  }) as { results: Record<string, unknown>[] }).results[0]!;
  assert.ok((await readFile(config, "utf8")).includes(JSON.stringify(url)), "creation preserves the original URL bytes");

  const remote = await call("get_agent_profile", { agent: "opencode", itemId: id });
  assert.equal((remote.mcp as { url: string }).url, redacted, "the editable detail hides the complete userinfo");
  const listed = await call("get_agent_profile", { agent: "opencode", kind: "mcp", query: "remote-credentials" });
  const updated = (await call("edit_agent_profile", { agent: "opencode", changes: [{ action: "update", id, mcp: { advanced: { timeout: 2500 } } }] }) as { results: Record<string, unknown>[] }).results[0]!;
  assert.ok((await readFile(config, "utf8")).includes(JSON.stringify(url)), "an update without url preserves its original bytes");

  for (const [operation, result] of [["create", created], ["get", remote], ["list", listed], ["update", updated]] as const) {
    const item = (result.item ?? (result.items as Record<string, unknown>[]).find((entry) => entry.id === id)) as { meta?: { url?: string } } | undefined;
    assert.equal(item?.meta?.url, redacted, `${operation}: summary metadata hides the complete userinfo`);
  }

  const artifactDir = await mkdtemp(join(tmpdir(), "orq-profile-mcp-artifact-"));
  const artifact = join(artifactDir, "result.json");
  await writeFile(artifact, JSON.stringify({
    workflow: "MCP profile create and partial update",
    checks: ["native secret values persisted", "partial update preserved omitted secrets", "responses omitted secrets", "URL userinfo redacted"],
    detail, remote, listed, updated
  }, null, 2), { mode: 0o600 });
  t.diagnostic(`Verified artifact: ${artifact}`);
});

// Spec §14.2.11 "add a skill": a chat agent adds a skill to Claude Code through edit_agent_profile.
// The card shows the whole SKILL.md exactly as written; an edit made on disk after the card makes
// the approved update PREVIEW_STALE and nothing is written.
test("chat: add a skill to Claude Code through edit_agent_profile with a card, then a stale update is refused", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orq-profile-skill-e2e-")));
  let app: FastifyInstance | undefined;
  let service: AgentProfileService | undefined;
  t.after(async () => {
    await app?.close();
    await service?.stop();
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, "home");
  const appdir = join(root, "appdir");
  const claudeDir = join(home, ".claude");
  await mkdir(claudeDir, { recursive: true });
  const homes: AgentHomes = {
    home, claudeDir, claudeJson: join(home, ".claude.json"), codexHome: join(home, ".codex"), grokHome: join(home, ".grok"),
    opencodeDir: join(home, ".config", "opencode"), agentsSkillsDir: join(home, ".agents", "skills")
  };
  const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const backups = { backups: new ProfileBackups({ dir: agentProfileBackupsDir(appdir) }), stash: new ProfileStash({ dir: agentProfileStashDir(appdir) }) };
  const claude = new ClaudeProfileAdapter({ homes, appdir, bin: "/unused/claude", accountHomes: async () => [], logger: quiet, now: () => new Date() }, backups);
  service = new AgentProfileService({
    adapters: { claude }, agentInfo: (agent) => ({ installed: agent === "claude" }), homes, logger: quiet,
    converter: createProfileConverter({ tempRoot: agentProfileImportsDir(appdir) })
  });
  app = Fastify({ logger: false });
  registerAgentProfileRoutes(app, { service, importsDir: agentProfileImportsDir(appdir) });
  await app.ready();
  const api = new InjectDaemonApi({ app, authorization: undefined, agentChat: null, broadcaster: new Broadcaster(), fsRoot: root, workspacesDir: root });
  const caller: ThreadCaller = {
    kind: "thread", threadId: "t1", title: "Release prep", projectPath: "", workspace: "", cwd: root, agentId: "claude", callId: "c1",
    runtimeMode: "full-access", planning: false, workflowOwned: false, exchange: null
  };
  const run = async (port: FakeApprovalPort, changes: unknown[]) => executeToolCall(
    { approvals: port },
    { name: "edit_agent_profile", arguments: { agent: "claude", reason: "The user asked for a release-notes skill.", changes } },
    { caller, api, signal: new AbortController().signal }
  );

  const port = new FakeApprovalPort();
  const created = await run(port, [{ action: "create", skill: { name: "release-notes", frontmatter: { description: "Draft release notes from merged PRs" }, body: "# Release notes\n\n1. List merged PRs.\n" } }]);
  assert.notEqual(created.isError, true, JSON.stringify(created.structuredContent));
  const card = port.cards[0]!;
  assert.equal(card.title, "Claude wants to add the skill `release-notes` to Claude Code");
  assert.equal(card.family, "agent-profile");
  assert.deepEqual(card.grantOptions, []);
  const shown = card.sections.find((section) => section.kind === "code");
  const file = join(claudeDir, "skills", "release-notes", "SKILL.md");
  assert.equal(shown?.kind === "code" ? shown.text : undefined, await readFile(file, "utf8"), "the card showed the file exactly as written");
  const listed = (await service.snapshot("claude")).items.find((entry) => entry.id === "skill:release-notes");
  assert.ok(listed, "the new skill is in the profile");

  // Someone edits the skill while the card waits: the approved update is refused, nothing written.
  const before = await readFile(file, "utf8");
  const stale = new FakeApprovalPort(async () => {
    await writeFile(file, `${before}\nInjected step.\n`);
    return { outcome: "approved", approvalId: "" };
  });
  const refused = await run(stale, [{ action: "update", id: "skill:release-notes", skill: { body: "# Release notes\n\nNew steps.\n" } }]);
  assert.equal(refused.isError, true);
  assert.equal((refused.structuredContent as { code: string }).code, "PREVIEW_STALE");
  assert.equal(await readFile(file, "utf8"), `${before}\nInjected step.\n`);
  const diff = stale.cards[0]!.sections.find((section) => section.kind === "diff");
  assert.match(diff?.kind === "diff" ? diff.unifiedDiff : "", /\+New steps\./);
});

// Fix round follow-up: a batch writes in order, so a keep-both later in the batch finds the names
// earlier changes write taken. The card shows exactly the names the writes land on.
test("chat: one batch writing the same name twice — two picks, two creates — shows and writes the same suffixes; fail is refused before the card", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orq-profile-batch-names-")));
  let app: FastifyInstance | undefined;
  let service: AgentProfileService | undefined;
  let imports: ProfileImportStore | undefined;
  t.after(async () => {
    await app?.close();
    await service?.stop();
    await imports?.stop();
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, "home");
  const appdir = join(root, "appdir");
  const claudeDir = join(home, ".claude");
  await mkdir(join(claudeDir, "skills", "alpha"), { recursive: true });
  await writeFile(join(claudeDir, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: Mine\n---\nmine\n");
  await mkdir(join(claudeDir, "commands"), { recursive: true });
  await writeFile(join(claudeDir, "commands", "deploy.md"), "Deploy the existing version.\n");
  const homes: AgentHomes = {
    home, claudeDir, claudeJson: join(home, ".claude.json"), codexHome: join(home, ".codex"), grokHome: join(home, ".grok"),
    opencodeDir: join(home, ".config", "opencode"), agentsSkillsDir: join(home, ".agents", "skills")
  };
  const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const claude = new ClaudeProfileAdapter({ homes, appdir, bin: "/unused/claude", accountHomes: async () => [], logger: quiet, now: () => new Date() },
    { backups: new ProfileBackups({ dir: agentProfileBackupsDir(appdir) }), stash: new ProfileStash({ dir: agentProfileStashDir(appdir) }) });
  imports = new ProfileImportStore({
    dir: agentProfileImportsDir(appdir),
    existing: async () => new Set(["skill:alpha"]),
    logger: quiet,
    // Two folders whose skills are both named "alpha".
    clone: async (_url, _ref, dest) => {
      for (const folder of ["one", "two"]) {
        await mkdir(join(dest, folder, "alpha"), { recursive: true });
        await writeFile(join(dest, folder, "alpha", "SKILL.md"), `---\nname: alpha\ndescription: From ${folder}\n---\n${folder} body\n`);
      }
      // Claude refuses creating this reserved skill; an unpicked candidate must not be named.
      await mkdir(join(dest, "skills", "synced"), { recursive: true });
      await writeFile(join(dest, "skills", "synced", "SKILL.md"), "---\nname: synced\ndescription: Unpicked\n---\nunused\n");
      await mkdir(join(dest, "commands"), { recursive: true });
      await writeFile(join(dest, "commands", "deploy.md"), "---\ndescription: Deploy\n---\nship it\n");
    }
  });
  service = new AgentProfileService({
    adapters: { claude }, agentInfo: (agent) => ({ installed: agent === "claude" }), homes, logger: quiet, imports,
    converter: createProfileConverter({ tempRoot: agentProfileImportsDir(appdir) })
  });
  app = Fastify({ logger: false });
  registerAgentProfileRoutes(app, { service, importsDir: agentProfileImportsDir(appdir) });
  await app.ready();
  const api = new InjectDaemonApi({ app, authorization: undefined, agentChat: null, broadcaster: new Broadcaster(), fsRoot: root, workspacesDir: root });
  const caller: ThreadCaller = {
    kind: "thread", threadId: "t1", title: "Batch", projectPath: "", workspace: "", cwd: root, agentId: "claude", callId: "c1",
    runtimeMode: "full-access", planning: false, workflowOwned: false, exchange: null
  };
  const run = (port: FakeApprovalPort, changes: unknown[]) => executeToolCall(
    { approvals: port },
    { name: "edit_agent_profile", arguments: { agent: "claude", changes } },
    { caller, api, signal: new AbortController().signal }
  );
  const shownSkillFiles = (port: FakeApprovalPort) =>
    port.cards[0]!.sections.flatMap((section) => (section.kind === "code" && section.title.endsWith("/SKILL.md") ? [[section.title, section.text] as const] : []));

  // A create claims alpha-2 before the two reversed picks: the imports must use alpha-3 and alpha-4.
  const scan = await service.scanGit("claude", "https://git.example/acme/skills.git");
  assert.ok(scan.candidates.some((candidate) => candidate.name === "synced"));
  const refs = ["From two", "From one"].map((description) => {
    const candidate = scan.candidates.find((entry) => entry.description === description);
    assert.ok(candidate);
    return candidate.ref;
  });
  const picks = new FakeApprovalPort();
  const command = scan.candidates.find((candidate) => candidate.kind === "command")!;
  const picked = await run(picks, [
    { action: "create", onConflict: "keep-both", skill: { name: "alpha", frontmatter: { description: "Earlier in the batch" }, body: "earlier\n" } },
    { action: "import_pick", importId: scan.importId, picks: [...refs, command.ref], onConflict: "keep-both" }
  ]);
  assert.notEqual(picked.isError, true, JSON.stringify(picked.structuredContent));
  await assert.rejects(readFile(join(claudeDir, "skills", "synced", "SKILL.md")), { code: "ENOENT" });
  const shown = shownSkillFiles(picks);
  assert.deepEqual(new Set(shown.map(([title]) => title)), new Set(["alpha-2/SKILL.md", "alpha-3/SKILL.md", "alpha-4/SKILL.md"]));
  for (const [title, text] of shown) {
    assert.equal(await readFile(join(claudeDir, "skills", title), "utf8"), text, `${title}: the card showed exactly what was written`);
  }
  assert.equal(parseMarkdownDocument(await readFile(join(claudeDir, "skills", "alpha-3", "SKILL.md"), "utf8")).body, "two body\n");
  assert.equal(parseMarkdownDocument(await readFile(join(claudeDir, "skills", "alpha-4", "SKILL.md"), "utf8")).body, "one body\n");
  const commandShown = picks.cards[0]!.sections.find((section) => section.kind === "code" && section.title === "deploy-2.md");
  assert.ok(commandShown?.kind === "code");
  assert.equal(await readFile(join(claudeDir, "commands", "deploy-2.md"), "utf8"), commandShown.text);

  // Two creates of one name in one call: notes, then notes-2 — shown, then written.
  const creates = new FakeApprovalPort();
  const created = await run(creates, [
    { action: "create", onConflict: "keep-both", skill: { name: "notes", frontmatter: { description: "A" }, body: "a\n" } },
    { action: "create", onConflict: "keep-both", skill: { name: "notes", frontmatter: { description: "B" }, body: "b\n" } }
  ]);
  assert.notEqual(created.isError, true, JSON.stringify(created.structuredContent));
  const createdShown = shownSkillFiles(creates);
  assert.deepEqual(createdShown.map(([title]) => title), ["notes/SKILL.md", "notes-2/SKILL.md"]);
  for (const [title, text] of createdShown) assert.equal(await readFile(join(claudeDir, "skills", title), "utf8"), text);

  // Without keep-both, a name written twice in one call is refused before any card or write.
  const refused = new FakeApprovalPort();
  const result = await run(refused, [
    { action: "create", skill: { name: "twice", frontmatter: { description: "A" }, body: "a\n" } },
    { action: "create", onConflict: "replace", skill: { name: "twice", frontmatter: { description: "B" }, body: "b\n" } }
  ]);
  assert.equal((result.structuredContent as { code: string }).code, "INVALID_ARGUMENT");
  assert.equal(refused.cards.length, 0);
  await assert.rejects(readFile(join(claudeDir, "skills", "twice", "SKILL.md"), "utf8"), { code: "ENOENT" });
});
