import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SYSTEM_ACCOUNT_ID, type AgentConversationSummary } from "@orquester/api";
import { resumeAccountId } from "./resume-account.ts";

const row = (fields: Partial<AgentConversationSummary>): AgentConversationSummary => ({
  id: "01a0f691-f54d-7292-9691-173b2865837d",
  agentRefId: "grok",
  title: "Review docs for bugs",
  updatedAt: "2026-10-01T09:05:00.000Z",
  ...fields
});

describe("resumeAccountId", () => {
  it("forces the managed account whose own home holds the transcript", () => {
    assert.equal(resumeAccountId(row({ home: "account", accountId: "acc-1" }), "acc-2"), "acc-1");
  });

  it("a system-home row with no preference is left to the daemon's per-agent default", () => {
    // Grok's managed homes symlink `sessions` to the system home, so the scan
    // attributes their rows to "system". Pinning the System sentinel then
    // launched under the signed-out system home ("Authentication required"),
    // where the "+" menu would have launched the per-agent default account.
    const accountId = resumeAccountId(row({ home: "system" }));
    assert.equal(accountId, undefined);
    assert.notEqual(accountId, SYSTEM_ACCOUNT_ID);
  });

  it("a system-home row honours the caller's selection, System included", () => {
    assert.equal(resumeAccountId(row({ home: "system" }), "acc-2"), "acc-2");
    assert.equal(resumeAccountId(row({ home: "system" }), SYSTEM_ACCOUNT_ID), SYSTEM_ACCOUNT_ID);
  });

  it("a row from a daemon predating attribution falls back to the caller's choice", () => {
    assert.equal(resumeAccountId(row({}), "acc-2"), "acc-2");
    assert.equal(resumeAccountId(row({})), undefined);
  });
});
