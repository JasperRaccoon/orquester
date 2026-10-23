/**
 * Scenario tests over the integrated unified MCP (design 2026-10-15 §14.2.11; plan Task 15): every
 * call goes through a REAL transport — the socket-only session-tool route as the agent host makes
 * it (chat audience), or the remote `/mcp` (external audience) — into THE executor, the gate, the
 * real approval port and card routes, and the daemon's real routes and stores, over a fake agent
 * host (`./scenario-world.ts`). A person answers each card on its card route as the GUI does, and
 * each scenario asserts what was persisted.
 *
 * Expected outcomes come from the spec: §5.2 (the gate matrix, S13), §5.3 (turn policy), §5.4
 * (workflow-owned), §6 (tiers), §7 (cards, grants), §8 (conversation), §9.4 (every chat tool in every chat), §12.1
 * (daemon-pointing servers), and the ledger's rulings.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  agentChatRoutes,
  currentOptionValue,
  modelChipLabel,
  modelPickerHint,
  optionDescriptors,
  parseThreadMessage,
  resolveLaunchModel,
  RUNTIME_MODE_LABELS,
  type ProviderModel
} from "@orquester/api/agent-chat";
import { sessionProfileRoutes, workflowRoutes } from "@orquester/api";
import { agentChatThreadsDir, agentToolApprovalsJournalFile, agentToolsFile } from "@orquester/config";

import { claudeDeniedMcpServers, claudeDisallowedTools } from "../agent-host/adapters/claude/session-tools.ts";
import { codexDenyConfig } from "../agent-host/adapters/codex/session-tools.ts";
import { GROK_UNREACHABLE_SHADOW_URL, grokSessionMcpServers } from "../agent-host/adapters/grok/session-tools.ts";
import { withSessionToolRules } from "../agent-host/adapters/opencode/session-tools.ts";
import { daemonRoutesForHost } from "../agent-host/host-protocol.ts";
import { estimateCostParts } from "../usage-tokens.ts";
import { catalogFor } from "./catalog/index.ts";
import { isoWeek } from "./usage-view.ts";
import { DAEMON_BEARER, DAEMON_PORT, HOST_BEARER, out, scenarioWorld, writeHomeFile, type ScenarioWorld } from "./testing/scenario-world.ts";

const SEED = {
  projects: { jaspersito: ["orquester", "orquester-3"], acme: ["site", "docs"] },
  gitAccounts: { jaspersito: "acct-jasper", acme: "acct-acme" }
};

/** The chat manifest the agent host reads at launch (socket-only route, the host's bearer). */
async function manifestOf(w: ScenarioWorld, threadId: string): Promise<{ tools: string[]; deny: string[]; toolsets?: string[]; instructions: string }> {
  const res = await w.local.inject({ method: "POST", url: daemonRoutesForHost.sessionToolsManifest, headers: { authorization: HOST_BEARER }, payload: { threadId } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

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
        // A broader mode for the new chat is refused before any card (never broader, §5.3), in every mode below Full access.
        const broader = refused(await w.uncarded(id, "create_session", { prompt: "x", runtimeMode: "full-access", reply: "none" }), "PERMISSION_DENIED");
        assert.match(broader.message, /full-access/);
      }
      // A grant offered to nobody is honoured for nobody: an approve naming one is refused 400 and the card stays open.
      w.host.addChat("sup", { project: orq, title: "Supervised", runtimeMode: "approval-required" });
      w.host.userTurn("sup", "again");
      const pending = w.chat("sup", "create_session", { project: "jaspersito/orquester-3", prompt: "Survey.", reply: "none" });
      const card = await w.cardFor(pending, "create_session");
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

  test("the create card shows the permission mode the new chat will really get; a broader one is refused before any card", async () => {
    await withWorld(async (w) => {
      const orq = w.project("jaspersito/orquester");
      // A mode this daemon does not know (a newer host's): read as the narrowest (fail closed).
      w.host.addChat("odd", { project: orq, title: "Odd mode", runtimeMode: "bypass-everything" as never });
      w.host.userTurn("odd", "Open a chat in orquester-3.");
      const { card, result } = await w.carded("odd", "create_session", { project: "jaspersito/orquester-3", prompt: "Survey.", reply: "none" }, { decision: "approve" });
      const shown = (card.sections[0] as { rows: { label: string; value: string }[] }).rows.find((row) => row.label === "Permission mode")!.value;
      const created = ok(result);
      assert.equal(w.host.threads.get(created.sessionId)!.runtimeMode, "approval-required");
      assert.equal(shown, "approval-required", "what the user approves is what runs");
      // Auto asking for a Full-access chat elsewhere: refused at once — no card the call could never honour.
      w.host.addChat("auto", { project: orq, title: "Auto", runtimeMode: "auto" });
      w.host.userTurn("auto", "go");
      const broader = refused(await w.uncarded("auto", "create_session", { project: "jaspersito/orquester-3", runtimeMode: "full-access", prompt: "x", reply: "none" }), "PERMISSION_DENIED");
      assert.match(broader.message, /broader/);
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
// (b) A skill through the agent profile (§6 Admin, §7.1, §7.6 never grantable)
// ---------------------------------------------------------------------------

describe("acceptance (b) / §14.2.11 'add a skill': edit_agent_profile is an Admin card in every mode, never grantable, and writes exactly what the card showed", () => {
  test("advertised to a fresh chat → Admin card (no grant even at Full access) → SKILL.md equals the card; Supervised cards too; planning and workflow-owned refused; external writes without a card", async () => {
    await withWorld(async (w) => {
      const orq = w.project("jaspersito/orquester");
      w.host.addChat("claude", { project: orq, title: "Release prep", runtimeMode: "full-access" });
      w.host.userTurn("claude", "Add a release-notes skill to Claude Code.");
      const skill = { name: "release-notes", frontmatter: { description: "Draft release notes from merged PRs" }, body: "# Release notes\n\n1. List merged PRs.\n2. Group them by area.\n" };
      const args = { agent: "claude", reason: "The user asked for a release-notes skill.", changes: [{ action: "create", skill }] };

      // Nothing to turn on: a fresh chat is advertised every chat tool, and there is no request_toolset.
      const launched = await manifestOf(w, "claude");
      // boxes: the box tools are advertised only while a box can be rented (none in this world);
      // the knowledge tools only while the Knowledge Graph plugin is on (not wired in this world).
      assert.deepEqual(launched.tools, catalogFor("chat").filter((tool) => tool.toolset !== "boxes" && tool.toolset !== "knowledge").map((tool) => tool.name));
      assert.equal(launched.tools.includes("request_toolset"), false);
      refused(await w.uncarded("claude", "request_toolset", { toolset: "agent-profile-editing", reason: "x" }), "TOOL_NOT_FOUND");

      // A person may not grant it: an approve naming a grant is refused 400, the card stays pending.
      const pending = w.chat("claude", "edit_agent_profile", args);
      const card = await w.cardFor(pending, "edit_agent_profile");
      assert.equal(card.kind, "admin");
      assert.equal(card.family, "agent-profile");
      assert.deepEqual(card.grantOptions, [], "agent-profile is never grantable, even at Full access");
      assert.equal(card.title, "Claude wants to add the skill `release-notes` to Claude Code");
      assert.equal(card.reason, "The user asked for a release-notes skill.");
      assert.equal((await w.answer(card, { decision: "approve", grant: "chat" })).status, 400);
      // The whole preview the GUI's "View all" opens: the code section is the file to be written.
      const detail = await w.user({ method: "GET", url: agentChatRoutes.toolApproval("claude", card.approvalId) });
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
      refused(await w.uncarded("wf", "edit_agent_profile", other), "ADMIN_NOT_AVAILABLE");

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
      // Nothing to turn on first: the chat's Tools chip has no toolset switch (the route is gone).
      assert.equal((await w.user({ method: "PUT", url: "/api/sessions/claude/agent-tools", payload: { toolsets: { notes: true } } })).status, 404);

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

describe("a global prompt's creator below Full access", () => {
  test("createdBy is named only for the caller itself and chats of its workspace; another workspace's, or an unknown thread, reads as its kind", async () => {
    await withWorld(async (w) => {
      const site = w.project("acme/site");
      const docs = w.project("acme/docs");
      const orq = w.project("jaspersito/orquester");
      w.host.addChat("maker", { project: site, title: "Maker", runtimeMode: "auto" });
      w.host.addChat("neighbour", { project: docs, title: "Neighbour", runtimeMode: "auto" });
      w.host.addChat("stranger", { project: orq, title: "Stranger", runtimeMode: "auto" });
      w.host.addChat("wide", { project: orq, title: "Wide", runtimeMode: "full-access" });
      for (const id of ["maker", "neighbour", "stranger", "wide"]) {
        w.host.userTurn(id, "Look at the prompts.");
      }
      const made = ok(await w.uncarded("maker", "update_saved_prompts", { action: "create", global: true, title: "Shared checklist", body: "Check it." })).prompt;
      // A global prompt whose creating chat no open tab names any more.
      const ghost = await w.savedPrompts.create({ title: "Ghost's", body: "b", projectPath: null }, { kind: "agent", threadId: "ghost-thread", projectPath: "", agent: "codex", title: "Gone chat" });
      const creatorOf = async (threadId: string, id: string) =>
        (ok(await w.uncarded(threadId, "list_saved_prompts", {})).prompts as { id: string; createdBy?: Record<string, unknown> }[]).find((row) => row.id === id)?.createdBy;
      const full = { kind: "agent", threadId: "maker", agent: "claude", title: "Maker" };
      assert.deepEqual(await creatorOf("maker", made.id), full, "the caller itself");
      assert.deepEqual(await creatorOf("neighbour", made.id), full, "a chat of the caller's workspace");
      assert.deepEqual(await creatorOf("stranger", made.id), { kind: "agent" }, "another workspace's chat");
      assert.deepEqual(await creatorOf("wide", made.id), full, "Full access");
      assert.deepEqual(await creatorOf("neighbour", ghost.id), { kind: "agent" }, "an unknown thread counts as another workspace");
      assert.equal((await creatorOf("wide", ghost.id))?.title, "Gone chat");
      // The update's result row follows the same rule.
      const edited = ok(await w.uncarded("stranger", "update_saved_prompts", { action: "update", id: made.id, body: "Check it twice." })).prompt;
      assert.deepEqual(edited.createdBy, { kind: "agent" });
    });
  });
});

describe("saved prompts shared by a repository's checkouts, on workflow cards", () => {
  test("a repository prompt whose only checkout was deleted: the create card shows its body in full and pins it, never as missing", async () => {
    await withWorld(async (w) => {
      const exec = promisify(execFile);
      const orq = w.project("jaspersito/orquester");
      const clone = w.project("jaspersito/orquester-3");
      // Only orquester-3 is a checkout of the repository; orquester is a plain folder.
      await exec("git", ["init", "-q", clone]);
      await exec("git", ["-C", clone, "remote", "add", "origin", "git@github.com:jaspersito/orquester.git"]);
      const created = await w.user({ method: "POST", url: "/api/saved-prompts", payload: { title: "Shared review", body: "Review {diff} for the release.", projectPath: clone } });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.repoKey, "github.com/jaspersito/orquester");
      await rm(clone, { recursive: true, force: true });
      // No current checkout lists it any more; the engine still renders it by id.
      assert.equal((await w.savedPrompts.list(orq)).prompts.some((prompt) => prompt.id === created.body.id), false);
      assert.equal(w.savedPrompts.get(created.body.id)?.body, "Review {diff} for the release.");

      w.host.addChat("claude", { project: orq, title: "Automate", runtimeMode: "full-access" });
      w.host.userTurn("claude", "Automate the release review.");
      const card = await w.carded("claude", "create_workflow", {
        name: "Release review",
        project: { kind: "existing", project: "jaspersito/orquester" },
        nodes: [{ type: "trigger.manual", name: "Go" }, { type: "agent", name: "Review", config: { prompt: { kind: "saved", promptId: created.body.id } } }],
        edges: [{ source: "Go", target: "Review" }]
      }, { decision: "approve" });
      const sections = JSON.stringify(card.card.sections);
      assert.match(sections, /Saved prompt \\"Shared review\\"/);
      assert.match(sections, /Review \{diff\} for the release\./);
      assert.doesNotMatch(sections, /does not exist/);
      // The pins the card took verify against the same lookup: the create runs.
      ok(card.result);
    });
  });
});

// ---------------------------------------------------------------------------
// (d) Workflows under one chat grant (§4.1 "Workflows", §7.2 revisions, §7.6 grants, rulings)
// ---------------------------------------------------------------------------

describe("acceptance (d) / §14.2.11 workflows: create → modify → enable → run (revision pinned) → watch → debug → fix → disable → enable → delete under one chat grant", () => {
  test("the grant made on the create card covers every later call in that chat; a user-made sub-workflow it does not cover forces a card", async () => {
    await withWorld(async (w) => {
      const orq = w.project("jaspersito/orquester");
      w.host.addChat("claude", { project: orq, title: "Automate", runtimeMode: "full-access" });
      w.host.userTurn("claude", "Automate the build check.");

      // A dry run validates (Read): no card, nothing saved.
      const definition = {
        name: "Build check",
        project: { kind: "existing", project: "jaspersito/orquester" },
        nodes: [
          { type: "trigger.manual", name: "Go" },
          { type: "shell", name: "Check", config: { script: "echo building; echo 'error: missing lockfile' >&2; exit 3" } }
        ],
        edges: [{ source: "Go", target: "Check" }]
      };
      const dry = ok(await w.uncarded("claude", "create_workflow", { ...definition, dryRun: true }));
      assert.equal(dry.valid, true, JSON.stringify(dry.problems));
      assert.equal(w.workflows.service.list().length, 0);

      // create: Admin card, family workflows, grantable for this chat; the user approves with the grant.
      const created = await w.carded("claude", "create_workflow", { ...definition, reason: "The user asked to automate the build check." }, { decision: "approve", grant: "chat" });
      assert.equal(created.card.kind, "admin");
      assert.equal(created.card.family, "workflows");
      assert.deepEqual(created.card.grantOptions, ["chat"]);
      assert.match(created.card.title, /create the workflow "Build check"/);
      assert.match(JSON.stringify(created.card.sections), /missing lockfile/, "the card shows the script that will run");
      const wf = ok(created.result);
      const id = wf.workflowId as string;
      assert.equal(w.workflows.service.get(id)!.enabled, false, "created disabled");
      const grant = w.runtime.tools.snapshot().grants.find((g) => g.family === "workflows")!;
      assert.equal(grant.scope, "chat");
      assert.equal(grant.threadId, "claude");
      assert.deepEqual(grant.workflowIds, [id], "the new workflow joined the grant");

      // modify, enable — no card (the grant), persisted.
      let revision = wf.revision as number;
      const renamed = ok(await w.uncarded("claude", "update_workflow", { workflowId: id, revision, ops: [{ op: "set_name", name: "Build check (CI)" }] }));
      assert.equal(renamed.toolApproval.outcome, "granted");
      revision = renamed.revision;
      revision = ok(await w.uncarded("claude", "update_workflow", { workflowId: id, revision, ops: [{ op: "set_enabled", enabled: true }] })).revision;
      assert.equal(w.workflows.service.get(id)!.enabled, true);
      assert.equal(w.workflows.service.get(id)!.name, "Build check (CI)");

      // run at a stale revision: refused before anything runs (the run route pins the revision).
      refused(await w.uncarded("claude", "run_workflow", { workflowId: id, revision: revision - 1, wait: true }), "REVISION_CONFLICT");
      assert.deepEqual(ok(await w.uncarded("claude", "get_workflow_runs", { workflowId: id })).runs, [], "nothing ran");
      // run and wait: the shell block fails.
      const failed = ok(await w.uncarded("claude", "run_workflow", { workflowId: id, revision, wait: true, timeoutSeconds: 120 }));
      assert.equal(failed.finished, true);
      assert.equal(failed.run.status, "failed");
      const runId = failed.run.runId as string;
      // watch / inspect / debug: the run list, the run, the failing block's stderr.
      const runs = ok(await w.uncarded("claude", "get_workflow_runs", { workflowId: id }));
      assert.deepEqual(runs.runs.map((run: { runId: string }) => run.runId), [runId]);
      const inspected = ok(await w.uncarded("claude", "get_workflow_runs", { runId }));
      assert.equal(inspected.run.status, "failed");
      const stderr = ok(await w.uncarded("claude", "get_workflow_runs", { runId, nodeId: "Check", log: "stderr" }));
      assert.match(JSON.stringify(stderr), /missing lockfile/);
      const stdout = ok(await w.uncarded("claude", "get_workflow_runs", { runId, nodeId: "Check", log: "stdout" }));
      assert.match(JSON.stringify(stdout), /building/);

      // fix, run without waiting, then watch it to the end (bus-driven wait).
      revision = ok(await w.uncarded("claude", "update_workflow", { workflowId: id, revision, ops: [{ op: "update_node", node: "Check", set: { config: { script: "echo build ok" } } }] })).revision;
      const started = ok(await w.uncarded("claude", "run_workflow", { workflowId: id, revision }));
      const watched = ok(await w.uncarded("claude", "get_workflow_runs", { runId: started.runId, waitSeconds: 120 }));
      assert.equal(watched.run.status, "succeeded", JSON.stringify(watched).slice(0, 400));
      const output = ok(await w.uncarded("claude", "get_workflow_runs", { runId: started.runId, nodeId: "Check" }));
      assert.match(JSON.stringify(output.output), /build ok/);

      // disable, enable — still no card.
      revision = ok(await w.uncarded("claude", "update_workflow", { workflowId: id, revision, ops: [{ op: "set_enabled", enabled: false }] })).revision;
      assert.equal(w.workflows.service.get(id)!.enabled, false);
      revision = ok(await w.uncarded("claude", "update_workflow", { workflowId: id, revision, ops: [{ op: "set_enabled", enabled: true }] })).revision;
      assert.equal(w.workflows.service.get(id)!.enabled, true);

      // A sub-workflow the grant does not cover: the user's own workflow, called from the agent's.
      const users = await w.user({
        method: "POST", url: "/api/workflows",
        payload: { name: "Notify team", project: { kind: "existing", projectPath: orq }, nodes: [{ type: "trigger.manual", name: "Start" }, { type: "code", name: "Say", config: { source: "export default () => ({ said: 'hi' })" } }], edges: [{ source: "Start", target: "Say" }] }
      });
      assert.ok(users.status < 300, JSON.stringify(users.body));
      const childId = users.body.workflow.id as string;
      const addChild = await w.carded("claude", "update_workflow", {
        workflowId: id, revision,
        ops: [{ op: "add_node", node: { type: "workflow", name: "Notify", config: { workflowId: childId } } }, { op: "connect", source: "Check", target: "Notify" }]
      }, { decision: "approve" });
      assert.equal(addChild.card.family, "workflows");
      assert.match(JSON.stringify(addChild.card.sections), /Notify team/, "the card names the workflow it would start calling");
      revision = ok(addChild.result).revision;
      assert.deepEqual(w.runtime.tools.snapshot().grants.find((g) => g.family === "workflows")!.workflowIds, [id], "approving once never widens the grant");
      // Running it now cards too (the child is not covered); approved once, the run includes the child's.
      const childRun = await w.carded("claude", "run_workflow", { workflowId: id, revision, wait: true, timeoutSeconds: 120 }, { decision: "approve" });
      assert.match(childRun.card.title, /run the workflow "Build check \(CI\)"/);
      const ran = ok(childRun.result);
      assert.equal(ran.run.status, "succeeded", JSON.stringify(ran).slice(0, 600));
      // The user's workflow run directly: a card (never the agent's grant).
      const direct = await w.carded("claude", "run_workflow", { workflowId: childId, revision: w.workflows.service.get(childId)!.revision }, { decision: "deny" });
      refused(direct.result, "APPROVAL_DENIED");
      // Deleting the user's workflow cards; deleting the agent's own does not.
      refused((await w.carded("claude", "delete_workflow", { workflowId: childId, confirm: true }, { decision: "deny" })).result, "APPROVAL_DENIED");
      assert.ok(w.workflows.service.get(childId));
      ok(await w.uncarded("claude", "delete_workflow", { workflowId: id, confirm: true }));
      assert.equal(w.workflows.service.get(id) ?? null, null, "deleted");

      // Another chat, even at Full access, holds no grant: its first call on a workflow cards.
      w.host.addChat("other", { project: orq, title: "Other", runtimeMode: "full-access" });
      w.host.userTurn("other", "run it");
      refused((await w.carded("other", "run_workflow", { workflowId: childId, revision: w.workflows.service.get(childId)!.revision }, { decision: "deny" })).result, "APPROVAL_DENIED");
      // Closing the chat drops its grant.
      assert.equal((await w.user({ method: "DELETE", url: "/api/sessions/claude" })).status, 204);
      assert.equal(w.runtime.tools.snapshot().grants.filter((g) => g.threadId === "claude").length, 0);
    });
  });
});

describe("§12.5 / §7.6 secrets and workspaces: a workflow secret is typed into its card and never crosses the agent; a workflow reaching another workspace is never granted", () => {
  test("set_workflow_secret: an Admin card in a chat holding a workflows grant, no grant option, the value only in the store — never in results, events, cards or files", async () => {
    await withWorld(async (w) => {
      const orq = w.project("jaspersito/orquester");
      w.host.addChat("claude", { project: orq, title: "Jira bot", runtimeMode: "full-access" });
      w.host.userTurn("claude", "Wire Jira.");
      const created = await w.carded("claude", "create_workflow", {
        name: "Jira sync", project: { kind: "existing", project: "jaspersito/orquester" },
        nodes: [{ type: "trigger.manual", name: "Go" }, { type: "shell", name: "Call", config: { script: "echo \"token=$TOKEN\"", env: [{ name: "TOKEN", value: "{{ secrets.JIRA_TOKEN }}" }] } }],
        edges: [{ source: "Go", target: "Call" }]
      }, { decision: "approve", grant: "chat" });
      const id = ok(created.result).workflowId as string;
      // The chat never passes a value (external-only field).
      refused(await w.uncarded("claude", "set_workflow_secret", { name: "JIRA_TOKEN", workflowId: id, value: "leak" }), "INVALID_ARGUMENT");
      const VALUE = "jira-SECRET-value-7f3a9";
      const set = await w.carded("claude", "set_workflow_secret", { name: "JIRA_TOKEN", workflowId: id, reason: "The sync needs it." }, { decision: "approve", secrets: { value: VALUE } });
      assert.equal(set.card.kind, "admin");
      assert.equal(set.card.family, "workflow-secrets");
      assert.deepEqual(set.card.grantOptions, [], "never grantable, even under a workflows grant at Full access");
      assert.deepEqual(set.card.secretFields.map((field) => field.key), ["value"]);
      const result = ok(set.result);
      assert.equal(result.set, true);
      assert.equal(w.workflows.secrets.resolve(id).JIRA_TOKEN, VALUE, "stored");
      // The run reads it; its stored output is redacted.
      const revision = w.workflows.service.get(id)!.revision;
      const ran = ok(await w.uncarded("claude", "run_workflow", { workflowId: id, revision, wait: true, timeoutSeconds: 120 }));
      assert.equal(ran.run.status, "succeeded");
      const output = ok(await w.uncarded("claude", "get_workflow_runs", { runId: ran.run.runId, nodeId: "Call", log: "stdout" }));
      assert.match(JSON.stringify(output), /token=/, "the block ran with it");
      // Never anywhere the agent, a client or a log reader sees.
      for (const [where, text] of [
        ["tool results", JSON.stringify([set.result, ran, output])],
        ["bus events", JSON.stringify(w.events)],
        ["the card", JSON.stringify(set.card)],
        ["agent-tools.json", await w.runtime.tools.flush().then(() => readFile(agentToolsFile(w.appdir), "utf8"))],
        ["the approvals journal", await readFile(agentToolApprovalsJournalFile(w.appdir), "utf8").catch(() => "")]
      ] as const) assert.doesNotMatch(text, new RegExp(VALUE), `the secret leaked into ${where}`);
    });
  });

  test("a workflow whose project is in another workspace: a card naming that workspace's identity, never a grant", async () => {
    await withWorld(async (w) => {
      w.host.addChat("claude", { project: w.project("jaspersito/orquester"), title: "Automate", runtimeMode: "full-access" });
      w.host.userTurn("claude", "Automate the site.");
      const { card, result } = await w.carded("claude", "create_workflow", {
        name: "Site check", project: { kind: "existing", project: "acme/site" },
        nodes: [{ type: "trigger.manual", name: "Go" }, { type: "code", name: "Ok", config: { source: "export default () => 1" } }], edges: [{ source: "Go", target: "Ok" }]
      }, { decision: "approve" });
      assert.equal(card.family, "workflows");
      assert.deepEqual(card.grantOptions, [], "a project union leaving the caller's project is never granted");
      assert.ok(card.scope.projects?.some((p) => p.workspace === "acme" && p.gitAccountLabel === "Acme Bot (GitHub)"));
      ok(result);
      assert.equal(w.runtime.tools.snapshot().grants.length, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// (e) Usage per session and per week (§4.1 get_usage, ruling S9)
// ---------------------------------------------------------------------------

describe("acceptance (e) / §14.2.11 usage: per session for Claude, Codex and Grok, and per ISO week, priced from the Cost tab's one price table", () => {
  test("session cost: Claude estimated (1h cache writes, the picker's resolved model), Codex estimated, Grok reported; floor flags; weekly buckets from the scanner; quota without emails for chats", async () => {
    const saved = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
    try {
      await withWorld(async (w) => {
        const orq = w.project("jaspersito/orquester");
        const price = (model: string, t: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number }) => {
          const parts = estimateCostParts(model, t)!;
          return parts.input + parts.output + parts.cache;
        };
        const round4 = (usd: number) => Math.round(usd * 10_000) / 10_000;

        // A Claude chat on `default` (the picker resolves it to claude-opus-5-5): one plain turn, one with
        // subagents, a settled compaction, older turns outside the window.
        w.host.addChat("claude", { project: orq, title: "Claude work", agent: "claude", runtimeMode: "full-access" });
        w.host.userTurn("claude", "one");
        w.host.settle("claude", "done", { tokenUsage: { usageScope: "main_agent", usageStatus: "complete", inputTokens: 10_000, outputTokens: 1_000, cachedInputTokens: 6_000, cacheCreationTokens: 2_000, hasSubagents: false } });
        w.host.userTurn("claude", "two");
        w.host.settle("claude", "done", { totalCostUsd: 99, tokenUsage: { usageScope: "main_agent", usageStatus: "complete", inputTokens: 4_000, outputTokens: 500, cachedInputTokens: 3_000, cacheCreationTokens: 0, hasSubagents: true } });
        w.host.threads.get("claude")!.items.push({ kind: "activity", id: "compact-1", tone: "info", activityKind: "context-compaction", summary: "Compacted", payload: { state: "compacted" }, turnId: null, createdAt: "t", updatedAt: "t" } as never);
        w.host.setHistory("claude", { hasOlder: true, totalTurns: 7 } as never);
        const claude = ok(await w.uncarded("claude", "get_usage", { sessionId: "claude" })).session;
        const claudeExpected = price("claude-opus-5-5", { input: 2_000, output: 1_000, cacheRead: 6_000, cacheWrite: 2_000, cacheWrite1h: 2_000 })
          + price("claude-opus-5-5", { input: 1_000, output: 500, cacheRead: 3_000, cacheWrite: 0, cacheWrite1h: 0 });
        assert.equal(claude.costSource, "estimated", "Claude's cumulative total_cost_usd is never summed");
        assert.equal(claude.costUsd, round4(claudeExpected));
        assert.equal(claude.costUsd, 0.0598, "hand-checked: (2k·4 + 1k·20 + 6k·0.2 + 2k·8 + 1k·4 + 0.5k·20 + 3k·0.2) / 1M");
        assert.deepEqual({ partial: claude.partial, totalTurns: claude.totalTurns, mainAgentOnly: claude.mainAgentOnly, sub: claude.turnsWithSubagents, compactions: claude.compactions }, { partial: true, totalTurns: 7, mainAgentOnly: true, sub: 1, compactions: 1 }, "floor flags");

        // Codex reports tokens only: estimated from the same table (no cache-write rate: writes bill as input).
        w.host.addChat("codex", { project: orq, title: "Codex work", agent: "codex", runtimeMode: "auto" });
        w.host.userTurn("codex", "go");
        w.host.settle("codex", "done", { tokenUsage: { usageScope: "main_agent", usageStatus: "complete", inputTokens: 5_000, outputTokens: 500, cachedInputTokens: 1_000, hasSubagents: false } });
        const codex = ok(await w.uncarded("claude", "get_usage", { sessionId: "codex" })).session;
        assert.equal(codex.costSource, "estimated");
        assert.equal(codex.model, "gpt-5.6-terra");
        assert.equal(codex.costUsd, round4(price("gpt-5.6-terra", { input: 4_000, output: 500, cacheRead: 1_000, cacheWrite: 0, cacheWrite1h: 0 })));

        // Grok reports a per-turn cost: used as reported.
        w.host.addChat("grok", { project: orq, title: "Grok work", agent: "grok", runtimeMode: "auto" });
        w.host.userTurn("grok", "go");
        w.host.settle("grok", "done", { totalCostUsd: 0.0123, tokenUsage: { usageScope: "main_agent", usageStatus: "complete", inputTokens: 900, outputTokens: 100, hasSubagents: false } });
        const grok = ok(await w.uncarded("claude", "get_usage", { sessionId: "grok" })).session;
        assert.deepEqual({ source: grok.costSource, usd: grok.costUsd }, { source: "reported", usd: 0.0123 });

        // Per week: the Cost tab's scanner over this world's home — Claude and Codex transcripts in two ISO weeks.
        const now = Date.now();
        const today = new Date(now).toISOString().slice(0, 10);
        const lastWeek = new Date(now - 7 * 86_400_000).toISOString().slice(0, 10);
        const line = (o: unknown) => JSON.stringify(o);
        await writeHomeFile(`${w.homes.claudeDir}/projects/p/t.jsonl`, [
          line({ timestamp: `${today}T01:00:00Z`, requestId: "r1", message: { id: "m1", model: "claude-opus-5-5", usage: { input_tokens: 2_000, output_tokens: 1_000, cache_read_input_tokens: 6_000, cache_creation_input_tokens: 2_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2_000 } } } }),
          line({ timestamp: `${lastWeek}T01:00:00Z`, requestId: "r2", message: { id: "m2", model: "claude-opus-5-5", usage: { input_tokens: 1_000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
        ].join("\n"));
        await writeHomeFile(`${w.homes.codexHome}/sessions/s.jsonl`, [
          line({ timestamp: `${today}T02:00:00Z`, type: "turn_context", payload: { model: "gpt-5.6-terra" } }),
          line({ timestamp: `${today}T02:00:00Z`, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 5_500 }, last_token_usage: { input_tokens: 5_000, output_tokens: 500, cached_input_tokens: 1_000, total_tokens: 5_500 } } } })
        ].join("\n"));
        // Grok has no transcript the Cost tab scans: its per-turn reported cost from Orquester's own chat logs
        // (a Grok chat's durable events.ndjson, closed or open), labelled "Orquester chats only".
        await writeHomeFile(join(agentChatThreadsDir(w.appdir), "grok-weekly", "events.ndjson"), [
          line({ type: "thread.created", occurredAt: `${lastWeek}T00:00:00Z`, payload: { adapter: "grok", modelSelection: { model: "grok-4" } }, seq: 1 }),
          line({ type: "thread.session-set", occurredAt: `${lastWeek}T03:00:00Z`, payload: { session: { status: "ready", activeTurnId: null }, turn: { turnId: "g1", totalCostUsd: 0.25, tokenUsage: { usageScope: "main_agent", usageStatus: "complete", inputTokens: 900, outputTokens: 100, hasSubagents: false } } }, seq: 2 }),
          line({ type: "thread.session-set", occurredAt: `${today}T03:00:00Z`, payload: { session: { status: "ready", activeTurnId: null }, turn: { turnId: "g2", totalCostUsd: 0.5, tokenUsage: { usageScope: "main_agent", usageStatus: "complete", inputTokens: 1_800, outputTokens: 200, cachedInputTokens: 800, hasSubagents: false } } }, seq: 3 })
        ].join("\n") + "\n");
        // The daemon's transcript watcher rescans (as get_cost did, `refresh` re-reads the quota only).
        await w.usageTokens.snapshot(true);
        const cost = ok(await w.uncarded("claude", "get_usage", { include: ["cost"], bucket: "week", days: 14 })).cost;
        const thisWeek = isoWeek(today).week;
        const priorWeek = isoWeek(lastWeek).week;
        assert.notEqual(thisWeek, priorWeek);
        const claudeThisWeek = price("claude-opus-5-5", { input: 2_000, output: 1_000, cacheRead: 6_000, cacheWrite: 2_000, cacheWrite1h: 2_000 });
        const codexThisWeek = price("gpt-5.6-terra", { input: 4_000, output: 500, cacheRead: 1_000, cacheWrite: 0, cacheWrite1h: 0 });
        const claudePrior = price("claude-opus-5-5", { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
        const byWeek = Object.fromEntries(cost.byWeek.map((row: { week: string; usd: number }) => [row.week, row.usd]));
        assert.equal(byWeek[thisWeek], round4(claudeThisWeek + codexThisWeek + 0.5));
        assert.equal(byWeek[priorWeek], round4(claudePrior + 0.25));
        assert.deepEqual(
          cost.rows.map((row: { agent: string; week: string }) => `${row.week} ${row.agent}`).sort(),
          [`${priorWeek} claude`, `${thisWeek} claude`, `${thisWeek} codex`, `${priorWeek} grok`, `${thisWeek} grok`].sort()
        );
        const grokThisWeek = cost.rows.find((row: { agent: string; week: string }) => row.agent === "grok" && row.week === thisWeek);
        assert.deepEqual(
          { usd: grokThisWeek.costUsd, scope: grokThisWeek.scope, input: grokThisWeek.inputTokens, cached: grokThisWeek.cacheReadTokens, model: grokThisWeek.model },
          { usd: 0.5, scope: "orquester-chats", input: 1_000, cached: 800, model: "grok-4" },
          "Grok per week: its reported cost from Orquester's chats"
        );
        assert.match(cost.orquesterChatsOnly.find((entry: { agent: string }) => entry.agent === "grok").note, /Orquester chats only.*not counted/);

        // Quota windows: chats never see an account's email; external callers do.
        w.quota = { agents: [
          { id: "claude", available: true, stale: false, plan: "Max", session: { percent: 12 }, weekly: { percent: 40 }, accounts: [{ id: "acct-1", label: "Work", available: true, stale: false, session: { percent: 12 }, weekly: { percent: 40 } }] },
          { id: "codex", available: true, stale: false, session: { percent: 3 }, weekly: { percent: 9 } },
          { id: "grok", available: true, stale: false, session: null, weekly: { percent: 55 } }
        ] } as never;
        w.agentAccounts = { accounts: [{ id: "acct-1", agent: "claude", label: "Work", email: "me@example.com", plan: "Max", needsReauth: false, createdAt: "t", importedAt: "t" }], defaults: { claude: "acct-1", codex: null, grok: null } };
        const quota = ok(await w.uncarded("claude", "get_usage", {}));
        assert.deepEqual(quota.agents.map((agent: { id: string }) => agent.id), ["claude", "codex", "grok"]);
        assert.equal(quota.agents[2].windows[0].percentUsed, 55);
        assert.equal(quota.agents[0].accounts[0].label, "Work");
        assert.doesNotMatch(JSON.stringify(quota), /me@example\.com/, "a chat never sees an account's email");
        assert.equal(ok(await w.external("get_usage", {})).agents[0].accounts[0].email, "me@example.com");

        // Another workspace's session usage is metadata there: a card below Full access (S13).
        w.host.addChat("site", { project: w.project("acme/site"), title: "Site", agent: "codex", runtimeMode: "auto" });
        w.host.addChat("auto", { project: orq, title: "Auto", runtimeMode: "auto" });
        const away = await w.carded("auto", "get_usage", { sessionId: "site" }, { decision: "deny" });
        assert.equal(away.card.family, "cross-workspace-read");
        refused(away.result, "APPROVAL_DENIED");
        ok(await w.uncarded("auto", "get_usage", { sessionId: "codex" }));
      });
    } finally {
      if (saved.claude !== undefined) process.env.CLAUDE_CONFIG_DIR = saved.claude;
      if (saved.codex !== undefined) process.env.CODEX_HOME = saved.codex;
    }
  });
});

// ---------------------------------------------------------------------------
// (f) The review conversation (§8, §8.7, §5.3 never broader, ruling)
// ---------------------------------------------------------------------------

describe("acceptance (f) / §14.2.11 review: Claude (Full access) opens Codex (Supervised) in its own project; notify and wait round trips; never broader, WAIT_CYCLE and the hop cap hold", () => {
  test("two notify round trips and a wait, Codex's own send refused, WAIT_CYCLE once raised, EXCHANGE_LIMIT at hop 8, a user turn starts a fresh exchange", async () => {
    await withWorld(async (w) => {
      const orq = w.project("jaspersito/orquester");
      w.host.addChat("claude", { project: orq, title: "Implement auth", runtimeMode: "full-access" });
      w.host.userTurn("claude", "Implement auth, then get it reviewed by Codex.");

      // 1. Own project, Act: no card. The child is opened, agent-created, Supervised.
      const opened = ok(await w.uncarded("claude", "create_session", {
        agent: "codex", runtimeMode: "approval-required", title: "Codex review",
        prompt: "Review the uncommitted diff in this project; list the issues.", reply: "notify"
      }));
      assert.equal(opened.willNotify, true);
      const codex = opened.sessionId as string;
      assert.deepEqual({ ...w.host.tabs.get(codex)!.lineage, createdAt: undefined }, { parentThreadId: "claude", relation: "opened", agentCreated: true, createdAt: undefined, delegationDepth: 1 });
      assert.equal(w.host.threads.get(codex)!.runtimeMode, "approval-required");
      await w.drain();
      const exchangeId = w.host.runningTurn(codex)!.causedBy!.exchangeId;
      assert.deepEqual(w.host.runningTurn(codex)!.causedBy, { threadId: "claude", exchangeId, hop: 1 });
      const header = parseThreadMessage(w.host.postsTo(codex)[0]!.input)!;
      assert.equal(header.origin, "opened");
      assert.equal(header.fromProject, "jaspersito/orquester");

      // 2. Claude ends its turn; Codex's review comes back to Claude as a Reply (notify, hop 2).
      w.host.settle("claude", "Asked Codex for a review.");
      w.host.settle(codex, "1. Missing CSRF check. 2. Token logged.");
      await w.drain();
      const deliveries = () => w.host.postsTo("claude").map((body) => parseThreadMessage(body.input)!);
      assert.equal(deliveries().length, 1);
      assert.equal(deliveries()[0]!.origin, "reply");
      assert.match(deliveries()[0]!.body, /Missing CSRF check/);
      assert.deepEqual(w.host.runningTurn("claude")!.causedBy, { threadId: codex, exchangeId, hop: 2 });

      // 3. Claude follows up with reply:"wait" (hop 3) and gets the answer in the call.
      const posted = w.host.nextPost(codex);
      const asking = w.uncarded("claude", "send_message", { sessionId: codex, text: "Fixed 1 and 2; re-review.", reply: "wait", timeoutSeconds: 120 });
      // The post is the receipt; the call answering first (it never posted) fails at once.
      await Promise.race([posted, asking.then((result) => assert.fail(`send_message answered before posting: ${JSON.stringify(result.structuredContent)}`))]);
      await w.drain();
      assert.deepEqual(w.host.runningTurn(codex)!.causedBy, { threadId: "claude", exchangeId, hop: 3 });
      // Codex starting its own conversation with the broader Claude is refused in every reply mode (never broader).
      for (const reply of ["wait", "notify", "none"] as const) {
        const own = refused(await w.uncarded(codex, "send_message", { sessionId: "claude", text: "Which CSRF library?", reply }), "PERMISSION_DENIED");
        assert.match(own.message, /broader/);
      }
      // Raised to Full access by the user, the same blocking wait would close a cycle: WAIT_CYCLE, nothing queued.
      w.host.setMode(codex, "full-access");
      refused(await w.uncarded(codex, "send_message", { sessionId: "claude", text: "Which CSRF library?", reply: "wait" }), "WAIT_CYCLE");
      w.host.setMode(codex, "approval-required");
      assert.equal(w.lineage.pending().filter((entry) => entry.parentSessionId === "claude").length, 0);
      w.host.settle(codex, "Looks good now. One question: which CSRF library?");
      const answered = ok(await asking);
      assert.equal(answered.outcome, "completed");
      assert.equal(answered.reply, "Looks good now. One question: which CSRF library?");
      assert.ok(answered.notice, "another agent's words are marked as data");
      await w.drain();
      assert.equal(deliveries().length, 1, "a reply a waiter took is never also delivered");

      // 4. Claude answers with reply:"notify" round trips until the exchange reaches its cap.
      for (const expectedHop of [3, 5, 7]) {
        const sent = ok(await w.uncarded("claude", "send_message", { sessionId: codex, text: `Answer ${expectedHop}: csurf.`, reply: "notify" }));
        assert.equal(sent.willNotify, true);
        await w.drain();
        assert.equal(w.host.runningTurn(codex)!.causedBy!.hop, expectedHop);
        w.host.settle("claude", "Waiting for Codex.");
        w.host.settle(codex, `Reply to ${expectedHop}.`);
        await w.drain();
        assert.equal(w.host.runningTurn("claude")!.causedBy!.hop, expectedHop + 1, "the delivery is the next hop");
        assert.match(deliveries().at(-1)!.body, new RegExp(`Reply to ${expectedHop}`));
      }
      // Claude's turn is hop 8 now: no further agent-caused turn.
      const capped = refused(await w.uncarded("claude", "send_message", { sessionId: codex, text: "One more?", reply: "notify" }), "EXCHANGE_LIMIT");
      assert.match(capped.message, /summar/i);
      const before = w.host.posts.length;
      refused(await w.uncarded("claude", "create_session", { prompt: "Another helper.", reply: "none" }), "EXCHANGE_LIMIT");
      assert.equal(w.host.posts.length, before, "nothing posted");

      // 5. The user's own message starts a fresh exchange.
      w.host.settle("claude", "Summary for the user.");
      w.host.userTurn("claude", "Thanks — ask Codex for a final pass.");
      ok(await w.uncarded("claude", "send_message", { sessionId: codex, text: "Final pass, please.", reply: "notify" }));
      await w.drain();
      const fresh = w.host.runningTurn(codex)!.causedBy!;
      assert.equal(fresh.hop, 1);
      assert.notEqual(fresh.exchangeId, exchangeId);
    });
  });
});

// ---------------------------------------------------------------------------
// (g) Models per provider = the composer's picker (§4.1 list_agents, D-20)
// ---------------------------------------------------------------------------

describe("acceptance (g): list_agents lists each provider's models exactly as the composer's model picker offers them, from the same snapshot", () => {
  test("per provider: same models in order, names, chip labels, hints, default and option defaults; legacy only on request; chat vs external views", async () => {
    await withWorld(async (w) => {
      w.host.addChat("claude", { project: w.project("jaspersito/orquester"), title: "Picker", runtimeMode: "auto" });
      // The composer reads the provider snapshots from this route (the GUI's own request).
      const snapshots = (await w.user({ method: "GET", url: "/api/agent/providers" })).body.providers as { id: string; models: ProviderModel[] }[];
      assert.deepEqual(snapshots.map((p) => p.id), ["claude", "codex", "grok", "opencode"]);
      const all = ok(await w.uncarded("claude", "list_agents", { includeLegacy: true }));
      const visible = ok(await w.uncarded("claude", "list_agents", {}));
      for (const snapshot of snapshots) {
        const agent = all.agents.find((a: { id: string }) => a.id === snapshot.id);
        // The composer's model menu: every model of the snapshot, labelled by name with modelPickerHint, its chip modelChipLabel.
        const composer = snapshot.models.map((model) => ({
          slug: model.slug, name: model.name, hint: modelPickerHint(model), chip: modelChipLabel(model, null),
          options: Object.fromEntries(optionDescriptors(model).map((descriptor) => [descriptor.id, currentOptionValue(null, descriptor)]))
        }));
        const listed = agent.models.map((model: { slug: string; name: string; hint?: string; shortName?: string; options: { id: string; default?: unknown }[] }) => ({
          slug: model.slug, name: model.name, hint: model.hint, chip: model.shortName ?? model.name,
          options: Object.fromEntries(model.options.map((option) => [option.id, option.default]))
        }));
        assert.deepEqual(listed, composer, `${snapshot.id}: list_agents = the composer's picker`);
        // The default is what a launch naming no model gets, as the composer's new chat resolves it.
        assert.equal(agent.defaultModel, resolveLaunchModel(snapshot.models)?.slug ?? null);
        assert.deepEqual(agent.models.filter((m: { isDefault: boolean }) => m.isDefault).map((m: { slug: string }) => m.slug), [agent.defaultModel]);
        // Without includeLegacy: the New-tab menu's list (legacy models left out).
        const plain = visible.agents.find((a: { id: string }) => a.id === snapshot.id);
        assert.deepEqual(plain.models.map((m: { slug: string }) => m.slug), snapshot.models.filter((m) => m.isLegacy !== true).map((m) => m.slug));
      }
      assert.equal(all.agents.find((a: { id: string }) => a.id === "claude").models.find((m: { slug: string }) => m.slug === "claude-opus-4-8").isLegacy, true);
      // query matches slug, name, chip label or sub-provider.
      const sonnet = ok(await w.uncarded("claude", "list_agents", { query: "claude-sonnet-5" }));
      assert.deepEqual(sonnet.agents.map((a: { id: string; models: { slug: string }[] }) => [a.id, a.models.map((m) => m.slug)]), [["claude", ["sonnet"]], ["opencode", ["anthropic/claude-sonnet-5"]]]);
      // Chat view: this chat's settings and the modes a chat it opens may take (never broader); external: every mode.
      assert.deepEqual(all.allowedRuntimeModes, ["approval-required", "auto-accept-edits", "auto"]);
      assert.equal(all.thisThread.agent, "claude");
      assert.deepEqual(all.permissionModes.map((m: { id: string; label: string }) => [m.id, m.label]), Object.entries(RUNTIME_MODE_LABELS));
      const external = ok(await w.external("list_agents", {}));
      assert.equal(external.thisThread, undefined);
      assert.equal(external.allowedRuntimeModes, undefined);
      // A launch through create_session gets the reported default; a legacy model named explicitly is accepted and marked.
      w.host.userTurn("claude", "open helpers");
      const launched = ok(await w.uncarded("claude", "create_session", { agent: "codex", prompt: "x", reply: "none" }));
      assert.equal(launched.model, "gpt-5.6-terra");
      const legacy = ok(await w.uncarded("claude", "create_session", { model: "claude-opus-4-8", prompt: "x", reply: "none" }));
      assert.equal(legacy.isLegacy, true);
      assert.equal(w.host.threads.get(legacy.sessionId)!.model, "claude-opus-4-8");
    });
  });
});

// ---------------------------------------------------------------------------
// (h) Workflow-owned and planning chats (§5.4, §5.2 plan rule, §6)
// ---------------------------------------------------------------------------

describe("acceptance (h): a workflow-owned chat gets no Admin tools and asks for nothing; a planning chat causes no edits elsewhere", () => {
  test("workflow-owned: no Admin tool or request_toolset advertised; Admin calls ADMIN_NOT_AVAILABLE, every card a denial — inherited by the chats it opens, even after it closes", async () => {
    await withWorld(async (w) => {
      const orq = w.project("jaspersito/orquester");
      w.host.addChat("wf", { project: orq, title: "Nightly agent", runtimeMode: "full-access", owner: { kind: "workflow", workflowId: "wf-1", runId: "run-1", nodeId: "agent" } });
      // Every chat tool but the always-Admin ones.
      const manifest = await manifestOf(w, "wf");
      const admin = catalogFor("chat").filter((tool) => tool.tier === "admin").map((tool) => tool.name);
      assert.deepEqual(manifest.tools.filter((name) => admin.includes(name)), [], "no Admin tool advertised");
      assert.deepEqual(manifest.tools, catalogFor("chat").filter((tool) => tool.tier !== "admin" && tool.toolset !== "boxes" && tool.toolset !== "knowledge").map((tool) => tool.name));
      assert.equal(manifest.tools.includes("request_toolset"), false);
      assert.ok(manifest.tools.includes("create_session"));
      w.host.userTurn("wf", "Do the nightly work.");
      // The user's own workflow in this project.
      const userWf = (await w.user({ method: "POST", url: "/api/workflows", payload: { name: "Mine", project: { kind: "existing", projectPath: orq }, nodes: [{ type: "trigger.manual", name: "Go" }] } })).body.workflow;
      refused(await w.uncarded("wf", "run_workflow", { workflowId: userWf.id, revision: userWf.revision }), "ADMIN_NOT_AVAILABLE");
      refused(await w.uncarded("wf", "edit_agent_profile", { agent: "claude", changes: [{ action: "create", skill: { name: "x", frontmatter: { description: "x" }, body: "x" } }] }), "ADMIN_NOT_AVAILABLE");
      const createWf = refused(await w.uncarded("wf", "create_workflow", { name: "Spawn", project: { kind: "existing", project: "jaspersito/orquester" }, nodes: [{ type: "trigger.manual", name: "Go" }] }), "ADMIN_NOT_AVAILABLE");
      assert.match(createWf.message, /automated workflow/);
      const userPrompt = await w.user({ method: "POST", url: "/api/saved-prompts", payload: { title: "Mine", body: "b", projectPath: null } });
      refused(await w.uncarded("wf", "update_saved_prompts", { action: "update", id: userPrompt.body.id, body: "changed" }), "ADMIN_NOT_AVAILABLE");
      // A boundary card becomes a denial too (another workspace's content, below Full access).
      w.host.addChat("site", { project: w.project("acme/site"), title: "Site", runtimeMode: "auto" });
      w.host.setMode("wf", "auto");
      refused(await w.uncarded("wf", "read_transcript", { sessionId: "site" }), "PERMISSION_DENIED");
      w.host.setMode("wf", "full-access");
      // Its own project's Act still works: the agent-made prompt needs no card.
      ok(await w.uncarded("wf", "update_saved_prompts", { action: "create", title: "Nightly notes", body: "notes" }));

      // A chat it opens is workflow-owned (lineage), and stays so after the workflow's chat closes.
      const child = ok(await w.uncarded("wf", "create_session", { prompt: "Help with the nightly work.", reply: "none" })).sessionId as string;
      assert.equal(w.host.tabs.get(child)!.lineage?.workflowOwned, true);
      assert.equal((await w.user({ method: "DELETE", url: "/api/sessions/wf" })).status, 204);
      assert.deepEqual((await manifestOf(w, child)).tools.filter((name) => admin.includes(name)), []);
      refused(await w.uncarded(child, "run_workflow", { workflowId: userWf.id, revision: userWf.revision }), "ADMIN_NOT_AVAILABLE");
      refused(await w.uncarded(child, "create_session", { project: "jaspersito/orquester-3", prompt: "x", reply: "none" }), "PERMISSION_DENIED");
      assert.equal(w.runtime.tools.snapshot().grants.length, 0);
    });
  });

  test("planning: data-changing Act and Admin refused; a turn it causes elsewhere plans too, and an agent without plan mode is refused", async () => {
    await withWorld(async (w) => {
      const orq = w.project("jaspersito/orquester");
      w.host.addChat("planner", { project: orq, title: "Planner", runtimeMode: "full-access" });
      w.host.addChat("sibling", { project: w.project("jaspersito/orquester-3"), title: "Sibling", agent: "claude", runtimeMode: "auto" });
      w.host.addChat("codex", { project: w.project("jaspersito/orquester-3"), title: "Codex", agent: "codex", runtimeMode: "auto" });
      w.host.userTurn("planner", "Plan the migration.", { plan: true });
      const promptsBefore = (await w.savedPrompts.list(orq)).prompts.length;
      assert.match(refused(await w.uncarded("planner", "update_saved_prompts", { action: "create", title: "x", body: "y" }), "PERMISSION_DENIED").message, /planning/);
      assert.equal((await w.savedPrompts.list(orq)).prompts.length, promptsBefore);
      refused(await w.uncarded("planner", "create_workflow", { name: "W", project: { kind: "existing", project: "jaspersito/orquester" }, nodes: [{ type: "trigger.manual", name: "Go" }] }), "PERMISSION_DENIED");
      refused(await w.uncarded("planner", "edit_agent_profile", { agent: "claude", changes: [{ action: "create", skill: { name: "x", frontmatter: { description: "x" }, body: "x" } }] }), "PERMISSION_DENIED");
      // Messages to other chats carry the plan: the sibling's caused turn runs in plan mode.
      ok(await w.uncarded("planner", "send_message", { sessionId: "sibling", text: "Plan your half.", reply: "none" }));
      assert.equal(w.host.postsTo("sibling")[0]!.interactionMode, "plan");
      assert.equal(w.host.runningTurn("sibling")!.interactionMode, "plan");
      // Codex has no plan mode: it cannot be given work from a planning chat.
      refused(await w.uncarded("planner", "send_message", { sessionId: "codex", text: "Edit it.", reply: "none" }), "PERMISSION_DENIED");
      assert.equal(w.host.postsTo("codex").length, 0);
      // implementPlan starts editing work: refused while planning.
      refused(await w.uncarded("planner", "send_message", { sessionId: "sibling", text: "go", implementPlan: true, reply: "none" }), "PERMISSION_DENIED");
    });
  });
});

// ---------------------------------------------------------------------------
// (i) A user MCP server pointing at this daemon is denied inside chats (§12.1, MUST 1)
// ---------------------------------------------------------------------------

describe("acceptance (i) / §14.2.11: a user-installed server reaching this daemon's /mcp (by URL or by bearer) is denied in every provider's chats", () => {
  test("detected in each CLI's user config and a project's config, denied in the chat manifest, and applied by each provider's launch: Claude disallowedTools, Codex enabled=false, Grok shadowed, OpenCode deny rules", async () => {
    await withWorld(async (w) => {
      const orq = w.project("jaspersito/orquester");
      const url = `http://127.0.0.1:${DAEMON_PORT}/mcp`;
      const bearer = `Bearer ${DAEMON_BEARER}`;
      await writeHomeFile(w.homes.claudeJson, JSON.stringify({ mcpServers: {
        claude_by_url: { type: "http", url },
        claude_by_bearer: { type: "http", url: "https://proxy.example/anything", headers: { Authorization: bearer } },
        claude_fine: { command: "fine" }
      } }));
      await writeHomeFile(`${w.homes.codexHome}/config.toml`, [
        "[mcp_servers.codex_by_url]", `url = "http://localhost:${DAEMON_PORT}/mcp"`, "",
        "[mcp_servers.codex_by_bearer]", 'url = "https://proxy.example/x"', "[mcp_servers.codex_by_bearer.http_headers]", `Authorization = "${bearer}"`, "",
        "[mcp_servers.codex_fine]", 'command = "fine"'
      ].join("\n"));
      await writeHomeFile(`${w.homes.grokHome}/config.toml`, [
        "[mcp_servers.grok_by_url]", `url = "${url}"`, "",
        "[mcp_servers.grok_by_bearer]", 'command = "npx"', `args = ["-y", "mcp-remote", "https://proxy.example/mcp", "--header", "Authorization: ${bearer}"]`, "",
        "[mcp_servers.grok_fine]", 'command = "fine"'
      ].join("\n"));
      await writeHomeFile(`${w.homes.opencodeDir}/opencode.json`, JSON.stringify({ mcp: {
        oc_by_url: { type: "remote", url },
        oc_by_bearer: { type: "remote", url: "https://proxy.example/mcp", headers: { Authorization: bearer } },
        oc_fine: { type: "local", command: ["fine"] }
      } }));
      // A project-level config of the chat's own project.
      await writeHomeFile(`${orq}/.mcp.json`, JSON.stringify({ mcpServers: { project_orq: { type: "http", url } } }));

      const chats = { claude: "c-claude", codex: "c-codex", grok: "c-grok", opencode: "c-opencode" } as const;
      for (const [agent, id] of Object.entries(chats)) w.host.addChat(id, { project: orq, agent: agent as "claude", runtimeMode: "full-access" });
      const deny = Object.fromEntries(await Promise.all(Object.entries(chats).map(async ([agent, id]) => {
        const manifest = await manifestOf(w, id);
        assert.doesNotMatch(JSON.stringify(manifest), new RegExp(DAEMON_BEARER), "the manifest never carries the credential");
        return [agent, manifest.deny] as const;
      })));
      assert.deepEqual(deny, {
        claude: ["claude_by_bearer", "claude_by_url", "project_orq"],
        codex: ["codex_by_bearer", "codex_by_url"],
        // Grok also loads the user's Claude servers, in every home (Task 6's probe).
        grok: ["claude_by_bearer", "claude_by_url", "grok_by_bearer", "grok_by_url"],
        opencode: ["oc_by_bearer", "oc_by_url"]
      });

      // Each provider's launch applies the denial (the agent host's own translation of the manifest).
      assert.deepEqual(claudeDisallowedTools(deny.claude!), ["mcp__claude_by_bearer", "mcp__claude_by_url", "mcp__project_orq"]);
      assert.deepEqual(claudeDeniedMcpServers(deny.claude!).map((entry) => entry.serverName).sort(), ["claude_by_bearer", "claude_by_url", "orquester", "project_orq"]);
      assert.deepEqual(codexDenyConfig(deny.codex!), { "mcp_servers.codex_by_bearer.enabled": false, "mcp_servers.codex_by_url.enabled": false });
      const grokServers = grokSessionMcpServers({ url: "http://127.0.0.1:1/session-tools", authorization: "Bearer own", instructions: "", toolNames: new Set(), deny: deny.grok! });
      assert.deepEqual(grokServers.filter((server) => server.name !== "orquester").map((server) => [server.name, (server as { url?: string }).url]), deny.grok!.map((name) => [name, GROK_UNREACHABLE_SHADOW_URL]), "Grok: each denied name is shadowed by an inert endpoint");
      const rules = withSessionToolRules([], { isolate: true, deny: deny.opencode! });
      assert.deepEqual(rules.filter((rule) => rule.action === "deny" && rule.permission.startsWith("oc_")).map((rule) => rule.permission), ["oc_by_bearer_*", "oc_by_url_*"]);
      // Harmless servers are untouched everywhere.
      assert.doesNotMatch(JSON.stringify(deny), /_fine/);

      // The agent-profile panel lists each flagged server ("Disabled inside Orquester chats"), never its credential.
      const panel = await w.user({ method: "GET", url: "/api/agent-profile/daemon-mcp-servers" });
      assert.equal(panel.status, 200);
      assert.doesNotMatch(JSON.stringify(panel.body), new RegExp(DAEMON_BEARER));
      assert.deepEqual([...new Set(panel.body.servers.map((server: { name: string }) => server.name))].sort(), ["claude_by_bearer", "claude_by_url", "codex_by_bearer", "codex_by_url", "grok_by_bearer", "grok_by_url", "oc_by_bearer", "oc_by_url", "project_orq"]);

      // An agent adding one through edit_agent_profile: the Admin card flags it in red; denied, nothing written.
      w.host.userTurn("c-claude", "Add an Orquester MCP server.");
      const add = await w.carded("c-claude", "edit_agent_profile", { agent: "claude", changes: [{ action: "create", mcp: { name: "orq_remote", transport: "http", url } }] }, { decision: "deny" });
      assert.ok(add.card.sections.some((section) => section.kind === "warning" && section.level === "danger" && /full control of Orquester without approvals/.test(section.text)));
      refused(add.result, "APPROVAL_DENIED");
      assert.doesNotMatch(await readFile(w.homes.claudeJson, "utf8"), /orq_remote/);
    });
  });
});

// ---------------------------------------------------------------------------
// External vs chat: who answers a card (§12.1, §7.3, §13)
// ---------------------------------------------------------------------------

describe("§12.1 / §7.3: an Orquester card is answered only by a person, on its card route — never through the MCP, never by an agent or an external client", () => {
  test("respond_to_request cannot reach it, the card route refuses agent and external principals, two answers race to one winner", async () => {
    await withWorld(async (w) => {
      w.host.addChat("auto", { project: w.project("jaspersito/orquester"), title: "Auto", runtimeMode: "auto" });
      w.host.addChat("orq3", { project: w.project("jaspersito/orquester-3"), title: "Sibling", runtimeMode: "auto" });
      w.host.userTurn("auto", "go");
      const pending = w.chat("auto", "create_session", { project: "jaspersito/orquester-3", prompt: "x", reply: "none" });
      const card = await w.cardFor(pending, "create_session");
      // The external MCP: no request by that id (cards are not provider requests).
      const viaMcp = await w.external("respond_to_request", { sessionId: "auto", requestId: card.approvalId, decision: "accept" });
      assert.equal(viaMcp.isError, true);
      // Another chat's agent: no request by that id either.
      assert.equal((await w.uncarded("orq3", "respond_to_request", { sessionId: "auto", requestId: card.approvalId, answers: { "1": "yes" } })).isError, true);
      // The card route itself refuses any principal but the user's.
      const route = agentChatRoutes.toolApproval(card.threadId, card.approvalId);
      for (const principal of [{ kind: "agent", threadId: "orq3", projectPath: w.project("jaspersito/orquester-3"), agent: "claude", title: "Sibling" }, { kind: "external", credentialId: "cred_x" }] as const) {
        assert.equal((await w.internalApi.request("POST", route, { body: { decision: "approve" }, principal })).status, 403);
      }
      // Two people answer: the first wins, the second is told it is no longer pending.
      const [first, second] = await Promise.all([w.answer(card, { decision: "approve" }), w.answer(card, { decision: "deny" })]);
      assert.deepEqual([first.status, second.status].sort(), [200, 409]);
      const result = await pending;
      const winner = first.status === 200 ? "approve" : "deny";
      assert.equal(result.isError === true, winner === "deny");

      // The chat closes while its card waits: the call ends CANCELLED and the card closes; a late answer finds nothing.
      w.host.userTurn("auto", "again");
      const waiting = w.chat("auto", "create_session", { project: "jaspersito/orquester-3", prompt: "y", reply: "none" });
      const orphan = await w.cardFor(waiting, "create_session");
      assert.equal((await w.user({ method: "DELETE", url: "/api/sessions/auto" })).status, 204);
      const cancelled = refused(await waiting, "CANCELLED");
      assert.match(cancelled.message, /closed/);
      assert.equal((await w.answer(orphan, { decision: "approve" })).status, 404);
    });
  });
});

// ---------------------------------------------------------------------------
// Agent Profiles (spec 2026-10-18 §5.5): the MCP tools and workflows over the real profile store
// ---------------------------------------------------------------------------

describe("Agent Profiles §5.5: create_session, the session reads, list_agents and the workflow delete guard", () => {
  test("an external and an in-chat create launch with a profile named by name (unattended), the reads report it, an unknown or unprepared one fails — never Global", async () => {
    await withWorld(async (w) => {
      const orq = w.project("jaspersito/orquester");
      const made = await w.user({ method: "POST", url: sessionProfileRoutes.list, payload: { name: "Reviewer", description: "Code review kit" } });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      const profileId: string = made.body.id;

      const listed = ok(await w.external("list_agents", {}));
      assert.deepEqual(listed.profiles.map((p: { id: string; name: string; description: string }) => [p.id, p.name, p.description]), [[profileId, "Reviewer", "Code review kit"]]);

      const created = ok(await w.external("create_session", { project: "jaspersito/orquester", agent: "claude", profile: "reviewer" }));
      assert.deepEqual(created.profile, { id: profileId, name: "Reviewer" });
      const tab = w.host.tabs.get(created.sessionId)! as { profileId?: string | null; unattended?: boolean };
      assert.equal(tab.profileId, profileId);
      assert.equal(tab.unattended, true, "a tool's launch is unattended");
      assert.deepEqual(ok(await w.external("get_session", { sessionId: created.sessionId })).session.chat.profile, { id: profileId, name: "Reviewer" });
      const rows = ok(await w.external("list_sessions", { project: "jaspersito/orquester" })).sessions;
      assert.deepEqual(rows.find((row: { id: string }) => row.id === created.sessionId).chat.profile, { id: profileId, name: "Reviewer" });

      w.host.addChat("lead", { project: orq, title: "Lead", runtimeMode: "full-access" });
      w.host.userTurn("lead", "Open a reviewer chat.");
      const opened = ok(await w.uncarded("lead", "create_session", { prompt: "Review the diff.", reply: "none", profile: profileId }));
      assert.deepEqual(opened.profile, { id: profileId, name: "Reviewer" });
      assert.equal((w.host.tabs.get(opened.sessionId)! as { profileId?: string }).profileId, profileId);

      const before = w.host.tabs.size;
      refused(await w.external("create_session", { project: "jaspersito/orquester", agent: "claude", profile: "Nobody" }), "PROFILE_NOT_FOUND");
      w.host.profiles!.notReady.set(profileId, "The MCP server \"pager\" has no command.");
      const notReady = refused(await w.external("create_session", { project: "jaspersito/orquester", agent: "claude", profile: "Reviewer" }), "PROFILE_NOT_READY");
      assert.match(notReady.message, /Agent Profile "Reviewer" could not be used, so no chat was opened: The MCP server "pager" has no command\./);
      assert.equal(w.host.tabs.size, before, "nothing was opened, as Global or otherwise");
    });
  });

  test("a workflow agent block names a profile; validation flags a missing one; deleting a used profile is refused until the user confirms the workflows that use it", async () => {
    await withWorld(async (w) => {
      const orq = w.project("jaspersito/orquester");
      const profile = (await w.user({ method: "POST", url: sessionProfileRoutes.list, payload: { name: "Nightly" } })).body as { id: string; revision: string };
      const chain = [{ agent: "claude", model: "default" }];
      const workflow = await w.user({
        method: "POST", url: "/api/workflows",
        payload: {
          name: "Nightly fix", project: { kind: "existing", projectPath: orq },
          nodes: [{ type: "trigger.manual", name: "Go" }, { type: "agent", name: "Fix", config: { prompt: { kind: "text", text: "Fix it." }, chain, profileId: profile.id } }],
          edges: [{ source: "Go", target: "Fix" }]
        }
      });
      assert.ok(workflow.status < 300, JSON.stringify(workflow.body));
      const workflowId: string = workflow.body.workflow?.id ?? workflow.body.id;
      assert.equal(w.workflows.service.require(workflowId).nodes.find((node) => node.type === "agent")!.config.profileId, profile.id, "stored by id");

      const missing = await w.user({
        method: "POST", url: workflowRoutes.validate,
        payload: { workflow: { name: "Other", project: { kind: "existing", projectPath: orq }, nodes: [{ id: "t", type: "trigger.manual", name: "Go", position: { x: 0, y: 0 }, config: {} }, { id: "a", type: "agent", name: "Fix", position: { x: 0, y: 0 }, config: { prompt: { kind: "text", text: "x" }, chain, profileId: "prof-gone" } }], edges: [] } }
      });
      assert.deepEqual(missing.body.problems.filter((p: { code: string }) => p.code === "unknown_profile").map((p: { nodeId: string; severity: string }) => [p.nodeId, p.severity]), [["a", "warning"]]);

      const uses = await w.user({ method: "GET", url: workflowRoutes.profileReferences(profile.id) });
      assert.deepEqual(uses.body.workflows.map((use: { workflowId: string; name: string }) => [use.workflowId, use.name]), [[workflowId, "Nightly fix"]]);
      const url = (expect: string) => `${sessionProfileRoutes.profile(profile.id)}?revision=${profile.revision}&expectWorkflowUses=${expect}`;
      const stale = await w.user({ method: "DELETE", url: url("") });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error.code, "WORKFLOW_USES_CHANGED");
      assert.match(stale.body.error.message, /"Nightly fix"/);
      assert.equal((await w.user({ method: "GET", url: sessionProfileRoutes.profile(profile.id) })).status, 200, "nothing deleted");
      assert.equal((await w.user({ method: "DELETE", url: url(workflowId) })).status, 200);
      assert.equal((await w.user({ method: "GET", url: sessionProfileRoutes.profile(profile.id) })).status, 404);
      // Now the block names a profile that is gone: its own validation says so.
      const after = await w.user({ method: "POST", url: workflowRoutes.validate, payload: { workflow: w.workflows.service.require(workflowId) } });
      assert.ok(after.body.problems.some((p: { code: string }) => p.code === "unknown_profile"));
    });
  });
});
