/**
 * Render smoke checks for the docked banners (spec §7.5).
 *
 * Not a substitute for `banner-model.test.ts` / `pending-answer.test.ts`
 * (which own the rules): this exists because "every control is disabled while
 * a decision is in flight", "the detail block stays keyboard-reachable",
 * "Dismiss is offered only when `dismissible`" and "a secret question never
 * offers the mobile draft button" are all claims about *markup*, and a React
 * hook-order or prop mistake typechecks perfectly while rendering nothing.
 *
 * Static markup only — no DOM, no effects — so it stays a plain assert script
 * like every other `*.check.ts` here.
 */

import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PendingApproval, PendingUserInput } from "@orquester/api/agent-chat";

import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";

function render(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

/**
 * `ComposerPopover` (the approval overflow) uses `useLayoutEffect`, which the
 * static renderer warns about because it cannot encode the effect for
 * hydration. This script never hydrates, so that one warning is noise —
 * filtered by its exact text so every other console error still surfaces.
 */
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("useLayoutEffect does nothing on the server")) {
    return;
  }
  consoleError(...args);
};

/**
 * The ANSWER controls, i.e. everything but the collapse toggle. Collapsing is
 * not a decision, so it stays usable while one is in flight — §7.5's rule is
 * about the controls that would post a second answer.
 */
function answerButtons(html: string): string[] {
  return (html.match(/<button[^>]*>/g) ?? []).filter(
    (button) => !button.includes("data-pending-user-input-toggle")
  );
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

const approval: PendingApproval = {
  requestId: "req-1",
  requestKind: "command",
  createdAt: "2026-09-21T10:00:00.000Z",
  detail: "rm -rf /tmp/build && make release"
};

{
  const html = render(
    createElement(ApprovalCard, {
      approval,
      pendingCount: 3,
      isResponding: false,
      onRespond: () => {}
    })
  );
  // §4.3's default four: Approve and Decline primary, the rest in the overflow.
  assert.match(html, /data-approval-decision="accept"/, "Approve must be a primary button");
  assert.match(html, /data-approval-decision="decline"/, "Decline must be a primary button");
  assert.doesNotMatch(
    html,
    /data-approval-decision="cancel"/,
    "Cancel belongs in the overflow menu, not the primary row"
  );
  // §7.5: the detail is scrollable AND keyboard-focusable.
  // The attribute now names the SOURCE, so a card that shows nothing is
  // distinguishable from one echoing its own title (E2E E7).
  assert.match(html, /data-approval-detail="request"/);
  assert.match(html, /tabindex="0"/i, "the detail block must stay keyboard-reachable");
  assert.match(html, /rm -rf \/tmp\/build/, "the full command must be rendered");
  // The `1/N` counter appears only when more than one is queued.
  assert.match(html, /1\/3/);
}

{
  const html = render(
    createElement(ApprovalCard, {
      approval,
      pendingCount: 1,
      isResponding: true,
      onRespond: () => {}
    })
  );
  // §7.5: while a decision is in flight EVERY control in the row is disabled.
  const buttons = answerButtons(html);
  assert.ok(buttons.length > 0, "the card must render buttons");
  for (const button of buttons) {
    assert.match(button, /disabled/, `every control must be disabled while responding: ${button}`);
  }
  assert.doesNotMatch(html, /1\/1/, "a lone approval shows no counter");
}

{
  const warned = render(
    createElement(ApprovalCard, {
      approval: {
        ...approval,
        options: [
          { decision: "accept", label: "Run it", warning: "This looks like a prompt injection" },
          { decision: "decline", label: "No" }
        ]
      },
      pendingCount: 1,
      isResponding: false,
      onRespond: () => {}
    })
  );
  // An option's `warning` becomes an aria-description (and a tooltip/title).
  assert.match(warned, /aria-description="This looks like a prompt injection"/);
  assert.match(warned, /Run it/, "the provider's own wording is what the user sees");
}

// ---------------------------------------------------------------------------
// File-change approvals (E2E E7)
// ---------------------------------------------------------------------------

{
  // The bug: the body rendered the literal "File change approval".
  const bare = render(
    createElement(ApprovalCard, {
      approval: { ...approval, requestKind: "file-change", detail: undefined },
      pendingCount: 1,
      isResponding: false,
      onRespond: () => {}
    })
  );
  assert.match(bare, /data-approval-detail="unavailable"/);
  assert.match(bare, /Decline it unless you know/, "a missing detail must say so in words");
  const bodyAfterHeading = bare.slice(bare.indexOf("File change approval") + 1);
  assert.doesNotMatch(
    bodyAfterHeading,
    /File change approval/,
    "the body must never echo the card's own title"
  );
}

{
  // Joined to its tool call by `toolUseId`: path list + diff, colour-coded.
  const joined = render(
    createElement(ApprovalCard, {
      approval: { ...approval, requestKind: "file-change", detail: undefined, toolUseId: "call-1" },
      pendingCount: 1,
      isResponding: false,
      entries: [
        {
          kind: "activity",
          id: "a1",
          tone: "info",
          activityKind: "item.started",
          summary: "Editing ui-hello.txt",
          payload: {
            itemType: "file_change",
            toolUseId: "call-1",
            changedFiles: ["src/ui-hello.txt"],
            detail: "@@ -0,0 +1 @@\n+hello from the agent"
          },
          turnId: "t1",
          createdAt: "2026-09-21T10:00:00.000Z",
          updatedAt: "2026-09-21T10:00:00.000Z"
        }
      ],
      onRespond: () => {}
    })
  );
  assert.match(joined, /data-approval-detail="item"/);
  assert.match(joined, /src\/ui-hello\.txt/, "the path must reach the DOM");
  assert.match(joined, /hello from the agent/, "the diff must reach the DOM");
  assert.match(joined, /text-ok-300/, "an added line must be tone-coded");
  // A diff always stays monospaced.
  assert.match(joined, /font-mono/);
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

function question(overrides: Partial<PendingUserInput> = {}): PendingUserInput {
  return {
    requestId: "q-req",
    createdAt: "2026-09-21T10:00:00.000Z",
    dismissible: false,
    questions: [
      {
        id: "Which branch?",
        header: "Branch",
        question: "Which branch should I use?",
        options: [
          { label: "main", description: "the default branch" },
          { label: "develop", description: "the integration branch" }
        ]
      }
    ],
    ...overrides
  };
}

const questionProps = {
  isResponding: false,
  attachments: {},
  onSubmit: () => {},
  onDismiss: null,
  onCarryTextToDraft: () => {}
} as const;

{
  const html = render(createElement(QuestionCard, { ...questionProps, request: question() }));
  // §7.5: digit shortcuts 1–9 are advertised next to the options.
  assert.match(html, /Which branch should I use\?/);
  assert.match(html, />1</, "option 1 must show its digit shortcut");
  assert.match(html, />2</, "option 2 must show its digit shortcut");
  // R8-M1: the body is capped so a long option list cannot clip off the top.
  assert.match(html, /max-h-\[min\(24rem,40dvh\)\]/, "the card body must be scroll-capped");
  // R8-m2: the collapse affordance is visible.
  assert.match(html, /ac-chevron/, "the header must carry a disclosure chevron");
  // §7.5: Dismiss is offered ONLY when the request carries `dismissible`.
  assert.doesNotMatch(html, /Dismiss question without answering/);
  // The card never autofocuses.
  assert.doesNotMatch(html, /autofocus/i, "a question card must never steal focus");
}

{
  const html = render(
    createElement(QuestionCard, {
      ...questionProps,
      request: question({ dismissible: true }),
      onDismiss: () => {}
    })
  );
  assert.match(html, /Dismiss question without answering/);
}

{
  // R8-B2: on the compact layout a free-text question offers the card's own
  // field behind a tap — and a SECRET question never offers it at all, because
  // the old button focused the thread draft, where a credential would be
  // rendered, persisted as a user message and sent to the model.
  const freeText = render(
    createElement(QuestionCard, {
      ...questionProps,
      compact: true,
      request: question()
    })
  );
  assert.match(freeText, /Write a custom answer/);

  const secret = render(
    createElement(QuestionCard, {
      ...questionProps,
      compact: true,
      request: question({
        questions: [
          {
            id: "Token?",
            header: "Credential",
            question: "Paste the API token",
            options: [],
            ...{ isSecret: true }
          }
        ]
      })
    })
  );
  assert.doesNotMatch(
    secret,
    /Write a custom answer/,
    "a secret question must never route its answer through the thread draft"
  );
  assert.match(secret, /type="password"/, "a secret answer is masked in the card's own field");
}

{
  const html = render(
    createElement(QuestionCard, {
      ...questionProps,
      isResponding: true,
      request: question()
    })
  );
  // §7.5: every answer control disabled while the answer is in flight.
  for (const button of answerButtons(html)) {
    assert.match(button, /disabled/, `every control must be disabled while responding: ${button}`);
  }
  assert.match(html, /Submitting…/);
}

console.log("banner-render.check.ts: ok");
