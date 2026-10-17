/**
 * `agent-tools.json` (unified MCP design 2026-10-15 §9.6): tolerant read and rewrite — older
 * builds' toolset switches kept verbatim but never read — version refusal and `findGrant`'s rules
 * (§7.6, MUST 8).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createDefaultAgentToolsFile,
  findGrant,
  parseAgentToolsFile,
  removeThreadFromAgentTools,
  serializeAgentToolsFile,
  type AgentToolGrantQuery
} from "./index.ts";

const P = "/w/ws/app";

/** A file as an older build (with toolset switches) wrote it. */
const LEGACY = {
  version: 1,
  revision: 4,
  enabled: false,
  futureSetting: { a: 1 },
  toolsets: {
    defaults: { notes: { claude: true, "future-agent": false }, reads: { codex: "on" }, "future-toolset": { codex: true } },
    threads: { t1: { desktops: true }, t2: { notes: false } },
    perProject: { "/x": {} }
  },
  toolsetDeclines: { t1: { notes: "2026-10-15T10:00:00.000Z" }, t3: 17 },
  grants: [
    { id: "g1", family: "desktops", scope: "project", projectPath: P, createdAt: "x", note: "kept" },
    { id: "g2", family: "telepathy", scope: "galaxy", projectPath: P, createdAt: "x" },
    { id: "g3", family: "desktops", scope: "chat", threadId: "t1", projectPath: P, createdAt: "y" },
    { id: "", family: "desktops" },
    "garbage"
  ]
};

test("an older build's file round-trips: its toolset switches, unknown keys and grant families survive a rewrite untouched", () => {
  const file = parseAgentToolsFile(structuredClone(LEGACY));
  assert.deepEqual(file.grants.map((grant) => grant.id), ["g1", "g2", "g3"]);
  assert.equal(file.grants[0]?.note, "kept");
  assert.deepEqual(file.unreadableGrants, [{ id: "", family: "desktops" }, "garbage"]);
  // Never interpreted: kept as found, whatever they hold (a newer or older build's values alike).
  assert.deepEqual(file.extra, {
    revision: LEGACY.revision,
    enabled: LEGACY.enabled,
    futureSetting: LEGACY.futureSetting,
    toolsets: LEGACY.toolsets,
    toolsetDeclines: LEGACY.toolsetDeclines
  });
  assert.deepEqual(JSON.parse(serializeAgentToolsFile(file)), LEGACY);
  assert.deepEqual(parseAgentToolsFile(JSON.parse(serializeAgentToolsFile(file))), file);
});

test("grants keep working beside the legacy switches: a grant added and one revoked leave them untouched", () => {
  const file = parseAgentToolsFile(structuredClone(LEGACY));
  const changed = {
    ...file,
    grants: [
      ...file.grants.filter((grant) => grant.id !== "g1"),
      { id: "g4", family: "desktops", scope: "chat", threadId: "t9", projectPath: P, createdAt: "z" }
    ]
  };
  const written = JSON.parse(serializeAgentToolsFile(changed));
  assert.deepEqual(written.toolsets, LEGACY.toolsets);
  assert.deepEqual(written.toolsetDeclines, LEGACY.toolsetDeclines);
  assert.equal(written.enabled, false);
  assert.equal(written.revision, 4);
  const q: AgentToolGrantQuery = { family: "desktops", callerRuntimeMode: "full-access", workflowOwned: false, threadId: "t9", projectPath: P, projects: [P] };
  assert.equal(findGrant(parseAgentToolsFile(written), q)?.id, "g4");
  // `enabled: false` (an older build's master switch) changes nothing for grants.
  assert.equal(findGrant(file, { ...q, threadId: "other" })?.id, "g1");
});

test("missing fields read as defaults; a fresh file holds grants only", () => {
  assert.deepEqual(parseAgentToolsFile({}), createDefaultAgentToolsFile());
  assert.deepEqual(JSON.parse(serializeAgentToolsFile(createDefaultAgentToolsFile())), { version: 1, grants: [] });
});

test("removing a thread drops its chat grants and its legacy rows — nothing else", () => {
  const file = parseAgentToolsFile(structuredClone(LEGACY));
  const after = removeThreadFromAgentTools(file, "t1");
  assert.deepEqual(after.grants.map((grant) => grant.id), ["g1", "g2"]);
  const written = JSON.parse(serializeAgentToolsFile(after));
  assert.deepEqual(written.toolsets, { ...LEGACY.toolsets, threads: { t2: { notes: false } } });
  assert.deepEqual(written.toolsetDeclines, { t3: 17 });
  assert.deepEqual(written.futureSetting, LEGACY.futureSetting);
  assert.deepEqual(file.extra?.toolsets, LEGACY.toolsets, "the input is not changed");
  // Nothing of the thread in the file: the same object (the store writes nothing).
  assert.equal(removeThreadFromAgentTools(after, "t1"), after);
  assert.equal(removeThreadFromAgentTools(createDefaultAgentToolsFile(), "t1").grants.length, 0);
  // Unreadable legacy shapes are left alone.
  const odd = parseAgentToolsFile({ toolsets: "x", toolsetDeclines: [1] });
  assert.equal(removeThreadFromAgentTools(odd, "t1"), odd);
});

test("anything that is not a version-1 file throws, so the daemon moves it aside and grants read as none", () => {
  for (const bad of [null, [], "x", { version: 2 }, { grants: {} }]) {
    assert.throws(() => parseAgentToolsFile(bad), /agent-tools/, JSON.stringify(bad));
  }
  // Legacy keys are no longer read, so their shape no longer matters.
  assert.deepEqual(parseAgentToolsFile({ toolsets: [] }).extra, { toolsets: [] });
  assert.deepEqual(createDefaultAgentToolsFile().grants, []);
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
