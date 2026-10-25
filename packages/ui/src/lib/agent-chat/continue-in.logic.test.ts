import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RegistryEntry } from "@orquester/api";
import type { ThreadItem, Turn } from "@orquester/api/agent-chat";

import {
  continueAgentOptions,
  continueHandoffBudget,
  continueHandoffPreview,
  continueMode,
  continueRequestFields,
  sourceAccountChip,
  type ContinueSource
} from "./continue-in.logic";
import { ForkRetryKeys } from "./lineage.logic";

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
    assert.equal(throughTwo.carried, 3, "the 30 KB reply no longer fits beside the 40 KB original request");
    assert.equal(throughTwo.firstRequest, true);
    assert.ok(throughTwo.bytes > 40_000 && throughTwo.bytes < 64 * 1024);
    const beforeThree = continueHandoffPreview(state, { messageId: "u3" })!;
    assert.equal(beforeThree.total, 4, "a prompt forks just before itself");
    assert.equal(continueHandoffPreview(state, {})!.total, 6, "the whole thread through its latest finished turn");
    assert.equal(continueHandoffPreview(state, { messageId: "gone" }), null, "a point the window cannot place");
  });

  it("sizes the count for the picked model's context window", () => {
    const items = [
      msg("u1", "user", "x".repeat(20_000), null),
      msg("a1", "assistant", "y".repeat(20_000), "t1"),
      msg("u2", "user", "second", null),
      msg("a2", "assistant", "answer two", "t2"),
      { kind: "activity", id: "cw", activityKind: "context-window.updated", tone: "info", summary: "", payload: { usedTokens: 1, maxTokens: 40_000 }, turnId: "t2", createdAt: "t" } as unknown as ThreadItem
    ];
    const state = { turns: [turn("t1", "u1"), turn("t2", "u2")], items };
    const opus = { model: "opus" };
    const catalog = [{ slug: "local/small", name: "Small", capabilities: null, contextWindow: 32_000 }];
    // Unknown window: the fallback, capped at 64 KB — everything fits.
    const wide = continueHandoffBudget(state, opus, { sameAgent: false, modelSelection: { model: "gpt-5" }, catalog: [] });
    assert.equal(wide, 64 * 1024);
    assert.equal(continueHandoffPreview(state, {}, wide)!.carried, 4);
    // A 32k catalogue window: 16k reserved, less the handoff's own words and git section.
    const small = continueHandoffBudget(state, opus, { sameAgent: false, modelSelection: { model: "local/small" }, catalog });
    assert.equal(small, 16_000 - 2 * 1024 - 8 * 1024);
    const preview = continueHandoffPreview(state, {}, small)!;
    assert.ok(preview.carried < 4 && preview.bytes <= small);
    // The same agent and model under another account: the source's own reading.
    assert.equal(continueHandoffBudget(state, opus, { sameAgent: true, modelSelection: opus, catalog: [] }), 40_000 - 16_000 - 10 * 1024);
  });

  it("keeps continuation retries apart from plain forks and other target models", () => {
    const plain = ForkRetryKeys.keyFor("p", { messageId: "m" });
    assert.notEqual(ForkRetryKeys.keyFor("p", { messageId: "m", refId: "codex", modelSelection: { model: "gpt-5" } }), plain);
    assert.notEqual(
      ForkRetryKeys.keyFor("p", { messageId: "m", refId: "codex", modelSelection: { model: "gpt-5" } }),
      ForkRetryKeys.keyFor("p", { messageId: "m", refId: "codex", modelSelection: { model: "gpt-5-codex" } })
    );
  });
});
