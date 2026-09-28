import test from "node:test";
import assert from "node:assert/strict";

import type { AgentConversationSummary } from "@orquester/api";

import { DEFAULT_THREAD_TITLE } from "./agent-chat/title.logic.ts";
import {
  canOpenChat,
  chatAdapterFor,
  isAgentLikeSession,
  isChatResumableConversation,
  isChatSession,
  isDefaultThreadTitle,
  isLegacyAgentTerminal,
  isPtySession,
  isResumableByAgent,
  isResumableByInstalledAgent,
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

// The two GUI launch paths ask the same predicate, each through its own
// exported filter, which is what the components call. Both run here over one
// project's rows.
const CLAUDE = conversation({ id: "c-claude", home: "system" });
const CODEX = conversation({ id: "c-codex", agentRefId: "codex", home: "account", accountId: "a1" });
const ROWS = [CLAUDE, CODEX];

test("ProjectOverview offers a row only while its agent is installed", () => {
  // `ProjectOverview.tsx` (both of its lists): the agent's entry is installed
  // AND the predicate holds.
  const offered = (agentsById: ReadonlyMap<string, { enabled: boolean }>) =>
    ROWS.filter((c) => isResumableByInstalledAgent(c, agentsById)).map((c) => c.id);
  assert.deepEqual(
    offered(new Map([["claude", { enabled: true }], ["codex", { enabled: true }]])),
    ["c-claude", "c-codex"]
  );
  // An agent that is not installed, or not in the registry at all, offers
  // none of its rows.
  assert.deepEqual(
    offered(new Map([["claude", { enabled: true }], ["codex", { enabled: false }]])),
    ["c-claude"]
  );
  assert.deepEqual(offered(new Map([["codex", { enabled: true }]])), ["c-codex"]);
});

test("NewTabMenu lists a row under the agent that wrote it", () => {
  const listed = (agentId: string) => ROWS.filter((c) => isResumableByAgent(c, agentId)).map((c) => c.id);
  assert.deepEqual(listed("claude"), ["c-claude"]);
  assert.deepEqual(listed("codex"), ["c-codex"]);
  assert.deepEqual(listed("grok"), []);
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
