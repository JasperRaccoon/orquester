import test from "node:test";
import assert from "node:assert/strict";

import type { AgentConversationSummary } from "@orquester/api";

import { isAgentLikeSession, isChatResumableConversation, isChatSession, isDefaultThreadTitle, isLegacyAgentTerminal, isPtySession, isResumableByAgent, isResumableByInstalledAgent } from "./session-kind.ts";

test("the three session kinds are classified without overlap", () => {
  const shell = { kind: "shell" } as const;
  const legacy = { kind: "agent" } as const;
  const chat = { kind: "agent-chat" } as const;

  assert.deepEqual(
    [shell, legacy, chat].map(isChatSession),
    [false, false, true]
  );
  assert.deepEqual(
    [shell, legacy, chat].map(isLegacyAgentTerminal),
    [false, true, false]
  );
  assert.deepEqual(
    [shell, legacy, chat].map(isAgentLikeSession),
    [false, true, true]
  );
  assert.deepEqual(
    [shell, legacy, chat].map(isPtySession),
    [true, true, false]
  );
});

const conversation = (over: Partial<AgentConversationSummary>): AgentConversationSummary => ({
  id: "c1",
  agentRefId: "claude",
  title: "t",
  updatedAt: "2026-09-21T00:00:00.000Z",
  ...over
});

// The two GUI launch paths ask the same predicate, each through its own
// exported filter, which is what the components call. Both run here over one
// project's rows: a proxied row, the same row with its launcher unknown, and a
// plain system-home row.
const PROXIED = conversation({ id: "c-proxied", home: "cliproxy", proxyRefId: "claudex" });
const ORPHANED = conversation({ id: "c-orphaned", home: "cliproxy" });
const SYSTEM = conversation({ id: "c-system", home: "system" });
const ROWS = [PROXIED, ORPHANED, SYSTEM];

test("ProjectOverview offers a proxied row under its launcher, never an orphaned one", () => {
  // `ProjectOverview.tsx` (both of its lists): the launcher entry is installed
  // AND the predicate holds.
  const offered = (agentsById: ReadonlyMap<string, { enabled: boolean }>) =>
    ROWS.filter((c) => isResumableByInstalledAgent(c, agentsById)).map((c) => c.id);
  assert.deepEqual(
    offered(new Map([["claude", { enabled: true }], ["claudex", { enabled: true }]])),
    ["c-proxied", "c-system"]
  );
  // A launcher that is not installed, or not in the registry at all, offers
  // none of its rows.
  assert.deepEqual(
    offered(new Map([["claude", { enabled: true }], ["claudex", { enabled: false }]])),
    ["c-system"]
  );
  assert.deepEqual(offered(new Map([["claudex", { enabled: true }]])), ["c-proxied"]);
});

test("NewTabMenu lists a proxied row under its launcher, and no agent lists an orphaned one", () => {
  // `NewTabMenu.tsx`: an agent's submenu lists the rows it launches AND the
  // predicate holds. Without the predicate the orphan landed under "claude".
  const listed = (agentId: string) => ROWS.filter((c) => isResumableByAgent(c, agentId)).map((c) => c.id);
  assert.deepEqual(listed("claudex"), ["c-proxied"]);
  assert.deepEqual(listed("claude"), ["c-system"]);
});

test("a conversation whose agent has no adapter is not offered", () => {
  assert.equal(isChatResumableConversation(conversation({ agentRefId: "deepseek" })), false);
  assert.equal(isChatResumableConversation(conversation({ agentRefId: "gemini" })), false);
});

test("only a title nobody chose may be overwritten by the seed", () => {
  assert.equal(isDefaultThreadTitle("New thread", "claude"), true);
  assert.equal(isDefaultThreadTitle("Claude Code", "claude"), true);
  assert.equal(isDefaultThreadTitle("claude", "claude"), true);
  // A manual rename — and a seed already written — are both off limits.
  assert.equal(isDefaultThreadTitle("fix the login bug", "claude"), false);
  assert.equal(isDefaultThreadTitle("Codex", "claude"), false);
});
