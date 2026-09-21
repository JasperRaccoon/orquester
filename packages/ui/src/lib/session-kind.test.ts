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

test("a cliproxy row with no proxyRefId falls back to the agent it names", () => {
  const row = conversation({ home: "cliproxy" });
  assert.equal(chatLaunchRefId(row), "claude");
  assert.equal(isChatResumableConversation(row), true);
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
