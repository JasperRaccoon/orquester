/**
 * `agent-tools.json` (unified MCP design 2026-10-15 §9.6): tolerant read and rewrite, version
 * refusal, the toolset resolver's precedence and `findGrant`'s rules (§7.6, MUST 8).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_TOOLSET_DECLINE_MS,
  createDefaultAgentToolsFile,
  findGrant,
  parseAgentToolsFile,
  removeThreadFromAgentTools,
  resolveThreadToolsets,
  serializeAgentToolsFile,
  toolsetDeclinedUntil,
  type AgentToolGrantQuery,
  type AgentToolsetDefaults
} from "./index.ts";

const TOOLSETS: AgentToolsetDefaults[] = [
  { id: "core", locked: true, defaults: { claude: true, codex: true } },
  { id: "reads", locked: false, defaults: { claude: true, codex: true } },
  { id: "notes", locked: false, defaults: { claude: false, codex: false } },
  { id: "desktops", locked: false, defaults: {} }
];

const P = "/w/ws/app";

test("a file round-trips; unknown keys, toolset ids, agents and grant families survive a rewrite", () => {
  const raw = {
    version: 1,
    revision: 4,
    enabled: true,
    futureSetting: { a: 1 },
    toolsets: {
      defaults: { notes: { claude: true, "future-agent": false }, "future-toolset": { codex: true } },
      threads: { t1: { desktops: true } },
      perProject: { "/x": {} }
    },
    toolsetDeclines: { t1: { notes: "2026-10-15T10:00:00.000Z" } },
    grants: [
      { id: "g1", family: "desktops", scope: "project", projectPath: P, createdAt: "x", note: "kept" },
      { id: "g2", family: "telepathy", scope: "galaxy", projectPath: P, createdAt: "x" },
      { id: "", family: "desktops" },
      "garbage"
    ]
  };
  const file = parseAgentToolsFile(raw);
  assert.equal(file.revision, 4);
  assert.equal(file.grants.length, 2);
  assert.equal(file.grants[0]?.note, "kept");
  assert.deepEqual(file.unreadableGrants, [{ id: "", family: "desktops" }, "garbage"]);
  assert.deepEqual(JSON.parse(serializeAgentToolsFile(file)), raw);
  assert.deepEqual(parseAgentToolsFile(JSON.parse(serializeAgentToolsFile(file))), file);
});

test("missing fields read as defaults; unreadable rows and cells are never honoured but come back verbatim on rewrite", () => {
  assert.deepEqual(parseAgentToolsFile({}), createDefaultAgentToolsFile());
  const raw = {
    toolsets: {
      defaults: { notes: { claude: "on", codex: true }, reads: 5 },
      threads: { t1: { notes: { until: "x" }, reads: true } }
    },
    toolsetDeclines: { t1: { notes: 17, reads: "2026-10-15T10:00:00.000Z" }, t2: "x" }
  };
  const file = parseAgentToolsFile({ enabled: "yes", revision: -1, ...raw });
  assert.equal(file.enabled, true);
  assert.equal(file.revision, 0);
  assert.deepEqual(file.toolsets.defaults, { notes: { codex: true } });
  assert.deepEqual(file.toolsets.threads, { t1: { reads: true } });
  assert.deepEqual(file.toolsetDeclines, { t1: { reads: "2026-10-15T10:00:00.000Z" } });
  const written = JSON.parse(serializeAgentToolsFile(file));
  assert.deepEqual(written.toolsets.defaults, raw.toolsets.defaults);
  assert.deepEqual(written.toolsets.threads, raw.toolsets.threads);
  assert.deepEqual(written.toolsetDeclines, raw.toolsetDeclines);
  // A write of a readable cell keeps its row's unreadable neighbours.
  const defaults: Record<string, Record<string, boolean>> = file.toolsets.defaults;
  defaults.notes!.claude = false;
  assert.deepEqual(JSON.parse(serializeAgentToolsFile(file)).toolsets.defaults.notes, { claude: false, codex: true });
});

test("removing a thread drops its overrides, declines, leftovers and chat grants — nothing else", () => {
  const file = parseAgentToolsFile({
    toolsets: { threads: { t1: { notes: true, x: "?" }, t2: { notes: false } } },
    toolsetDeclines: { t1: { notes: "2026-10-15T10:00:00.000Z" } },
    grants: [
      { id: "a", family: "desktops", scope: "chat", threadId: "t1", projectPath: P, createdAt: "1" },
      { id: "b", family: "desktops", scope: "project", threadId: "t1", projectPath: P, createdAt: "2" },
      { id: "c", family: "desktops", scope: "chat", threadId: "t2", projectPath: P, createdAt: "3" }
    ]
  });
  const after = removeThreadFromAgentTools(file, "t1");
  assert.deepEqual(after.toolsets.threads, { t2: { notes: false } });
  assert.deepEqual(after.toolsetDeclines, {});
  assert.deepEqual(after.grants.map((grant) => grant.id), ["b", "c"]);
  assert.deepEqual(JSON.parse(serializeAgentToolsFile(after)).toolsets.threads, { t2: { notes: false } });
  assert.deepEqual(file.toolsets.threads.t1, { notes: true }, "the input is not changed");
});

test("anything that is not a version-1 file throws, so the daemon moves it aside and grants read as none", () => {
  for (const bad of [null, [], "x", { version: 2 }, { grants: {} }, { toolsets: [] }, { toolsets: { defaults: [] } }]) {
    assert.throws(() => parseAgentToolsFile(bad), /agent-tools/, JSON.stringify(bad));
  }
  assert.deepEqual(createDefaultAgentToolsFile().grants, []);
});

test("toolset resolution: locked always; master switch off → locked only; chat override → setting → catalogue default", () => {
  const file = createDefaultAgentToolsFile();
  const resolve = (threadId: string, agent: string) => resolveThreadToolsets(file, { threadId, agent, toolsets: TOOLSETS });
  assert.deepEqual(resolve("t", "claude"), ["core", "reads"]);
  assert.deepEqual(resolve("t", "grok"), ["core"], "an agent the catalogue does not list is off");
  file.toolsets.defaults = { reads: { claude: false }, notes: { claude: true }, core: { claude: false } };
  assert.deepEqual(resolve("t", "claude"), ["core", "notes"], "settings override the catalogue; core stays");
  file.toolsets.threads = { t: { reads: true, notes: false, core: false, desktops: true, unknown: true } };
  assert.deepEqual(resolve("t", "claude"), ["core", "reads", "desktops"], "the chat override wins");
  assert.deepEqual(resolve("other", "claude"), ["core", "notes"]);
  file.enabled = false;
  assert.deepEqual(resolve("t", "claude"), ["core"]);
});

test("a declined toolset stays declined for 30 minutes", () => {
  const file = createDefaultAgentToolsFile();
  const at = Date.parse("2026-10-15T10:00:00.000Z");
  file.toolsetDeclines = { t: { notes: new Date(at).toISOString(), reads: "not a date" } };
  assert.equal(toolsetDeclinedUntil(file, "t", "notes", at + 1_000), at + AGENT_TOOLSET_DECLINE_MS);
  assert.equal(toolsetDeclinedUntil(file, "t", "notes", at + AGENT_TOOLSET_DECLINE_MS), null);
  assert.equal(toolsetDeclinedUntil(file, "t", "reads", at), null);
  assert.equal(toolsetDeclinedUntil(file, "u", "notes", at), null);
});

test("findGrant: only full-access, non workflow-owned callers; chat grants of that chat; project grants of that project", () => {
  const file = parseAgentToolsFile({
    grants: [
      { id: "chat-desk", family: "desktops", scope: "chat", threadId: "t", projectPath: P, createdAt: "1" },
      { id: "proj-desk", family: "desktops", scope: "project", projectPath: "/w/ws/other", createdAt: "2" },
      { id: "prompts", family: "saved-prompts", scope: "project", projectPath: P, createdAt: "3" },
      { id: "profile", family: "agent-profile", scope: "chat", threadId: "t", projectPath: P, createdAt: "4" },
      { id: "secrets", family: "workflow-secrets", scope: "chat", threadId: "t", projectPath: P, createdAt: "5" }
    ]
  });
  const q = (over: Partial<AgentToolGrantQuery>): AgentToolGrantQuery => ({
    family: "desktops",
    callerRuntimeMode: "full-access",
    workflowOwned: false,
    threadId: "t",
    projectPath: P,
    projects: [P],
    ...over
  });
  assert.equal(findGrant(file, q({}))?.id, "chat-desk");
  assert.equal(findGrant(file, q({ threadId: "u" })), null, "another chat's grant");
  assert.equal(findGrant(file, q({ threadId: "u", projectPath: "/w/ws/other", projects: ["/w/ws/other"] }))?.id, "proj-desk");
  for (const mode of ["approval-required", "auto-accept-edits", "auto"]) assert.equal(findGrant(file, q({ callerRuntimeMode: mode })), null, mode);
  assert.equal(findGrant(file, q({ workflowOwned: true })), null);
  assert.equal(findGrant(file, q({ projects: [P, "/w/ws/other"] })), null, "cross-project Admin");
  assert.equal(findGrant(file, q({ pendingProjects: 1 })), null, "a temp project");
  assert.equal(findGrant(file, q({ workspaceTargets: 1 })), null, "a workspace-level target (outside the project)");
  assert.equal(findGrant(file, q({ projectPath: "", projects: [] })), null, "a chat with no project");
  assert.equal(findGrant(file, q({ family: "saved-prompts" })), null, "saved-prompts grants are chat-only: a project record is never honoured");
  assert.equal(findGrant(file, q({ family: "agent-profile" })), null, "never grantable, whatever the file says");
  assert.equal(findGrant(file, q({ family: "workflow-secrets" })), null);
});

test("findGrant: workflows grants cover only the workflows recorded in that chat — never a create or a referenced prompt", () => {
  const file = parseAgentToolsFile({
    grants: [{ id: "wf", family: "workflows", scope: "chat", threadId: "t", projectPath: P, workflowIds: ["wf_1"], createdAt: "1" }]
  });
  const q = (over: Partial<AgentToolGrantQuery>): AgentToolGrantQuery => ({
    family: "workflows",
    callerRuntimeMode: "full-access",
    workflowOwned: false,
    threadId: "t",
    projectPath: P,
    projects: [P],
    ...over
  });
  assert.equal(findGrant(file, q({ workflowId: "wf_1" }))?.id, "wf");
  assert.equal(findGrant(file, q({ workflowId: "wf_2" })), null, "a workflow not approved in the chat");
  assert.equal(findGrant(file, q({})), null, "a create");
  assert.equal(findGrant(file, q({ workflowId: "wf_1", workflowReferencedPrompt: true })), null);
  assert.equal(findGrant(file, q({ workflowId: "wf_1", projects: [P, "/w/ws/b"] })), null, "a union reaching another project");
});

test("findGrant: a cross-project grant covers its one target project", () => {
  const file = parseAgentToolsFile({
    grants: [{ id: "x", family: "cross-project", scope: "chat", threadId: "t", projectPath: P, targetProjectPath: "/w/other/app", createdAt: "1" }]
  });
  const q: AgentToolGrantQuery = { family: "cross-project", callerRuntimeMode: "full-access", workflowOwned: false, threadId: "t", projectPath: P, projects: ["/w/other/app"], targetProjectPath: "/w/other/app" };
  assert.equal(findGrant(file, q)?.id, "x");
  assert.equal(findGrant(file, { ...q, targetProjectPath: "/w/other/b" }), null);
  assert.equal(findGrant(file, { ...q, targetProjectPath: undefined }), null);
});
