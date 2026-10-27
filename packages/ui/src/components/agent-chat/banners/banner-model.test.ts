import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveDockCard,
  showBackgroundLivenessBanner,
  sortBannerStack,
  splitApprovalOptions,
  toolApprovalAnswerFailure,
  toolApprovalChangeSentence,
  toolApprovalKeyAction,
  toolApprovalKindBadge,
  toolApprovalPreviewIsCut,
  // boxes:
  isBoxApprovalCard
} from "./banner-model.ts";
import { parseToolApprovalSummary } from "@orquester/api/agent-chat";

test("live activity precedes urgent notices, preserving equal-priority order and the input", () => {
  const entries = [
    { id: "notice", variant: "info" },
    { id: "warning", variant: "warning" },
    { id: "activity", variant: "default", priority: "activity" },
    { id: "urgent", variant: "default", priority: "urgent" },
    { id: "error", variant: "error" },
    { id: "other-notice", variant: "default" }
  ] as const;
  const original = [...entries];

  assert.deepEqual(sortBannerStack(entries), [entries[2], entries[1], entries[3], entries[4], entries[0], entries[5]]);
  assert.deepEqual(entries, original);
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
    isMobile: false
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
      isMobile: true,
      hasAppConsent: true
    }),
    "app-consent"
  );
  assert.equal(
    resolveDockCard({
      hasApproval: false,
      hasUserInput: false,
      hasActionableProposedPlan: false,
      isMobile: false
    }),
    null
  );
});

test("an agent's request for a secret docks after approvals and questions, before the plan prompt — on mobile too", () => {
  const base = { hasApproval: false, hasUserInput: false, hasActionableProposedPlan: true, isMobile: false };
  assert.equal(resolveDockCard({ ...base, hasSecretRequest: true }), "secret");
  assert.equal(resolveDockCard({ ...base, hasSecretRequest: true, isMobile: true }), "secret");
  assert.equal(resolveDockCard({ ...base, hasSecretRequest: true, hasUserInput: true }), "question");
  assert.equal(resolveDockCard({ ...base, hasSecretRequest: true, hasApproval: true }), "approval");
  assert.equal(resolveDockCard({ ...base, hasSecretRequest: false }), "plan-ready");
  // The plan prompt names the plan the composer's "Implement" carries out — on a phone too.
  assert.equal(resolveDockCard({ ...base, hasSecretRequest: false, isMobile: true }), "plan-ready");
  // The agent's own secret request comes before an MCP App's consent.
  assert.equal(resolveDockCard({ ...base, hasSecretRequest: true, hasAppConsent: true }), "secret");
  assert.equal(resolveDockCard({ ...base, hasSecretRequest: false, hasAppConsent: true }), "app-consent");
});

// ---------------------------------------------------------------------------
// Orquester approval cards (unified MCP §7.1)
// ---------------------------------------------------------------------------

test("an Orquester card comes after a provider approval and before everything else", () => {
  const base = { hasApproval: false, hasUserInput: true, hasSecretRequest: true, hasActionableProposedPlan: true, isMobile: false, hasAppConsent: true };
  assert.equal(resolveDockCard({ ...base, hasToolApproval: true }), "tool-approval");
  assert.equal(resolveDockCard({ ...base, hasApproval: true, hasToolApproval: true }), "approval");
  assert.equal(resolveDockCard({ ...base, hasToolApproval: false }), "question");
  assert.equal(resolveDockCard({ ...base, isMobile: true, hasToolApproval: true }), "tool-approval");
});

test("only ⌘/Ctrl+Enter approves, and never within the guard", () => {
  const key = (init: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; repeat: boolean }>) => ({
    key: "Enter", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init
  });
  const late = { now: 10_000, shownAt: 0 };
  assert.equal(toolApprovalKeyAction(key({}), late), null, "Enter alone");
  assert.equal(toolApprovalKeyAction(key({ ctrlKey: true }), late), "approve");
  assert.equal(toolApprovalKeyAction(key({ metaKey: true }), late), "approve");
  assert.equal(toolApprovalKeyAction(key({ metaKey: true, shiftKey: true }), late), null);
  assert.equal(toolApprovalKeyAction(key({ ctrlKey: true, altKey: true }), late), null);
  assert.equal(toolApprovalKeyAction(key({ key: "a", ctrlKey: true }), late), null);
  assert.equal(toolApprovalKeyAction(key({ ctrlKey: true }), { now: 1_499, shownAt: 0 }), "guarded");
  assert.equal(toolApprovalKeyAction(key({ ctrlKey: true }), { now: 1_500, shownAt: 0 }), "approve");
  assert.equal(toolApprovalKeyAction(key({ ctrlKey: true, repeat: true }), late), "guarded", "a held chord");
  assert.equal(toolApprovalKeyAction(key({ ctrlKey: true }), { ...late, inDenyReason: true }), "deny");
});

// boxes: renting a box is a spend card of its own.
test("a box rental (spend card) says what approving costs and reads as money, not Admin", () => {
  const sentence = toolApprovalChangeSentence({ kind: "spend", family: "boxes", scope: { label: "Billed to your Hetzner account" } });
  assert.doesNotMatch(sentence, /newer Orquester/);
  assert.match(sentence, /billed to your account/);
  assert.match(sentence, /when this chat closes/);
  assert.equal(toolApprovalKindBadge({ kind: "spend" }), "Costs money");
});

test("a late answer says the agent stopped waiting; a bad one keeps the card", () => {
  assert.equal(toolApprovalAnswerFailure(409).closed, true);
  assert.equal(toolApprovalAnswerFailure(404).closed, true);
  assert.equal(toolApprovalAnswerFailure(400).closed, false);
  assert.equal(toolApprovalAnswerFailure(null).closed, false);
});

const parsed = (extra: Record<string, unknown>) =>
  parseToolApprovalSummary({
    approvalId: "a", threadId: "t", tool: "x", kind: "admin", family: "desktops", title: "T", scope: { label: "S" },
    sections: [{ kind: "code", title: "run.sh", text: "echo hi" }], fullPreview: false, secretFields: [], grantOptions: [],
    requestedAt: "r", expiresAt: "e", ...extra
  })!;

test("a preview is cut when the summary says so or any section is partial", () => {
  assert.equal(toolApprovalPreviewIsCut(parsed({})), false);
  assert.equal(toolApprovalPreviewIsCut(parsed({ fullPreview: true })), true);
  assert.equal(toolApprovalPreviewIsCut(parsed({ sections: [{ kind: "diff", title: "d", unifiedDiff: "+a", partial: true }] })), true);
});

// boxes: the temporary-box card (Ephemeral AI VMs §13.2) is named for what it is.
test("a create_box card reads as renting a VM, by its kind or, before this build knows the kind, by its tool", () => {
  assert.equal(isBoxApprovalCard({ kind: "box" as never }), true);
  const unknownKind = parsed({ kind: "box", family: "boxes", tool: "create_box" });
  assert.equal(unknownKind.kind, "unknown");
  assert.equal(isBoxApprovalCard(unknownKind), true);
  assert.equal(toolApprovalKindBadge(unknownKind), "Rent a VM");
  assert.equal(isBoxApprovalCard(parsed({})), false);
  assert.equal(toolApprovalKindBadge(parsed({})), "Admin");
});
