/**
 * Scenario tests over the integrated unified MCP (design 2026-10-15 §14.2.11; plan Task 15): every
 * call goes through a REAL transport — the socket-only session-tool route as the agent host makes
 * it (chat audience), or the remote `/mcp` (external audience) — into THE executor, the gate, the
 * real approval port and card routes, and the daemon's real routes and stores, over a fake agent
 * host (`./scenario-world.ts`). A person answers each card on its card route as the GUI does, and
 * each scenario asserts what was persisted.
 *
 * Expected outcomes come from the spec: §5.2 (the gate matrix, S13), §5.3 (turn policy), §5.4
 * (workflow-owned), §6 (tiers), §7 (cards, grants), §8 (conversation), §9.3 (toolsets), §12.1
 * (daemon-pointing servers), and the ledger's rulings.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { out, scenarioWorld, type ScenarioWorld } from "./scenario-world.ts";

const SEED = {
  projects: { jaspersito: ["orquester", "orquester-3"], acme: ["site", "docs"] },
  gitAccounts: { jaspersito: "acct-jasper", acme: "acct-acme" }
};

/** A world for one test, closed after it. */
async function withWorld(run: (w: ScenarioWorld) => Promise<void>): Promise<void> {
  const w = await scenarioWorld(SEED);
  try {
    await run(w);
  } finally {
    await w.close();
  }
}

const ok = (result: CallToolResult): Record<string, any> => {
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
  return out(result);
};
const refused = (result: CallToolResult, code: string): Record<string, any> => {
  assert.equal(result.isError, true, `expected ${code}, got ${JSON.stringify(result.structuredContent).slice(0, 400)}`);
  assert.equal(out(result).code, code, JSON.stringify(out(result)));
  return out(result);
};

// ---------------------------------------------------------------------------
// (a) Cross-project and cross-workspace sessions (§5.2, ruling S13, §5.3, §5.4)
// ---------------------------------------------------------------------------

describe("acceptance (a): a chat opens a session in another project, by workspace and permission mode", () => {
  test("same workspace: Full access opens it at once; below Full access the user approves or denies a boundary card with no grant", async () => {
    await withWorld(async (w) => {
      const orq = w.project("jaspersito/orquester");
      const orq3 = w.project("jaspersito/orquester-3");
      w.host.addChat("full", { project: orq, title: "Implement auth", runtimeMode: "full-access" });
      w.host.userTurn("full", "Open a Codex chat in orquester-3.");
      const opened = ok(await w.uncarded("full", "create_session", { project: "jaspersito/orquester-3", agent: "codex", prompt: "Survey the repo.", reply: "none" }));
      const tab = w.host.tabs.get(opened.sessionId)!;
      assert.equal(tab.projectPath, orq3);
      assert.equal(tab.refId, "codex");
      assert.deepEqual({ parent: tab.lineage?.parentThreadId, relation: tab.lineage?.relation, agentCreated: tab.lineage?.agentCreated }, { parent: "full", relation: "opened", agentCreated: true });
      assert.equal(w.host.threads.get(opened.sessionId)!.runtimeMode, "full-access", "the caller's own mode by default");
      assert.equal(w.host.postsTo(opened.sessionId).length, 1, "its first turn was posted");

      for (const mode of ["auto", "auto-accept-edits", "approval-required"] as const) {
        const id = `chat-${mode}`;
        w.host.addChat(id, { project: orq, title: `Chat in ${mode}`, runtimeMode: mode });
        w.host.userTurn(id, "Open a chat in orquester-3.");
        const before = w.host.tabs.size;
        const denied = await w.carded(id, "create_session", { project: "jaspersito/orquester-3", prompt: "Survey the repo.", reply: "none" }, { decision: "deny", reason: "Not in that project" });
        assert.equal(denied.card.kind, "boundary");
        assert.equal(denied.card.family, "cross-project");
        assert.deepEqual(denied.card.grantOptions, [], `${mode}: no grant below Full access`);
        assert.equal(denied.card.title, "Claude wants to open a chat in jaspersito/orquester-3");
        assert.deepEqual(denied.card.scope.projects?.map((p) => [p.path, p.gitAccountLabel]), [[orq, "JasperDev (GitHub)"], [orq3, "JasperDev (GitHub)"]]);
        const deniedOut = refused(denied.result, "APPROVAL_DENIED");
        assert.match(deniedOut.message, /Not in that project/);
        assert.equal(deniedOut.toolApproval.outcome, "denied");
        assert.equal(w.host.tabs.size, before, `${mode}: nothing opened on a deny`);

        const approved = await w.carded(id, "create_session", { project: "jaspersito/orquester-3", prompt: "Survey the repo.", reply: "none" }, { decision: "approve" });
        const created = ok(approved.result);
        assert.equal(created.toolApproval.outcome, "approved");
        assert.equal(w.host.tabs.get(created.sessionId)!.projectPath, orq3);
        assert.equal(w.host.threads.get(created.sessionId)!.runtimeMode, mode, `${mode}: the opened chat runs no broader than its opener`);
        // A broader mode for the new chat is refused before any card (never broader, §5.3).
        if (mode !== "auto") {
          const broader = refused(await w.uncarded(id, "create_session", { prompt: "x", runtimeMode: "full-access", reply: "none" }), "PERMISSION_DENIED");
          assert.match(broader.message, /full-access/);
        }
      }
      // A grant offered to nobody is honoured for nobody: an approve naming one is refused 400 and the card stays open.
      w.host.addChat("sup", { project: orq, title: "Supervised", runtimeMode: "approval-required" });
      w.host.userTurn("sup", "again");
      const pending = w.chat("sup", "create_session", { project: "jaspersito/orquester-3", prompt: "Survey.", reply: "none" });
      const card = await w.cards.next();
      const bad = await w.answer(card, { decision: "approve", grant: "chat" });
      assert.equal(bad.status, 400);
      assert.equal((await w.answer(card, { decision: "deny" })).status, 200);
      refused(await pending, "APPROVAL_DENIED");
      assert.equal(w.runtime.tools.snapshot().grants.length, 0, "no grant was ever recorded");
    });
  });

  test("another workspace: a card in every mode naming both git identities; Full access may grant it for this chat and that one project only, honoured only while Full access", async () => {
    await withWorld(async (w) => {
      const site = w.project("acme/site");
      const orq3 = w.project("jaspersito/orquester-3");
      // A chat in workspace acme opens a session in jaspersito/orquester-3.
      w.host.addChat("acme-chat", { project: site, title: "Site work", runtimeMode: "full-access" });
      w.host.userTurn("acme-chat", "Open a chat in jaspersito/orquester-3.");
      const first = await w.carded("acme-chat", "create_session", { project: "jaspersito/orquester-3", agent: "codex", runtimeMode: "auto", prompt: "Port the fix.", reply: "none" }, { decision: "approve", grant: "chat" });
      assert.equal(first.card.kind, "boundary");
      assert.equal(first.card.family, "cross-project");
      assert.deepEqual(first.card.grantOptions, ["chat"], "Full access: grantable for this chat");
      assert.deepEqual(first.card.scope.projects?.map((p) => [p.workspace, p.gitAccountLabel]), [["acme", "Acme Bot (GitHub)"], ["jaspersito", "JasperDev (GitHub)"]], "both identities named");
      assert.ok(first.answered.grantId, "the grant was recorded");
      const created = ok(first.result);
      assert.equal(w.host.tabs.get(created.sessionId)!.projectPath, orq3);
      assert.equal(w.host.threads.get(created.sessionId)!.runtimeMode, "auto");
      const grants = w.runtime.tools.snapshot().grants;
      assert.equal(grants.length, 1);
      assert.deepEqual({ family: grants[0]!.family, scope: grants[0]!.scope, thread: grants[0]!.threadId, target: grants[0]!.targetProjectPath }, { family: "cross-project", scope: "chat", thread: "acme-chat", target: orq3 });

      // The grant covers the next session in that project, without a card…
      const again = ok(await w.uncarded("acme-chat", "create_session", { project: "jaspersito/orquester-3", prompt: "And the docs.", reply: "none" }));
      assert.equal(again.toolApproval.outcome, "granted");
      assert.equal(w.host.tabs.get(again.sessionId)!.projectPath, orq3);
      // …but not another project of that workspace,
      const other = await w.carded("acme-chat", "create_session", { project: "jaspersito/orquester", prompt: "x", reply: "none" }, { decision: "deny" });
      assert.deepEqual(other.card.grantOptions, ["chat"]);
      refused(other.result, "APPROVAL_DENIED");
      // …nor another chat,
      w.host.addChat("acme-2", { project: site, title: "Second", runtimeMode: "full-access" });
      w.host.userTurn("acme-2", "go");
      refused((await w.carded("acme-2", "create_session", { project: "jaspersito/orquester-3", prompt: "x", reply: "none" }, { decision: "deny" })).result, "APPROVAL_DENIED");
      // …and once the user narrows the chat to Auto it is no longer honoured, nor offered.
      w.host.setMode("acme-chat", "auto");
      const narrowed = await w.carded("acme-chat", "create_session", { project: "jaspersito/orquester-3", prompt: "x", reply: "none" }, { decision: "deny" });
      assert.deepEqual(narrowed.card.grantOptions, []);
      refused(narrowed.result, "APPROVAL_DENIED");

      // The user revokes the grant from Settings › Agent tools: back to a card at Full access.
      w.host.setMode("acme-chat", "full-access");
      assert.equal((await w.user({ method: "DELETE", url: `/api/agent-tools/grants/${grants[0]!.id}` })).status, 204);
      refused((await w.carded("acme-chat", "create_session", { project: "jaspersito/orquester-3", prompt: "x", reply: "none" }, { decision: "deny" })).result, "APPROVAL_DENIED");
      // An agent cannot revoke or write settings itself: only a person.
      assert.equal((await w.internalApi.request("DELETE", "/api/agent-tools/grants", { principal: { kind: "agent", threadId: "acme-chat", projectPath: site, agent: "claude", title: "Site work" } })).status, 403);
    });
  });

  test("another workspace below Full access: every mode cards with no grant; a planning chat's caused turn plans; a workflow-owned chat is refused without a card", async () => {
    await withWorld(async (w) => {
      const site = w.project("acme/site");
      for (const mode of ["auto", "approval-required"] as const) {
        w.host.addChat(mode, { project: site, title: mode, runtimeMode: mode });
        w.host.userTurn(mode, "go");
        const { card, result } = await w.carded(mode, "create_session", { project: "jaspersito/orquester-3", prompt: "x", reply: "none" }, { decision: "approve" });
        assert.equal(card.family, "cross-project");
        assert.deepEqual(card.grantOptions, []);
        assert.equal(w.host.threads.get(ok(result).sessionId)!.runtimeMode, mode);
      }
      // Planning (§5.2, §5.3): the turn-causing Act is allowed (here through the card) and its first turn plans too.
      w.host.addChat("planner", { project: site, title: "Planner", runtimeMode: "full-access" });
      w.host.userTurn("planner", "Plan the port.", { plan: true });
      const planned = await w.carded("planner", "create_session", { project: "jaspersito/orquester-3", prompt: "Plan it there.", reply: "none" }, { decision: "approve" });
      const plannedId = ok(planned.result).sessionId as string;
      assert.equal(w.host.postsTo(plannedId)[0]!.interactionMode, "plan", "plan carries on");
      // Codex has no plan mode: refused before any tab opens (§5.3).
      const before = w.host.tabs.size;
      refused(await w.uncarded("planner", "create_session", { agent: "codex", prompt: "Plan it.", reply: "none" }), "PERMISSION_DENIED");
      assert.equal(w.host.tabs.size, before);
      // A workflow-owned chat never acts in another project, in any mode, and never sees a card (§5.4).
      w.host.addChat("wf-owned", { project: site, title: "Nightly", runtimeMode: "full-access", owner: { kind: "workflow", workflowId: "wf-1", runId: "run-1", nodeId: "agent" } });
      w.host.userTurn("wf-owned", "go");
      const owned = refused(await w.uncarded("wf-owned", "create_session", { project: "jaspersito/orquester-3", prompt: "x", reply: "none" }), "PERMISSION_DENIED");
      assert.match(owned.message, /automated workflow/);
      // Its own project still works (Act, own project).
      ok(await w.uncarded("wf-owned", "create_session", { prompt: "Local helper.", reply: "none" }));
    });
  });

  test("external callers: address validation only — any project, no card, Full access by default; chat-only fields refused", async () => {
    await withWorld(async (w) => {
      const before = w.cards.opened.length;
      const created = ok(await w.external("create_session", { project: "jaspersito/orquester-3", agent: "codex", prompt: "Survey.", reply: "none" }));
      assert.equal(w.host.tabs.get(created.sessionId)!.projectPath, w.project("jaspersito/orquester-3"));
      assert.equal(w.host.threads.get(created.sessionId)!.runtimeMode, "full-access");
      assert.equal(w.host.tabs.get(created.sessionId)!.lineage, undefined, "an external session is nobody's child");
      ok(await w.external("create_session", { project: "acme/site", agent: "claude", prompt: "Survey.", reply: "none" }));
      assert.equal(w.cards.opened.length, before, "no card for an external caller");
      // An external turn carries no exchange (a fresh one, §13).
      assert.equal(w.host.postsTo(created.sessionId)[0]!.causedBy, undefined);
      refused(await w.external("create_session", { project: "acme/site", agent: "claude", prompt: "x", delegate: true }), "INVALID_ARGUMENT");
      refused(await w.external("create_session", { project: "acme/site", agent: "claude", prompt: "x", reply: "notify" }), "INVALID_ARGUMENT");
      refused(await w.external("create_session", { agent: "claude", prompt: "x" }), "INVALID_ARGUMENT");
      refused(await w.external("create_session", { project: "nope/none", agent: "claude", prompt: "x" }), "PROJECT_NOT_FOUND");
    });
  });
});

// ---------------------------------------------------------------------------
// §14.2.11: reads across projects and workspaces (§5.2 read classes, ruling S13, §13 a/b)
// ---------------------------------------------------------------------------

describe("§14.2.11: reads across projects and workspaces", () => {
  test("other-workspace metadata cards below Full access; same-workspace metadata is free and content needs Auto; list_projects only counts other workspaces", async () => {
    await withWorld(async (w) => {
      const orq = w.project("jaspersito/orquester");
      w.host.addChat("site-chat", { project: w.project("acme/site"), title: "Site chat", runtimeMode: "full-access" });
      w.host.userTurn("site-chat", "hello");
      w.host.settle("site-chat", "The site's secret plan.");
      w.host.addChat("orq3-chat", { project: w.project("jaspersito/orquester-3"), title: "Sibling", runtimeMode: "full-access" });
      w.host.userTurn("orq3-chat", "hello");
      w.host.settle("orq3-chat", "Sibling reply text.");
      w.host.addChat("sup", { project: orq, title: "Supervised", runtimeMode: "approval-required" });
      w.host.addChat("auto", { project: orq, title: "Auto", runtimeMode: "auto" });
      w.host.addChat("full", { project: orq, title: "Full", runtimeMode: "full-access" });

      // Other workspace, metadata: a card below Full access (S13), free at Full access.
      const meta = await w.carded("auto", "list_sessions", { project: "acme/site" }, { decision: "deny" });
      assert.equal(meta.card.family, "cross-workspace-read");
      assert.equal(meta.card.kind, "boundary");
      refused(meta.result, "APPROVAL_DENIED");
      const allowed = await w.carded("sup", "get_session", { sessionId: "site-chat" }, { decision: "approve" });
      assert.equal(allowed.card.family, "cross-workspace-read");
      ok(allowed.result);
      ok(await w.uncarded("full", "list_sessions", { project: "acme/site" }));
      ok(await w.uncarded("full", "read_transcript", { sessionId: "site-chat" }));

      // Same workspace: metadata free in every mode; content free from Auto, a card below.
      const detail = ok(await w.uncarded("sup", "get_session", { sessionId: "orq3-chat" }));
      assert.equal(detail.contentOmitted, true, "no content rights below Auto: content omitted, never carded (§13 a)");
      assert.doesNotMatch(JSON.stringify(detail), /Sibling reply text/);
      const read = await w.carded("sup", "read_transcript", { sessionId: "orq3-chat" }, { decision: "approve" });
      assert.equal(read.card.family, "cross-project-read");
      assert.match(JSON.stringify(ok(read.result)), /Sibling reply text/);
      assert.match(JSON.stringify(ok(await w.uncarded("auto", "read_transcript", { sessionId: "orq3-chat" }))), /Sibling reply text/);

      // list_projects below Full access: its own workspace fully, other workspaces only counted (no card).
      const listed = ok(await w.uncarded("auto", "list_projects", {}));
      assert.deepEqual(listed.projects.map((p: { workspace: string; name: string }) => `${p.workspace}/${p.name}`).sort(), ["jaspersito/orquester", "jaspersito/orquester-3"]);
      assert.deepEqual(listed.excludedWorkspaces, [{ workspace: "acme", projectCount: 2 }]);
      const current = listed.projects.find((p: { current?: boolean }) => p.current);
      assert.equal(current.name, "orquester");
      assert.equal(listed.projects.find((p: { name: string }) => p.name === "orquester-3").sameRepo, true, "sibling clones share a repoId (S10)");
      assert.deepEqual(listed.workspaces, [{ name: "jaspersito", gitAccount: { label: "JasperDev (GitHub)", login: "jasperdev", provider: "github" } }]);
      // Naming the other workspace asks; Full access sees everything.
      refused((await w.carded("auto", "list_projects", { workspace: "acme" }, { decision: "deny" })).result, "APPROVAL_DENIED");
      const all = ok(await w.uncarded("full", "list_projects", {}));
      assert.equal(all.projects.length, 4);
      assert.equal(all.excludedWorkspaces, undefined);
      // search_sessions project:"all" below Full access narrows instead of carding (§13 b).
      const search = ok(await w.uncarded("auto", "search_sessions", { query: "reply", project: "all" }));
      assert.equal(search.searched, "workspace");
      assert.equal(search.excludedProjects, 1, "acme/site, the one other project with chats");
      assert.deepEqual(search.hits.map((hit: { sessionId: string }) => hit.sessionId), ["orq3-chat"], "the other workspace's hit is dropped");
      const own = ok(await w.uncarded("sup", "search_sessions", { query: "secret", project: "all" }));
      assert.equal(own.searched, "own-project");
      assert.deepEqual(own.hits, []);
      const everywhere = ok(await w.uncarded("full", "search_sessions", { query: "secret plan", project: "all" }));
      assert.deepEqual(everywhere.hits.map((hit: { sessionId: string }) => hit.sessionId), ["site-chat"]);
    });
  });
});

// ---------------------------------------------------------------------------
// (b) A skill through the agent profile (§6 Admin, §7.1, §7.6 never grantable, §9.3 toolsets)
// ---------------------------------------------------------------------------

describe("acceptance (b) / §14.2.11 'add a skill': edit_agent_profile is an Admin card in every mode, never grantable, and writes exactly what the card showed", () => {
  test("toolset off → request_toolset card → Admin card (no grant even at Full access) → SKILL.md equals the card; Supervised cards too; planning and workflow-owned refused; external writes without a card", async () => {
    await withWorld(async (w) => {
      const orq = w.project("jaspersito/orquester");
      w.host.addChat("claude", { project: orq, title: "Release prep", runtimeMode: "full-access" });
      w.host.userTurn("claude", "Add a release-notes skill to Claude Code.");
      const skill = { name: "release-notes", frontmatter: { description: "Draft release notes from merged PRs" }, body: "# Release notes\n\n1. List merged PRs.\n2. Group them by area.\n" };
      const args = { agent: "claude", reason: "The user asked for a release-notes skill.", changes: [{ action: "create", skill }] };

      // The toolset is off by default: the call says how to ask for it.
      const off = refused(await w.uncarded("claude", "edit_agent_profile", args), "TOOL_NOT_ENABLED");
      assert.match(off.message, /request_toolset/);
      const asked = await w.carded("claude", "request_toolset", { toolset: "agent-profile-editing", reason: "To add the skill you asked for." }, { decision: "approve" });
      assert.equal(asked.card.kind, "toolset");
      assert.deepEqual(asked.card.grantOptions, []);
      const enabled = ok(asked.result);
      assert.equal(enabled.enabled, true);
      assert.equal(enabled.available, "now", "the host applied the new tool list in-session");
      assert.ok(w.host.pushes.some((push) => push.threadId === "claude" && push.tools.includes("edit_agent_profile")), "the manifest pushed to the host now lists the tool");

      // A person may not grant it: an approve naming a grant is refused 400, the card stays pending.
      const pending = w.chat("claude", "edit_agent_profile", args);
      const card = await w.cards.next();
      assert.equal(card.kind, "admin");
      assert.equal(card.family, "agent-profile");
      assert.deepEqual(card.grantOptions, [], "agent-profile is never grantable, even at Full access");
      assert.equal(card.title, "Claude wants to add the skill `release-notes` to Claude Code");
      assert.equal(card.reason, "The user asked for a release-notes skill.");
      assert.equal((await w.answer(card, { decision: "approve", grant: "chat" })).status, 400);
      // The whole preview the GUI's "View all" opens: the code section is the file to be written.
      const detail = await w.user({ method: "GET", url: `/api/sessions/claude/tool-approvals/${card.approvalId}` });
      assert.equal(detail.status, 200);
      const shown = (detail.body.approval.sections as { kind: string; text?: string; title?: string }[]).find((section) => section.kind === "code");
      assert.equal((await w.answer(card, { decision: "approve" })).status, 200);
      const done = ok(await pending);
      assert.equal(done.toolApproval.outcome, "approved");
      const file = `${w.homes.claudeDir}/skills/release-notes/SKILL.md`;
      assert.equal(await readFile(file, "utf8"), shown?.text, "the written file equals the card");
      assert.ok((await w.agentProfile.snapshot("claude")).items.some((item) => item.id === "skill:release-notes"));
      assert.equal(w.runtime.tools.snapshot().grants.length, 0);

      // A Supervised chat gets the same Admin card (ruling S1: no mode gate); denying writes nothing.
      w.host.addChat("sup", { project: orq, title: "Supervised", runtimeMode: "approval-required" });
      assert.equal((await w.user({ method: "PUT", url: "/api/sessions/sup/agent-tools", payload: { toolsets: { "agent-profile-editing": true } } })).status, 200);
      w.host.userTurn("sup", "Add another skill.");
      const other = { agent: "claude", changes: [{ action: "create", skill: { name: "triage", frontmatter: { description: "Triage issues" }, body: "Triage.\n" } }] };
      const supDenied = await w.carded("sup", "edit_agent_profile", other, { decision: "deny", reason: "Not this one" });
      assert.equal(supDenied.card.kind, "admin");
      assert.deepEqual(supDenied.card.grantOptions, []);
      refused(supDenied.result, "APPROVAL_DENIED");
      assert.equal((await w.agentProfile.snapshot("claude")).items.some((item) => item.id === "skill:triage"), false, "nothing written on a deny");

      // Planning: Admin is refused outright (no card); a workflow-owned chat gets ADMIN_NOT_AVAILABLE.
      w.host.userTurn("claude", "Plan more skills.", { plan: true });
      const planning = refused(await w.uncarded("claude", "edit_agent_profile", other), "PERMISSION_DENIED");
      assert.match(planning.message, /planning/);
      w.host.addChat("wf", { project: orq, title: "Nightly", runtimeMode: "full-access", owner: { kind: "workflow", workflowId: "wf-1", runId: "r-1", nodeId: "a" } });
      w.host.userTurn("wf", "go");
      refused(await w.uncarded("wf", "edit_agent_profile", other), "TOOL_NOT_ENABLED");
      assert.equal((await w.user({ method: "PUT", url: "/api/sessions/wf/agent-tools", payload: { toolsets: { "agent-profile-editing": true } } })).status, 200);
      refused(await w.uncarded("wf", "edit_agent_profile", other), "ADMIN_NOT_AVAILABLE");
      refused(await w.uncarded("wf", "request_toolset", { toolset: "workflow-authoring", reason: "x" }), "PERMISSION_DENIED");

      // External: full trust — no card, written at once.
      const before = w.cards.opened.length;
      ok(await w.external("edit_agent_profile", other));
      assert.equal(w.cards.opened.length, before);
      assert.ok((await w.agentProfile.snapshot("claude")).items.some((item) => item.id === "skill:triage"));
    });
  });
});

// ---------------------------------------------------------------------------
// (c) Saved prompts (§4.1 "Saved prompts", D-16, §7.6)
// ---------------------------------------------------------------------------

describe("acceptance (c) / §14.2.11 saved prompts: global and per project; the agent's own edits are Act, the user's are Admin, a workflow's are workflow code", () => {
  test("create global + project prompts (no card, stamped as the agent's, unpinnable); edit the agent's (no card) vs the user's (card, grantable at Full access); a workflow-referenced one cards as workflows, never grantable", async () => {
    await withWorld(async (w) => {
      const orq = w.project("jaspersito/orquester");
      w.host.addChat("claude", { project: orq, title: "Prompt librarian", runtimeMode: "full-access" });
      w.host.userTurn("claude", "Save two prompts for me.");
      refused(await w.uncarded("claude", "update_saved_prompts", { action: "create", title: "x", body: "y", global: true }), "TOOL_NOT_ENABLED");
      // The user turns the toolset on in the chat's Tools chip; an agent may not (only a person).
      assert.equal((await w.internalApi.request("PUT", "/api/sessions/claude/agent-tools", { body: { toolsets: { notes: true } }, principal: { kind: "agent", threadId: "claude", projectPath: orq, agent: "claude", title: "x" } })).status, 403);
      assert.equal((await w.user({ method: "PUT", url: "/api/sessions/claude/agent-tools", payload: { toolsets: { notes: true } } })).status, 200);

      const global = ok(await w.uncarded("claude", "update_saved_prompts", { action: "create", global: true, title: "Release checklist", body: "Check {project} on {branch}.", tags: ["release"] })).prompt;
      assert.equal(global.scope, "global");
      assert.deepEqual(global.createdBy, { kind: "agent", threadId: "claude", agent: "claude", title: "Prompt librarian" });
      const project = ok(await w.uncarded("claude", "update_saved_prompts", { action: "create", title: "Review auth", body: "Review the auth module." })).prompt;
      assert.equal(project.scope, "project");
      assert.equal(project.projectPath, orq);
      // Persisted, as the right rail lists them (the "by Claude" badge reads createdBy).
      const stored = w.savedPrompts.get(project.id)!;
      assert.equal(stored.createdBy?.kind, "agent");
      assert.equal(w.savedPrompts.get(global.id)!.projectPath, null);
      // Chats cannot pin; the daemon refuses pinning an agent-made prompt to anyone but the user.
      refused(await w.uncarded("claude", "update_saved_prompts", { action: "update", id: project.id, pinned: true }), "INVALID_ARGUMENT");
      refused(await w.external("update_saved_prompts", { action: "update", id: project.id, project: "jaspersito/orquester", pinned: true }), "AGENT_PROMPT_PIN_REFUSED");
      assert.equal(w.savedPrompts.get(project.id)!.pinned, false);
      assert.equal((await w.user({ method: "PUT", url: `/api/saved-prompts/${project.id}`, payload: { pinned: true } })).status, 200, "the user pins it explicitly");

      // The agent edits its own prompt: Act, no card.
      ok(await w.uncarded("claude", "update_saved_prompts", { action: "update", id: global.id, body: "Check {project} on {branch} and {date}." }));
      assert.equal(w.savedPrompts.get(global.id)!.body, "Check {project} on {branch} and {date}.");

      // A prompt the USER made: Admin `saved-prompts`, with the diff; grantable for this chat at Full access.
      const mine = await w.user({ method: "POST", url: "/api/saved-prompts", payload: { title: "My standup", body: "Summarise yesterday.", projectPath: null } });
      assert.equal(mine.status, 201, JSON.stringify(mine.body));
      assert.equal(mine.body.createdBy, undefined);
      const edit = await w.carded("claude", "update_saved_prompts", { action: "update", id: mine.body.id, body: "Summarise yesterday and today.", reason: "Asked to extend it." }, { decision: "approve", grant: "chat" });
      assert.equal(edit.card.kind, "admin");
      assert.equal(edit.card.family, "saved-prompts");
      assert.deepEqual(edit.card.grantOptions, ["chat"]);
      assert.match(JSON.stringify(edit.card.sections), /\+Summarise yesterday and today\./);
      assert.match(JSON.stringify(edit.card.sections), /Created by you/);
      ok(edit.result);
      assert.equal(w.savedPrompts.get(mine.body.id)!.body, "Summarise yesterday and today.");
      // The grant covers the next edit of a user prompt in this chat.
      ok(await w.uncarded("claude", "update_saved_prompts", { action: "update", id: mine.body.id, title: "Standup" }));
      assert.equal(w.savedPrompts.get(mine.body.id)!.title, "Standup");
      // An Auto chat gets the card without a grant option; denying leaves the prompt as it was.
      w.host.addChat("auto", { project: orq, title: "Auto", runtimeMode: "auto" });
      await w.user({ method: "PUT", url: "/api/sessions/auto/agent-tools", payload: { toolsets: { notes: true } } });
      w.host.userTurn("auto", "edit");
      const autoEdit = await w.carded("auto", "update_saved_prompts", { action: "delete", id: mine.body.id }, { decision: "deny" });
      assert.deepEqual(autoEdit.card.grantOptions, []);
      refused(autoEdit.result, "APPROVAL_DENIED");
      assert.ok(w.savedPrompts.get(mine.body.id), "not deleted");

      // A prompt a workflow's agent block references is workflow code: Admin `workflows`, named workflows, never grantable.
      const workflow = await w.user({
        method: "POST", url: "/api/workflows",
        payload: {
          name: "Nightly review", project: { kind: "existing", projectPath: orq },
          nodes: [{ type: "trigger.manual", name: "Go" }, { type: "agent", name: "Review", config: { prompt: { kind: "saved", promptId: project.id } } }],
          edges: [{ source: "Go", target: "Review" }]
        }
      });
      assert.ok(workflow.status < 300, JSON.stringify(workflow.body));
      const referenced = await w.carded("claude", "update_saved_prompts", { action: "update", id: project.id, body: "Review the auth module, then the session module." }, { decision: "approve" });
      assert.equal(referenced.card.kind, "admin");
      assert.equal(referenced.card.family, "workflows");
      assert.deepEqual(referenced.card.grantOptions, [], "a workflow-referenced prompt is never grantable");
      assert.match(JSON.stringify(referenced.card.sections), /Nightly review/);
      ok(referenced.result);
      assert.equal(w.savedPrompts.get(project.id)!.body, "Review the auth module, then the session module.");
      // Even the chat's saved-prompts grant does not cover it: the next edit cards again.
      refused((await w.carded("claude", "update_saved_prompts", { action: "update", id: project.id, title: "Renamed" }, { decision: "deny" })).result, "APPROVAL_DENIED");
    });
  });
});
