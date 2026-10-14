import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveDockCard,
  showBackgroundLivenessBanner,
  splitApprovalOptions
} from "./banner-model.ts";

test("the default four split into Approve/Decline primary and the rest overflow", () => {
  const { primary, overflow } = splitApprovalOptions();
  assert.deepEqual(
    primary.map((option) => option.decision),
    ["decline", "accept"]
  );
  assert.deepEqual(
    overflow.map((option) => option.decision),
    ["cancel", "acceptForSession"]
  );
});

test("an empty advertised list falls back to the default four", () => {
  const { primary, overflow } = splitApprovalOptions([]);
  assert.deepEqual(primary.map((option) => option.decision), ["decline", "accept"]);
  assert.deepEqual(overflow.map((option) => option.decision), ["cancel", "acceptForSession"]);
});

test("advertised approval decisions keep their grouping when reordered", () => {
  const { primary, overflow } = splitApprovalOptions([
    { decision: "acceptAlways", label: "Always" },
    { decision: "accept", label: "Run" },
    { decision: "decline", label: "Decline" }
  ]);
  assert.deepEqual(primary.map((option) => option.decision), ["accept", "decline"]);
  assert.deepEqual(overflow.map((option) => option.decision), ["acceptAlways"]);
});

test("the liveness banner is hidden while a turn is working", () => {
  assert.equal(
    showBackgroundLivenessBanner({ backgroundLiveness: "working", isTurnWorking: true }),
    false
  );
  assert.equal(
    showBackgroundLivenessBanner({ backgroundLiveness: "working", isTurnWorking: false }),
    true
  );
  assert.equal(
    showBackgroundLivenessBanner({ backgroundLiveness: null, isTurnWorking: false }),
    false
  );
});

test("the dock shows one card at a time, in a fixed priority order", () => {
  const all = {
    hasApproval: true,
    hasUserInput: true,
    hasActionableProposedPlan: true,
    isComposerCollapsedMobile: false
  };
  assert.equal(resolveDockCard(all), "approval");
  assert.equal(resolveDockCard({ ...all, hasApproval: false }), "question");
  assert.equal(
    resolveDockCard({ ...all, hasApproval: false, hasUserInput: false }),
    "plan-ready"
  );
  // An MCP App's consent waits behind the agent's own requests, ahead of the plan prompt.
  assert.equal(resolveDockCard({ ...all, hasAppConsent: true }), "approval");
  assert.equal(resolveDockCard({ ...all, hasApproval: false, hasAppConsent: true }), "question");
  assert.equal(
    resolveDockCard({ ...all, hasApproval: false, hasUserInput: false, hasAppConsent: true }),
    "app-consent"
  );
  assert.equal(
    resolveDockCard({
      hasApproval: false,
      hasUserInput: false,
      hasActionableProposedPlan: false,
      isComposerCollapsedMobile: true,
      hasAppConsent: true
    }),
    "app-consent"
  );
  assert.equal(
    resolveDockCard({
      hasApproval: false,
      hasUserInput: false,
      hasActionableProposedPlan: false,
      isComposerCollapsedMobile: false
    }),
    null
  );
});

test("an agent's request for a secret docks after approvals and questions, before the plan prompt — on mobile too", () => {
  const base = { hasApproval: false, hasUserInput: false, hasActionableProposedPlan: true, isComposerCollapsedMobile: false };
  assert.equal(resolveDockCard({ ...base, hasSecretRequest: true }), "secret");
  assert.equal(resolveDockCard({ ...base, hasSecretRequest: true, isComposerCollapsedMobile: true }), "secret");
  assert.equal(resolveDockCard({ ...base, hasSecretRequest: true, hasUserInput: true }), "question");
  assert.equal(resolveDockCard({ ...base, hasSecretRequest: true, hasApproval: true }), "approval");
  assert.equal(resolveDockCard({ ...base, hasSecretRequest: false }), "plan-ready");
  // The agent's own secret request comes before an MCP App's consent.
  assert.equal(resolveDockCard({ ...base, hasSecretRequest: true, hasAppConsent: true }), "secret");
  assert.equal(resolveDockCard({ ...base, hasSecretRequest: false, hasAppConsent: true }), "app-consent");
});
