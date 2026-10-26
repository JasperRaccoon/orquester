import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  KNOWLEDGE_DEFAULT_ACCOUNT_POLICY,
  type AccountPolicy,
  type AgentAccount,
  type KnowledgeRunSummary,
  type KnowledgeSettings,
  type KnowledgeWorkerView
} from "@orquester/api";

import type { KnowledgeSettingsAnswer } from "../../lib/knowledge/validate";
import {
  KNOWLEDGE_AUTOMATIC_ACCOUNT_LABEL,
  knowledgeAccountOptions,
  knowledgeRunLine,
  knowledgeSettingsForm,
  knowledgeSettingsPatch,
  knowledgeSettingsProblem,
  knowledgeWorkersShown,
  knowledgeWorkerText,
  readKnowledgeSettings,
  sameAccountPolicy
} from "./knowledge-plugin.logic";

const AUTO = KNOWLEDGE_DEFAULT_ACCOUNT_POLICY;
const SAVED: KnowledgeSettings = { accountPolicy: AUTO, accountId: null, model: null, concurrency: 4 };
const fixed = (accounts: string[], extra: Partial<AccountPolicy> = {}): AccountPolicy => ({ ...AUTO, strategy: "fixed", accounts, ...extra });

describe("knowledge settings form", () => {
  it("reads the daemon's settings field by field, defaulting bad fields", () => {
    const policy = fixed(["acc1", "acc2"], { maxWeeklyPct: 80 });
    assert.deepEqual(readKnowledgeSettings({ accountPolicy: policy, accountId: "acc1", model: "opus", concurrency: 2, extra: true }), {
      accountPolicy: policy,
      accountId: "acc1",
      model: "opus",
      concurrency: 2
    });
    assert.deepEqual(readKnowledgeSettings({ accountPolicy: {}, accountId: 3, model: "", concurrency: 99 }), SAVED);
    assert.deepEqual(readKnowledgeSettings(null), SAVED);
    assert.deepEqual(readKnowledgeSettings({ accountPolicy: AUTO, concurrency: 1.5 }), SAVED);
    // A policy's bad fields read as their defaults.
    assert.deepEqual(readKnowledgeSettings({ accountPolicy: { strategy: "x", maxSessionPct: 50 } }).accountPolicy, { ...AUTO, maxSessionPct: 50 });
    // A daemon that predates policies answers none: no policy is made up for it.
    assert.deepEqual(readKnowledgeSettings({ accountId: "acc1", model: null, concurrency: 4 }), { ...SAVED, accountPolicy: null, accountId: "acc1" });
    assert.deepEqual(readKnowledgeSettings({ concurrency: 4 }), { ...SAVED, accountPolicy: null });
  });

  it("refuses concurrency outside 1..8 or not whole", () => {
    const form = (concurrency: string, model = "") => ({ accountPolicy: AUTO, accountId: null, model, concurrency });
    for (const concurrency of ["", "0", "9", "2.5", "abc", "-1"]) {
      assert.match(knowledgeSettingsProblem(form(concurrency)) ?? "", /whole number from 1 to 8/, concurrency);
    }
    for (const concurrency of ["1", "8", " 3 "]) {
      assert.equal(knowledgeSettingsProblem(form(concurrency)), null, concurrency);
    }
    assert.match(knowledgeSettingsProblem(form("4", "x".repeat(201))) ?? "", /at most 200/);
  });

  it("sends only what changed; an empty model is null (the default); a policy goes with its legacy accountId", () => {
    assert.deepEqual(knowledgeSettingsPatch(SAVED, { accountPolicy: AUTO, accountId: null, model: "  ", concurrency: "4" }), { patch: {} });
    assert.deepEqual(knowledgeSettingsPatch(SAVED, { accountPolicy: fixed(["acc1", "acc2"]), accountId: null, model: " opus ", concurrency: "6" }), {
      patch: { accountPolicy: fixed(["acc1", "acc2"]), accountId: "acc1", model: "opus", concurrency: 6 }
    });
    const saved: KnowledgeSettings = { accountPolicy: fixed(["acc1"]), accountId: "acc1", model: "opus", concurrency: 6 };
    assert.deepEqual(knowledgeSettingsPatch(saved, { accountPolicy: { ...AUTO, maxWeeklyPct: 90 }, accountId: "acc1", model: "", concurrency: "6" }), {
      patch: { accountPolicy: { ...AUTO, maxWeeklyPct: 90 }, accountId: null, model: null }
    });
    assert.ok("error" in knowledgeSettingsPatch(SAVED, { accountPolicy: AUTO, accountId: null, model: "", concurrency: "12" }));
  });

  it("a server that predates policies is sent only the one account chosen for it", () => {
    const legacy: KnowledgeSettingsAnswer = { accountPolicy: null, accountId: null, model: null, concurrency: 4 };
    const form = knowledgeSettingsForm(legacy);
    assert.deepEqual(form, { accountPolicy: null, accountId: null, model: "", concurrency: "4" });
    assert.deepEqual(knowledgeSettingsPatch(legacy, form), { patch: {} });
    assert.deepEqual(knowledgeSettingsPatch(legacy, { ...form, accountId: "acc2", concurrency: "2" }), { patch: { accountId: "acc2", concurrency: 2 } });
    assert.deepEqual(knowledgeSettingsPatch({ ...legacy, accountId: "acc2" }, { ...form, accountId: null }), { patch: { accountId: null } });
    // Never a policy, even one the form somehow holds.
    assert.deepEqual(knowledgeSettingsPatch(legacy, { ...form, accountPolicy: fixed(["system"]) }), { patch: {} });
  });

  it("the one-account picker: automatic, then the Claude accounts, never the System login", () => {
    const account = (overrides: Partial<AgentAccount>): AgentAccount => ({
      id: "c1",
      agent: "claude",
      label: "me@example.com",
      email: null,
      plan: null,
      needsReauth: false,
      createdAt: "",
      importedAt: "",
      ...overrides
    });
    const options = knowledgeAccountOptions(
      [account({ id: "c1" }), account({ id: "x1", agent: "codex", label: "codex" }), account({ id: "c2", label: "Work", needsReauth: true })],
      null
    );
    assert.deepEqual(options, [
      { value: "", label: KNOWLEDGE_AUTOMATIC_ACCOUNT_LABEL },
      { value: "c1", label: "me" },
      { value: "c2", label: "Work (needs sign-in)" }
    ]);
    // A chosen account the list lacks stays as its own option.
    assert.deepEqual(knowledgeAccountOptions([account({ id: "c1" })], "gone").at(-1), { value: "gone", label: "Unknown account (gone)" });
    assert.deepEqual(knowledgeAccountOptions(undefined, "c9").at(-1), { value: "c9", label: "c9" });
  });

  it("an edit that comes back to the saved policy is no change, whatever the key order or unset fields", () => {
    const saved: KnowledgeSettings = { ...SAVED, accountPolicy: fixed(["a", "b"], { maxSessionPct: 80 }) };
    const form = knowledgeSettingsForm(saved);
    const reordered = { maxSessionPct: 80, accounts: ["a", "b"], unknownUsage: "last", strategy: "fixed", leastUsedMetric: "max", soonestResetWindow: "weekly", includeSystem: false, maxWeeklyPct: undefined } as AccountPolicy;
    assert.deepEqual(knowledgeSettingsPatch(saved, { ...form, accountPolicy: reordered }), { patch: {} });
    assert.equal(sameAccountPolicy(saved.accountPolicy, fixed(["b", "a"], { maxSessionPct: 80 })), false);
    assert.equal(sameAccountPolicy(saved.accountPolicy, fixed(["a", "b"])), false);
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
