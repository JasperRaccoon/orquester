// Ported from T3 Code (MIT): apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx,
// apps/web/src/components/chat/ComposerPendingApprovalActions.tsx
import React from "react";
import { Ellipsis, ShieldIcon, TriangleAlert } from "lucide-react";
import type { ApprovalDecision, PendingApproval, ThreadItem } from "@orquester/api/agent-chat";

import { cn } from "../../../lib/cn";
import { BannerCard } from "../primitives";
import { ComposerMenuRow, ComposerPopover } from "../composer/ComposerPopover";
import {
  approvalDetailAriaLabel,
  approvalDetailIsProse,
  approvalKindLabel,
  splitApprovalOptions
} from "./banner-model";
import {
  APPROVAL_DETAIL_UNAVAILABLE,
  diffLineTone,
  resolveApprovalDetail,
  type DiffLineTone
} from "./approval-detail";

/** Per-line diff colouring, in the themed scale (never a literal colour). */
const DIFF_TONE: Record<DiffLineTone, string> = {
  added: "text-ok-300",
  removed: "text-danger-300",
  meta: "text-neutral-500",
  context: "text-neutral-300"
};

export interface ApprovalCardProps {
  approval: PendingApproval;
  /** How many approvals are queued behind this one; renders as `1/N`. */
  pendingCount: number;
  /** A decision for this request is in flight: every control is disabled. */
  isResponding: boolean;
  /**
   * The thread's items, so a request carrying no `detail` can be joined to the
   * tool call it gates by `toolUseId` (E2E E7). Optional: without it the card
   * falls back to the request's own detail, and says so when there is none.
   */
  entries?: readonly ThreadItem[];
  onRespond: (decision: ApprovalDecision) => void;
}

const PRIMARY_BUTTON =
  "ac-press inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium " +
  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 " +
  "disabled:pointer-events-none disabled:opacity-50";

/**
 * The approval card.
 *
 * `variant="warning"` with `density="spacious"` is not decoration: this is the
 * one card a turn is blocked on, and T3 picks exactly that pair for it.
 *
 * Three details carry the design:
 *
 *  - **The detail block is 80px tall, scrollable and keyboard-focusable.** A
 *    long command must be readable without leaving the banner, which is what
 *    `tabIndex={0}` buys; dropping it makes a long command unreachable for
 *    anyone not using a mouse. An `mcp-elicitation` renders prose, everything
 *    else mono.
 *  - **Approve and Decline are primary; every other advertised option is in
 *    the overflow.** With no advertised options the offered set is §4.3's
 *    default four, which puts "Always allow this session" and "Cancel" in that
 *    menu — it falls out of the split rather than being spelled twice.
 *  - **An option's `warning` becomes a triangle, a tooltip and an
 *    `aria-description`.** The string is the provider's own (a prompt-injection
 *    notice, typically) and is never paraphrased.
 *
 * It never steals focus and is never a modal: the user can keep typing with an
 * approval sitting there (§7.5).
 *
 * *T3: `ComposerPendingApprovalPanel.tsx:17-63`,
 * `ComposerPendingApprovalActions.tsx:23-108`.*
 */
export function ApprovalCard({
  approval,
  pendingCount,
  isResponding,
  entries,
  onRespond
}: ApprovalCardProps): React.ReactElement {
  const label = approvalKindLabel(approval.requestKind);
  const detail = resolveApprovalDetail(approval, entries);
  // An elicitation is prose; a diff must stay monospaced whatever the kind.
  const prose = approvalDetailIsProse(approval.requestKind) && !detail.isDiff;
  const { primary, overflow } = splitApprovalOptions(approval.options);

  return (
    <BannerCard
      variant="warning"
      density="spacious"
      icon={<ShieldIcon size={14} aria-hidden />}
      title={label}
      description={approval.appName}
      counter={pendingCount > 1 ? `1/${pendingCount}` : undefined}
      actions={
        <>
          {primary.map((option) => (
            <button
              key={option.decision}
              type="button"
              disabled={isResponding}
              aria-description={option.warning}
              title={option.warning}
              data-approval-decision={option.decision}
              onClick={() => onRespond(option.decision)}
              className={cn(
                PRIMARY_BUTTON,
                option.decision === "accept"
                  ? "bg-neutral-200 text-neutral-900 hover:bg-neutral-50"
                  : "border border-neutral-700 text-neutral-200 hover:bg-neutral-800"
              )}
            >
              {option.warning ? (
                <TriangleAlert size={12} className="shrink-0 text-warn" aria-hidden />
              ) : null}
              <span className="max-w-40 truncate">{option.label}</span>
            </button>
          ))}
          {overflow.length > 0 ? (
            <ComposerPopover
              align="end"
              width="w-60"
              label={`${label} — more options`}
              renderTrigger={(triggerProps) => (
                <button
                  {...triggerProps}
                  type="button"
                  disabled={isResponding}
                  aria-label="More approval options"
                  title="More approval options"
                  className={cn(
                    PRIMARY_BUTTON,
                    "w-7 justify-center px-0 border border-neutral-700 text-neutral-300 hover:bg-neutral-800"
                  )}
                >
                  <Ellipsis size={14} aria-hidden />
                </button>
              )}
            >
              {(close) =>
                overflow.map((option) => (
                  <ComposerMenuRow
                    key={option.decision}
                    disabled={isResponding}
                    aria-description={option.warning}
                    title={option.warning}
                    hint={option.warning}
                    icon={
                      option.warning ? (
                        <TriangleAlert size={12} className="text-warn" aria-hidden />
                      ) : undefined
                    }
                    onClick={() => {
                      close();
                      onRespond(option.decision);
                    }}
                  >
                    {option.label}
                  </ComposerMenuRow>
                ))
              }
            </ComposerPopover>
          ) : null}
        </>
      }
    >
      <div
        aria-label={approvalDetailAriaLabel(approval.requestKind)}
        data-approval-detail={detail.text === null ? "unavailable" : detail.source}
        tabIndex={0}
        className={cn(
          // A file change can be long: the 80px cap and the thin scrollbar are
          // what let a whole diff be read without leaving the banner.
          "ac-scroll-thin block max-h-20 w-full min-w-0 overflow-auto rounded-md",
          "bg-neutral-900/50 px-2 py-1.5 text-xs text-neutral-200",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500",
          prose ? "whitespace-pre-wrap break-words font-sans" : "whitespace-pre font-mono"
        )}
      >
        {detail.text === null ? (
          <span className="font-sans italic text-warn-300">{APPROVAL_DETAIL_UNAVAILABLE}</span>
        ) : detail.isDiff ? (
          // Per-line tone, so an addition and a removal are distinguishable at
          // a glance — the whole point of showing the diff before approving it.
          detail.text.split("\n").map((line, index) => (
            <span key={index} className={cn("block", DIFF_TONE[diffLineTone(line)])}>
              {line === "" ? "\u00a0" : line}
            </span>
          ))
        ) : (
          detail.text
        )}
      </div>
    </BannerCard>
  );
}
