import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PendingApproval, PendingUserInput } from "@orquester/api/agent-chat";

import { ApprovalCard } from "./ApprovalCard";
import { ChatBannerDock } from "./ChatBannerDock";
import { QuestionCard } from "./QuestionCard";

// Static rendering cannot run the popover's layout effect.
const consoleError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("useLayoutEffect does nothing on the server")) return;
  consoleError(...args);
};

const noop = (): void => {};
const approval: PendingApproval = {
  requestId: "approval-1",
  requestKind: "command",
  createdAt: "2026-09-21T10:00:00.000Z",
  detail: "make release"
};
const request: PendingUserInput = {
  requestId: "question-1",
  createdAt: "2026-09-21T10:00:00.000Z",
  dismissible: false,
  questions: [{ id: "branch", header: "Branch", question: "Choose a branch", options: [{ label: "main", description: "" }] }]
};
const questionProps = { request, isResponding: false, attachments: {}, onSubmit: noop, onDismiss: null, onCarryTextToDraft: noop };

try {
  // GUI §7.5: posting one decision disables all controls that can post another.
  const approvalHtml = renderToStaticMarkup(createElement(ApprovalCard, {
    approval, pendingCount: 1, isResponding: true, onRespond: noop
  }));
  const approvalButtons = approvalHtml.match(/<button\b[^>]*>/g) ?? [];
  assert.ok(approvalButtons.length > 0);
  for (const button of approvalButtons) assert.match(button, /\sdisabled=""/);

  const questionHtml = renderToStaticMarkup(createElement(QuestionCard, { ...questionProps, isResponding: true }));
  const answerButtons = (questionHtml.match(/<button\b[^>]*>/g) ?? []).filter((button) => !/\saria-expanded=/.test(button));
  assert.ok(answerButtons.length > 0);
  for (const button of answerButtons) assert.match(button, /\sdisabled=""/);
  assert.match(questionHtml, /<input\b[^>]*type="text"[^>]*disabled=""/);

  // Provider warning text is data the user needs before granting approval.
  const warning = "This operation sends data to an external service";
  const warned = renderToStaticMarkup(createElement(ApprovalCard, {
    approval: { ...approval, options: [{ decision: "accept", label: "Run", warning }] },
    pendingCount: 1, isResponding: false, onRespond: noop
  }));
  assert.ok(warned.includes(`aria-description="${warning}"`));
  assert.match(warned, />Run</, "the provider's option label is visible");

  // The dock owns whether a native callback request can be dismissed.
  const dockProps = {
    sessionId: "s1", approvals: [], respondingRequestIds: [], backgroundLiveness: null,
    liveAgentCount: 0, stopping: false, actionableProposedPlan: false,
    onApprove: noop, onAnswer: noop, onDismiss: noop, onStopBackgroundWork: noop, onCarryTextToDraft: noop
  };
  const blocked = renderToStaticMarkup(createElement(ChatBannerDock, { ...dockProps, userInputs: [request] }));
  const dismissible = renderToStaticMarkup(createElement(ChatBannerDock, {
    ...dockProps, userInputs: [{ ...request, dismissible: true }]
  }));
  assert.doesNotMatch(blocked, /<button\b[^>]*aria-label="Dismiss\b/);
  assert.match(dismissible, /<button\b[^>]*aria-label="Dismiss\b/);

  // Codex secret questions use a password field even in the compact view.
  const secret = renderToStaticMarkup(createElement(QuestionCard, {
    ...questionProps, compact: true,
    request: { ...request, questions: [{ id: "token", header: "Credential", question: "API token", options: [], ...{ isSecret: true } }] }
  }));
  assert.match(secret, /<input\b[^>]*type="password"/);
  assert.doesNotMatch(secret, /<input\b[^>]*type="(?:text|file)"/);
} finally {
  console.error = consoleError;
}
