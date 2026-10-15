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
  toolApprovalGrantChoices,
  toolApprovalKeyAction
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

test("approval needs every secret, a live card and a known kind", () => {
  const card = { kind: "admin" as const, family: "workflow-secrets" as const, secretFields: [{ key: "K", label: "Key" }] };
  assert.equal(toolApprovalCanApprove({ card, secrets: {}, submitting: false, expired: false }), false);
  assert.equal(toolApprovalCanApprove({ card, secrets: { K: "v" }, submitting: false, expired: false }), true);
  assert.equal(toolApprovalCanApprove({ card, secrets: { K: "v" }, submitting: false, expired: true }), false);
  assert.equal(toolApprovalCanApprove({ card: { ...card, kind: "unknown" }, secrets: { K: "v" }, submitting: false, expired: false }), false);
});

test("every family has its own what-will-change sentence", () => {
  const families = ["workflows", "workflow-secrets", "agent-profile", "desktops", "saved-prompts", "cross-project", "cross-project-read", "cross-workspace-read"] as const;
  const sentences = new Set(families.map((family) => toolApprovalChangeSentence({ kind: "admin", family, scope: { label: "x" } })));
  assert.equal(sentences.size, families.length - 1, "the two read families share one");
  assert.match(toolApprovalChangeSentence({ kind: "toolset", family: "toolset", scope: { label: "x" } }), /this chat only/);
  assert.match(toolApprovalChangeSentence({ kind: "unknown", family: "unknown", scope: { label: "x" } }), /newer Orquester/);
});
