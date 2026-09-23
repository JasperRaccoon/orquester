import test from "node:test";
import assert from "node:assert/strict";

import type { AgentConversationSummary } from "@orquester/api";

import { DEFAULT_THREAD_TITLE } from "./agent-chat/title.logic.ts";
import {
  canOpenChat,
  chatAdapterFor,
  chatLaunchRefId,
  isAgentLikeSession,
  isChatResumableConversation,
  isChatSession,
  isDefaultThreadTitle,
  isLegacyAgentTerminal,
  isPtySession,
  launchKindForAgent
} from "./session-kind.ts";

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

test("every catalog agent with an adapter can open a chat tab; deepseek cannot", () => {
  for (const id of ["claude", "codex", "opencode", "grok"]) {
    assert.equal(chatAdapterFor(id), id, `${id} maps to its own adapter`);
    assert.equal(launchKindForAgent(id), "agent-chat");
  }
  // The proxy launchers are Claude with launcher env on top (§5.3).
  assert.equal(chatAdapterFor("claudex"), "claude");
  assert.equal(chatAdapterFor("claudemix"), "claude");

  assert.equal(chatAdapterFor("deepseek"), null);
  assert.equal(canOpenChat("deepseek"), false);
  assert.equal(launchKindForAgent("deepseek"), null);
});

test("the five dropped agents are gone from the catalog entirely", () => {
  for (const id of ["gemini", "kimi", "agy", "cline", "deepcode"]) {
    assert.equal(chatAdapterFor(id), null, `${id} must not be launchable`);
    assert.equal(canOpenChat(id), false);
  }
});

const conversation = (over: Partial<AgentConversationSummary>): AgentConversationSummary => ({
  id: "c1",
  agentRefId: "claude",
  title: "t",
  updatedAt: "2026-09-21T00:00:00.000Z",
  ...over
});

test("a cliproxy conversation launches under its proxy launcher, not plain claude", () => {
  const row = conversation({ home: "cliproxy", proxyRefId: "claudex" });
  assert.equal(chatLaunchRefId(row), "claudex");
  // Resumable in chat for the first time (§5.3): the adapter resumes under the
  // same HOME rather than through the launcher's resumeArgs.
  assert.equal(isChatResumableConversation(row), true);
});

test("a cliproxy row with no proxyRefId is not resumable: no launcher owns its home", () => {
  const row = conversation({ home: "cliproxy" });
  // The launch id still falls back to the agent the row names...
  assert.equal(chatLaunchRefId(row), "claude");
  // ...but plain `claude` looks in the daemon's own HOME, where this
  // transcript is not, so the row is never offered (the MCP refuses it too).
  assert.equal(isChatResumableConversation(row), false);
});

// The two GUI launch paths ask the same predicate, each behind its own filter.
// Both are replayed here over one project's rows: a proxied row, the same row
// with its launcher unknown, and a plain system-home row.
const PROXIED = conversation({ id: "c-proxied", home: "cliproxy", proxyRefId: "claudex" });
const ORPHANED = conversation({ id: "c-orphaned", home: "cliproxy" });
const SYSTEM = conversation({ id: "c-system", home: "system" });
const ROWS = [PROXIED, ORPHANED, SYSTEM];

test("ProjectOverview offers a proxied row under its launcher, never an orphaned one", () => {
  // `ProjectOverview.tsx` (both of its lists): the launcher entry is installed
  // AND the predicate holds.
  const installed = new Set(["claude", "claudex"]);
  const offered = ROWS.filter(
    (c) => installed.has(chatLaunchRefId(c)) && isChatResumableConversation(c)
  ).map((c) => c.id);
  assert.deepEqual(offered, ["c-proxied", "c-system"]);
});

test("NewTabMenu lists a proxied row under its launcher, and no agent lists an orphaned one", () => {
  // `NewTabMenu.tsx`: an agent's submenu lists the rows it launches AND the
  // predicate holds. Without the predicate the orphan landed under "claude".
  const listed = (agentId: string) =>
    ROWS.filter((c) => chatLaunchRefId(c) === agentId && isChatResumableConversation(c)).map((c) => c.id);
  assert.deepEqual(listed("claudex"), ["c-proxied"]);
  assert.deepEqual(listed("claude"), ["c-system"]);
});

test("a conversation whose agent has no adapter is not offered", () => {
  assert.equal(isChatResumableConversation(conversation({ agentRefId: "deepseek" })), false);
  assert.equal(isChatResumableConversation(conversation({ agentRefId: "gemini" })), false);
});

test("only a title nobody chose may be overwritten by the seed", () => {
  assert.equal(isDefaultThreadTitle(DEFAULT_THREAD_TITLE, "claude"), true);
  assert.equal(isDefaultThreadTitle("Claude Code", "claude"), true);
  assert.equal(isDefaultThreadTitle("claude", "claude"), true);
  // A manual rename — and a seed already written — are both off limits.
  assert.equal(isDefaultThreadTitle("fix the login bug", "claude"), false);
  assert.equal(isDefaultThreadTitle("Codex", "claude"), false);
});
