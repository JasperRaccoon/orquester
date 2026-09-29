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
