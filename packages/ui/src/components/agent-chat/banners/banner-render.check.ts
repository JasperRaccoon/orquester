import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PendingApproval, PendingUserInput } from "@orquester/api/agent-chat";

import { ApprovalCard, approvalCardDescription } from "./ApprovalCard";
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
  assert.match(questionHtml, /<textarea\b[^>]*disabled=""/, "the custom answer is a multi-line field");

  // Provider warning text is data the user needs before granting approval.
  const warning = "This operation sends data to an external service";
  const warned = renderToStaticMarkup(createElement(ApprovalCard, {
    approval: { ...approval, options: [{ decision: "accept", label: "Run", warning }] },
    pendingCount: 1, isResponding: false, onRespond: noop
  }));
  assert.ok(warned.includes(`aria-description="${warning}"`));
  assert.match(warned, />Run</, "the provider's option label is visible");

  // Why the provider asked is said under the detail, and only when it said.
  const reasoned = renderToStaticMarkup(createElement(ApprovalCard, {
    approval: { ...approval, reason: "Permission rule Bash(make:*) requires approval" },
    pendingCount: 1, isResponding: false, onRespond: noop
  }));
  assert.match(reasoned, /data-approval-reason="true"[^>]*>Permission rule Bash\(make:\*\) requires approval</);
  const unreasoned = renderToStaticMarkup(createElement(ApprovalCard, {
    approval, pendingCount: 1, isResponding: false, onRespond: noop
  }));
  assert.doesNotMatch(unreasoned, /data-approval-reason/);

  // A subagent's request says so, beside the MCP server that asks.
  const fromSubagent = renderToStaticMarkup(createElement(ApprovalCard, {
    approval: { ...approval, requestingAgentId: "task-1" },
    pendingCount: 1, isResponding: false, onRespond: noop
  }));
  assert.match(fromSubagent, />Asked by a subagent</);
  assert.equal(approvalCardDescription({ appName: "github", requestingAgentId: "t" }), "github · asked by a subagent");
  assert.equal(approvalCardDescription({ appName: "github" }), "github");

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

  // An agent's request_secret (design 2026-10-14 §5): docked after a question,
  // a hidden, unremembered field, the prompt and purpose, Decline and Send.
  const secretRequest = {
    requestId: "secret-1", sessionId: "s1", name: "DEPLOY_KEY", prompt: "Paste the deploy key.",
    purpose: "Push the release", createdAt: "2026-09-21T10:00:00.000Z"
  };
  const answer = async (): Promise<void> => {};
  const secretDock = renderToStaticMarkup(createElement(ChatBannerDock, {
    ...dockProps, userInputs: [], secretRequests: [secretRequest, { ...secretRequest, requestId: "secret-2" }], onAnswerSecret: answer
  }));
  assert.match(secretDock, /data-secret-request="secret-1"/);
  assert.match(secretDock, /DEPLOY_KEY/);
  assert.match(secretDock, /Paste the deploy key\./);
  assert.match(secretDock, /For: Push the release/);
  // Where the value goes, said on the card: the agent and its model provider; masked in Orquester's records.
  assert.match(secretDock, /to its model provider/);
  assert.match(secretDock, /Later repeats are masked while this chat stays loaded/);
  assert.match(secretDock, />1\/2</, "the counter says another is behind it");
  assert.match(secretDock, /<input\b[^>]*type="password"/);
  assert.match(secretDock, /<input\b[^>]*autocomplete="off"/i);
  assert.match(secretDock, /data-1p-ignore/);
  assert.match(secretDock, />Decline</);
  // The question outranks it; without an answer path it is not shown at all.
  const behindQuestion = renderToStaticMarkup(createElement(ChatBannerDock, {
    ...dockProps, userInputs: [request], secretRequests: [secretRequest], onAnswerSecret: answer
  }));
  assert.doesNotMatch(behindQuestion, /data-secret-request=/);
  const unwired = renderToStaticMarkup(createElement(ChatBannerDock, { ...dockProps, userInputs: [], secretRequests: [secretRequest] }));
  assert.doesNotMatch(unwired, /data-secret-request=/);
} finally {
  console.error = consoleError;
}
