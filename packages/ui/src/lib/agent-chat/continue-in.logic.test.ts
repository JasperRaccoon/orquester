import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RegistryEntry } from "@orquester/api";
import type { ThreadItem, Turn } from "@orquester/api/agent-chat";

import {
  continueActionLabel,
  continueAgentOptions,
  continueHandoffPreview,
  continueMode,
  continueRequestFields,
  continueSummaryText,
  sourceAccountChip,
  type ContinueSource
} from "./continue-in.logic";
import { ForkRetryKeys, lineageVerb } from "./lineage.logic";

const entry = (id: string, adapter: string | null, extra: Partial<RegistryEntry> = {}): RegistryEntry =>
  ({ id, name: id.toUpperCase(), kind: "agent", bin: [id], resolvedBin: `/usr/bin/${id}`, enabled: true, installState: "idle", ...(adapter ? { chat: { adapter } } : {}), ...extra }) as RegistryEntry;

const msg = (id: string, role: "user" | "assistant", text: string, turnId: string | null): ThreadItem =>
  ({ kind: "message", id, role, text, turnId, streaming: false, createdAt: "t", updatedAt: "t" }) as ThreadItem;

const turn = (turnId: string, userMessageId: string, state: Turn["state"] = "completed"): Turn => ({
  turnId,
  state,
  turnCount: null,
  requestedAt: "t",
  startedAt: "t",
  completedAt: "t",
  assistantMessageId: null,
  userMessageId
});

const source: ContinueSource = {
  refId: "claude",
  adapter: "claude",
  accountId: "acc-1",
  modelSelection: { model: "opus", options: [{ id: "effort", value: "high" }] }
};

describe("the continue-in picker", () => {
  it("offers installed chat agents, the source's own first", () => {
    const options = continueAgentOptions(
      [entry("codex", "codex"), entry("claude", "claude"), entry("aider", null), entry("grok", "grok", { enabled: false }), entry("opencode", "opencode", { resolvedBin: undefined })],
      "claude"
    );
    assert.deepEqual(options.map((option) => [option.refId, option.same]), [["claude", true], ["codex", false]]);
  });

  it("the plain same-agent fork sends today's request; a model alone stays native", () => {
    const same = { refId: "claude", modelSelection: source.modelSelection, accountId: "acc-1" };
    assert.equal(continueMode(source, same, "claude"), "native");
    assert.deepEqual(continueRequestFields(source, same), {});
    const reordered = { ...same, modelSelection: { model: "opus", options: [{ id: "effort", value: "high" }] } };
    assert.deepEqual(continueRequestFields(source, reordered), {}, "an equal selection is no change");
    const otherModel = { ...same, modelSelection: { model: "sonnet" } };
    assert.equal(continueMode(source, otherModel, "claude"), "native");
    assert.deepEqual(continueRequestFields(source, otherModel), { modelSelection: { model: "sonnet" } });
  });

  it("another account or agent is a handoff, carrying agent, account and model", () => {
    const account = { refId: "claude", modelSelection: source.modelSelection, accountId: "acc-2" };
    assert.equal(continueMode(source, account, "claude"), "handoff");
    assert.deepEqual(continueRequestFields(source, account), { accountId: "acc-2" });
    const codex = { refId: "codex", modelSelection: { model: "gpt-5" }, accountId: "system" };
    assert.equal(continueMode(source, codex, "codex"), "handoff");
    assert.deepEqual(continueRequestFields(source, codex), { refId: "codex", accountId: "system", modelSelection: { model: "gpt-5" } });
    assert.equal(sourceAccountChip({ accountId: "" }), "system");
  });

  it("grok forking itself is its own transcript fork", () => {
    const grokSource = { ...source, refId: "grok", adapter: "grok", accountId: "" };
    assert.equal(continueMode(grokSource, { refId: "grok", modelSelection: null, accountId: "system" }, "grok"), "same-agent-transcript");
  });

  it("counts what the handoff carries up to the fork point", () => {
    const state = {
      turns: [turn("t1", "u1"), turn("t2", "u2"), turn("t3", "u3")],
      items: [
        msg("u1", "user", "a".repeat(40_000), null),
        msg("a1", "assistant", "b".repeat(30_000), "t1"),
        msg("u2", "user", "second", null),
        msg("a2", "assistant", "answer two", "t2"),
        msg("u3", "user", "third", null),
        msg("a3", "assistant", "answer three", "t3")
      ]
    };
    const throughTwo = continueHandoffPreview(state, { messageId: "a2" })!;
    assert.equal(throughTwo.total, 4, "only history up to the reply's turn");
    assert.equal(throughTwo.carried, 3, "the 40 KB prompt no longer fits beside the rest");
    assert.ok(throughTwo.bytes > 30_000 && throughTwo.bytes < 64 * 1024);
    const beforeThree = continueHandoffPreview(state, { messageId: "u3" })!;
    assert.equal(beforeThree.total, 4, "a prompt forks just before itself");
    assert.equal(continueHandoffPreview(state, {})!.total, 6, "the whole thread through its latest finished turn");
    assert.equal(continueHandoffPreview(state, { messageId: "gone" }), null, "a point the window cannot place");
  });

  it("says what will be carried over, and what the button does", () => {
    assert.equal(
      continueSummaryText({ mode: "handoff", targetName: "Codex", preview: { carried: 23, total: 41, bytes: 58 * 1024 }, moreOlder: false }),
      "Carries the last 23 of 41 messages (≈58 KB); earlier history stays readable. Codex reads it with your first message."
    );
    assert.match(
      continueSummaryText({ mode: "handoff", targetName: "Codex", preview: { carried: 23, total: 41, bytes: 58 * 1024 }, moreOlder: true }),
      /of 41\+ messages/
    );
    assert.match(continueSummaryText({ mode: "handoff", targetName: "Codex", preview: null, moreOlder: false }), /newest whole messages \(up to ≈64 KB\)/);
    assert.match(continueSummaryText({ mode: "native", targetName: "Claude Code", preview: null, moreOlder: false }), /^Native fork: Claude Code keeps the whole conversation/);
    assert.match(continueSummaryText({ mode: "same-agent-transcript", targetName: "Grok", preview: null, moreOlder: false }), /Grok has no native fork/);
    assert.equal(continueActionLabel("handoff", "Codex"), "Continue in Codex");
    assert.equal(continueActionLabel("native", "Claude Code"), "Fork");
  });

  it("names a continuation in the lineage bar, and keys its retries apart from a plain fork's", () => {
    assert.equal(lineageVerb({ relation: "fork", sourceAgent: "claude" }), "Continued from");
    assert.equal(lineageVerb({ relation: "fork" }), "Forked from");
    const plain = ForkRetryKeys.keyFor("p", { messageId: "m" });
    assert.equal(plain, JSON.stringify(["p", "m", null, null]), "a plain fork's key is unchanged");
    assert.notEqual(ForkRetryKeys.keyFor("p", { messageId: "m", refId: "codex", modelSelection: { model: "gpt-5" } }), plain);
    assert.notEqual(
      ForkRetryKeys.keyFor("p", { messageId: "m", refId: "codex", modelSelection: { model: "gpt-5" } }),
      ForkRetryKeys.keyFor("p", { messageId: "m", refId: "codex", modelSelection: { model: "gpt-5-codex" } })
    );
  });
});
