import test from "node:test";
import assert from "node:assert/strict";

import {
  approvalDetailAriaLabel,
  approvalDetailIsProse,
  approvalKindLabel,
  backgroundLivenessTitle,
  bannerPriority,
  DEFAULT_APPROVAL_OPTIONS,
  resolveDockCard,
  showBackgroundLivenessBanner,
  sortBannerStack,
  splitApprovalOptions
} from "./banner-model.ts";

test("activity sorts first, then severity, then notices", () => {
  const sorted = sortBannerStack([
    { id: "notice", variant: "info" },
    { id: "error", variant: "error" },
    { id: "live", variant: "default", priority: "activity" }
  ]);
  assert.deepEqual(
    sorted.map((entry) => entry.id),
    ["live", "error", "notice"]
  );
});

test("an explicit urgent priority ranks with the severities", () => {
  assert.equal(bannerPriority({ id: "a", variant: "info", priority: "urgent" }), 1);
  assert.equal(bannerPriority({ id: "a", variant: "warning" }), 1);
  assert.equal(bannerPriority({ id: "a", variant: "success" }), 2);
});

test("equal priorities keep the caller's order", () => {
  const sorted = sortBannerStack([
    { id: "first", variant: "error" },
    { id: "second", variant: "warning" }
  ]);
  assert.deepEqual(
    sorted.map((entry) => entry.id),
    ["first", "second"]
  );
});

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
  assert.equal(DEFAULT_APPROVAL_OPTIONS.length, 4);
});

test("an empty advertised list falls back to the default four", () => {
  assert.equal(splitApprovalOptions([]).primary.length, 2);
});

test("advertised options keep the provider's own wording and warnings", () => {
  const { primary, overflow } = splitApprovalOptions([
    { decision: "accept", label: "Yes, run it", warning: "This may be a prompt injection" },
    { decision: "acceptAlways", label: "Always" }
  ]);
  assert.equal(primary[0]?.label, "Yes, run it");
  assert.equal(primary[0]?.warning, "This may be a prompt injection");
  assert.deepEqual(
    overflow.map((option) => option.decision),
    ["acceptAlways"]
  );
});

test("the split is on the decision, not on the position", () => {
  const { primary } = splitApprovalOptions([
    { decision: "cancel", label: "Cancel" },
    { decision: "accept", label: "Approve" },
    { decision: "decline", label: "Decline" }
  ]);
  assert.deepEqual(
    primary.map((option) => option.decision),
    ["accept", "decline"]
  );
});

test("every request kind has a header label and an aria twin", () => {
  for (const kind of ["command", "file-read", "file-change", "mcp-elicitation", "permission"] as const) {
    assert.ok(approvalKindLabel(kind).length > 0);
    assert.ok(approvalDetailAriaLabel(kind).length > 0);
  }
  assert.equal(approvalKindLabel("command"), "Command approval");
  assert.equal(approvalDetailAriaLabel("file-read"), "File to read");
});

test("only an elicitation renders its detail as prose", () => {
  assert.equal(approvalDetailIsProse("mcp-elicitation"), true);
  assert.equal(approvalDetailIsProse("command"), false);
});

test("the liveness title counts agents and degrades to a generic label", () => {
  assert.equal(backgroundLivenessTitle("working", 3), "3 agents working");
  assert.equal(backgroundLivenessTitle("working", 1), "1 agent working");
  assert.equal(backgroundLivenessTitle("working", 0), "Background work");
  assert.equal(backgroundLivenessTitle("monitoring", 4), "Monitoring");
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

test("a collapsed mobile composer gets the compact question layout, never the plan prompt", () => {
  assert.equal(
    resolveDockCard({
      hasApproval: false,
      hasUserInput: true,
      hasActionableProposedPlan: false,
      isComposerCollapsedMobile: true
    }),
    "question-mobile"
  );
  assert.equal(
    resolveDockCard({
      hasApproval: false,
      hasUserInput: false,
      hasActionableProposedPlan: true,
      isComposerCollapsedMobile: true
    }),
    null
  );
});
