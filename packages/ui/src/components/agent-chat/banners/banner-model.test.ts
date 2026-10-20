import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveDockCard,
  showBackgroundLivenessBanner,
  splitApprovalOptions,
  toolApprovalAnswerFailure,
  toolApprovalCanApprove,
  toolApprovalChangeSentence,
  toolApprovalExpiryText,
  toolApprovalApproveBlockedReason,
  toolApprovalGrantChoices,
  toolApprovalGuardKey,
  toolApprovalKeyAction,
  toolApprovalKindBadge,
  toolApprovalCardKey,
  toolApprovalClickGuarded,
  toolApprovalPreviewIsCut,
  TOOL_APPROVAL_POINTER_GUARD_MS,
  // boxes:
  isBoxApprovalCard
} from "./banner-model.ts";
import { ADMIN_FAMILIES, parseToolApprovalSummary } from "@orquester/api/agent-chat";

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

// ---------------------------------------------------------------------------
// Orquester approval cards (unified MCP §7.1)
// ---------------------------------------------------------------------------

test("an Orquester card comes after a provider approval and before everything else", () => {
  const base = { hasApproval: false, hasUserInput: true, hasSecretRequest: true, hasActionableProposedPlan: true, isComposerCollapsedMobile: false, hasAppConsent: true };
  assert.equal(resolveDockCard({ ...base, hasToolApproval: true }), "tool-approval");
  assert.equal(resolveDockCard({ ...base, hasApproval: true, hasToolApproval: true }), "approval");
  assert.equal(resolveDockCard({ ...base, hasToolApproval: false }), "question");
  assert.equal(resolveDockCard({ ...base, isComposerCollapsedMobile: true, hasToolApproval: true }), "tool-approval");
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

test("every Admin family has its own change sentence; a secret-files push names the vault and the clones", () => {
  for (const family of ADMIN_FAMILIES) {
    assert.doesNotMatch(toolApprovalChangeSentence({ kind: "admin", family, scope: { label: "S" } }), /newer Orquester/, family);
  }
  const push = toolApprovalChangeSentence({ kind: "admin", family: "secret-files", scope: { label: "S" } });
  assert.match(push, /this repo's vault/);
  assert.match(push, /every clone listed/);
  assert.match(push, /never values/);
});

// boxes: renting a box is a spend card of its own.
test("a box rental (spend card) says what approving costs and reads as money, not Admin", () => {
  const sentence = toolApprovalChangeSentence({ kind: "spend", family: "boxes", scope: { label: "Billed to your Hetzner account" } });
  assert.doesNotMatch(sentence, /newer Orquester/);
  assert.match(sentence, /billed to your account/);
  assert.match(sentence, /when this chat closes/);
  assert.equal(toolApprovalKindBadge({ kind: "spend" }), "Costs money");
});

test("grant choices are exactly the offered scopes", () => {
  assert.deepEqual(toolApprovalGrantChoices({ grantOptions: [], family: "desktops" }), []);
  assert.deepEqual(toolApprovalGrantChoices({ grantOptions: ["project"], family: "desktops" }).map((choice) => choice.scope), ["project"]);
  const both = toolApprovalGrantChoices({ grantOptions: ["chat", "project"], family: "workflows" });
  assert.deepEqual(both.map((choice) => choice.scope), ["chat", "project"]);
  assert.match(both[0]!.hint, /workflows created or approved in this chat/);
});

test("the card counts down and says when it expired", () => {
  const at = Date.parse("2026-10-15T10:00:00.000Z");
  assert.equal(toolApprovalExpiryText("2026-10-15T10:30:00.000Z", at), "Expires in 30 min");
  assert.equal(toolApprovalExpiryText("2026-10-15T10:00:41.000Z", at), "Expires in 41 s");
  assert.equal(toolApprovalExpiryText("2026-10-15T10:00:00.000Z", at), "Expired");
  assert.equal(toolApprovalExpiryText("not a date", at), "");
});

test("a late answer says the agent stopped waiting; a bad one keeps the card", () => {
  assert.deepEqual(toolApprovalAnswerFailure(409), { text: "The agent stopped waiting: your answer was not used.", closed: true });
  assert.equal(toolApprovalAnswerFailure(404).closed, true);
  assert.equal(toolApprovalAnswerFailure(400).closed, false);
  assert.equal(toolApprovalAnswerFailure(null).closed, false);
});

test("approval needs every secret, a live card, a known kind and — when cut — the whole preview", () => {
  const card = { kind: "admin" as const, family: "workflow-secrets" as const, secretFields: [{ key: "K", label: "Key" }] };
  const base = { card, secrets: { K: "v" }, submitting: false, expired: false, previewComplete: true };
  assert.equal(toolApprovalCanApprove({ ...base, secrets: {} }), false);
  assert.equal(toolApprovalCanApprove(base), true);
  assert.equal(toolApprovalCanApprove({ ...base, expired: true }), false);
  assert.equal(toolApprovalCanApprove({ ...base, card: { ...card, kind: "unknown" } }), false);
  assert.equal(toolApprovalCanApprove({ ...base, previewComplete: false }), false);
  assert.match(toolApprovalApproveBlockedReason({ ...base, previewComplete: false }) ?? "", /View all/);
  assert.match(toolApprovalApproveBlockedReason({ ...base, secrets: {} }) ?? "", /secret/);
  assert.equal(toolApprovalApproveBlockedReason(base), null);
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

test("the guard key moves with section CONTENT, not only its count", () => {
  const a = toolApprovalGuardKey(parsed({}));
  assert.equal(toolApprovalGuardKey(parsed({})), a);
  assert.notEqual(toolApprovalGuardKey(parsed({ sections: [{ kind: "code", title: "run.sh", text: "rm -rf ~" }] })), a);
  assert.notEqual(toolApprovalGuardKey(parsed({ reason: "because" })), a);
});

test("every click inside the appearance window is ignored, whatever its detail", () => {
  assert.equal(toolApprovalClickGuarded({ now: TOOL_APPROVAL_POINTER_GUARD_MS - 1, shownAt: 0 }), true);
  assert.equal(toolApprovalClickGuarded({ now: 10, shownAt: 0 }), true);
  assert.equal(toolApprovalClickGuarded({ now: TOOL_APPROVAL_POINTER_GUARD_MS, shownAt: 0 }), false);
});

test("the card key moves with the summary's content under the same id", () => {
  const a = toolApprovalCardKey(parsed({}));
  assert.equal(toolApprovalCardKey(parsed({})), a);
  assert.notEqual(toolApprovalCardKey(parsed({ sections: [{ kind: "code", title: "run.sh", text: "other" }] })), a);
  assert.notEqual(toolApprovalCardKey(parsed({ fullPreview: true })), a);
  assert.notEqual(toolApprovalCardKey(parsed({ title: "T2" })), a);
  assert.notEqual(toolApprovalCardKey(parsed({ scope: { label: "S2" } })), a);
  assert.notEqual(toolApprovalCardKey(parsed({ reason: "r" })), a);
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
