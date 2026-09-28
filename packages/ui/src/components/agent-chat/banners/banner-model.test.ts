import test from "node:test";
import assert from "node:assert/strict";

import {
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
});

test("an empty advertised list falls back to the default four", () => {
  const { primary, overflow } = splitApprovalOptions([]);
  assert.deepEqual(primary.map((option) => option.decision), ["decline", "accept"]);
  assert.deepEqual(overflow.map((option) => option.decision), ["cancel", "acceptForSession"]);
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
