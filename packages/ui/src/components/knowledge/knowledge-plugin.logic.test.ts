import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentAccount, KnowledgeRunSummary, KnowledgeWorkerView } from "@orquester/api";

import {
  KNOWLEDGE_AUTOMATIC_ACCOUNT_LABEL,
  knowledgeAccountOptions,
  knowledgeRunLine,
  knowledgeSettingsPatch,
  knowledgeSettingsProblem,
  knowledgeWorkersShown,
  knowledgeWorkerText,
  readKnowledgeSettings
} from "./knowledge-plugin.logic";

const SAVED = { accountId: null, model: null, concurrency: 4 };

describe("knowledge settings form", () => {
  it("reads the daemon's settings field by field, defaulting bad fields", () => {
    assert.deepEqual(readKnowledgeSettings({ accountId: "acc1", model: "opus", concurrency: 2, extra: true }), {
      accountId: "acc1",
      model: "opus",
      concurrency: 2
    });
    assert.deepEqual(readKnowledgeSettings({ accountId: 3, model: "", concurrency: 99 }), SAVED);
    assert.deepEqual(readKnowledgeSettings(null), SAVED);
    assert.deepEqual(readKnowledgeSettings({ concurrency: 1.5 }), SAVED);
  });

  it("refuses concurrency outside 1..8 or not whole", () => {
    for (const concurrency of ["", "0", "9", "2.5", "abc", "-1"]) {
      assert.match(knowledgeSettingsProblem({ accountId: null, model: "", concurrency }) ?? "", /whole number from 1 to 8/, concurrency);
    }
    for (const concurrency of ["1", "8", " 3 "]) {
      assert.equal(knowledgeSettingsProblem({ accountId: null, model: "", concurrency }), null, concurrency);
    }
    assert.match(knowledgeSettingsProblem({ accountId: null, model: "x".repeat(201), concurrency: "4" }) ?? "", /at most 200/);
  });

  it("sends only what changed; an empty model is null (the default)", () => {
    assert.deepEqual(knowledgeSettingsPatch(SAVED, { accountId: null, model: "  ", concurrency: "4" }), { patch: {} });
    assert.deepEqual(knowledgeSettingsPatch(SAVED, { accountId: "acc1", model: " opus ", concurrency: "6" }), {
      patch: { accountId: "acc1", model: "opus", concurrency: 6 }
    });
    assert.deepEqual(
      knowledgeSettingsPatch({ accountId: "acc1", model: "opus", concurrency: 6 }, { accountId: null, model: "", concurrency: "6" }),
      { patch: { accountId: null, model: null } }
    );
    assert.ok("error" in knowledgeSettingsPatch(SAVED, { accountId: null, model: "", concurrency: "12" }));
  });
});

describe("knowledge indexing account options", () => {
  const account = (overrides: Partial<AgentAccount>): AgentAccount => ({
    id: "a",
    agent: "claude",
    label: "me@example.com",
    email: null,
    plan: null,
    needsReauth: false,
    createdAt: "",
    importedAt: "",
    ...overrides
  });

  it("lists automatic, then Claude accounts only", () => {
    const options = knowledgeAccountOptions(
      [account({ id: "c1" }), account({ id: "x1", agent: "codex", label: "codex" }), account({ id: "c2", label: "Work", needsReauth: true })],
      null
    );
    assert.deepEqual(options, [
      { value: "", label: KNOWLEDGE_AUTOMATIC_ACCOUNT_LABEL },
      { value: "c1", label: "me" },
      { value: "c2", label: "Work (needs sign-in)" }
    ]);
  });

  it("keeps a chosen account the list lacks as its own option", () => {
    assert.deepEqual(knowledgeAccountOptions([account({ id: "c1" })], "gone").at(-1), { value: "gone", label: "Unknown account (gone)" });
    // The list not read yet: just the id, not "unknown".
    assert.deepEqual(knowledgeAccountOptions(undefined, "c9").at(-1), { value: "c9", label: "c9" });
  });
});

describe("knowledge activity text", () => {
  const run = (overrides: Partial<KnowledgeRunSummary> = {}): KnowledgeRunSummary => ({
    id: "r1",
    mode: "update",
    startedAt: "2026-10-24T10:00:00.000Z",
    finishedAt: "2026-10-24T10:04:12.000Z",
    durationMs: 252_000,
    entries: 3,
    tasks: 48,
    tokensIn: 1_234_567,
    tokensOut: 34_000,
    outcome: "ok",
    error: null,
    ...overrides
  });

  it("describes the last run: when, how long, tasks and tokens", () => {
    assert.deepEqual(knowledgeRunLine(run(), () => "2h ago"), {
      title: "Update · finished",
      when: "2h ago",
      took: "4m",
      detail: "3 entries · 48 tasks · 1.2M in · 34k out",
      failed: false
    });
    const live = knowledgeRunLine(run({ outcome: "running", finishedAt: null, durationMs: null, tasks: 1, entries: 1, tokensIn: 0, tokensOut: 0 }), () => "just now");
    assert.equal(live.title, "Update · running");
    assert.equal(live.took, "");
    assert.equal(live.detail, "1 entry · 1 task · no tokens");
    // No duration from the daemon: from the start and finish times.
    assert.equal(knowledgeRunLine(run({ durationMs: null, outcome: "failed", mode: "rebuild" }), () => "").took, "4m");
    assert.equal(knowledgeRunLine(run({ outcome: "failed", mode: "rebuild" }), () => "").title, "Rebuild · failed");
    assert.equal(knowledgeRunLine(run({ outcome: "failed" }), () => "").failed, true);
  });

  it("lists running workers first, then the newest, at most five", () => {
    const worker = (sessionId: string, state: KnowledgeWorkerView["state"], startedAt: string): KnowledgeWorkerView => ({
      sessionId,
      accountId: "c1",
      runId: "r1",
      state,
      tasks: 2,
      startedAt,
      finishedAt: null
    });
    const shown = knowledgeWorkersShown([
      worker("old", "done", "2026-10-24T08:00:00Z"),
      worker("new", "done", "2026-10-24T09:00:00Z"),
      worker("live", "running", "2026-10-24T07:00:00Z"),
      worker("w4", "failed", "2026-10-24T06:00:00Z"),
      worker("w5", "done", "2026-10-24T05:00:00Z"),
      worker("w6", "done", "2026-10-24T04:00:00Z")
    ]).map((w) => w.sessionId);
    assert.deepEqual(shown, ["live", "new", "old", "w4", "w5"]);
    assert.equal(knowledgeWorkerText({ state: "running", tasks: 1 }), "Running · 1 task");
    assert.equal(knowledgeWorkerText({ state: "failed", tasks: 3 }), "Failed · 3 tasks");
  });
});
