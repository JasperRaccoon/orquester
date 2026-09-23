import React from "react";
import { ArrowUp, Clock, Undo2, X } from "lucide-react";

import type { AttachmentRef } from "@orquester/api";

import { FileTypeIcon } from "../../../../icons/files";
import { cn } from "../../../../lib/cn";
import type { AgentChatTimelineRow } from "../../../../lib/agent-chat/contracts";
import { ComposerPopover } from "../../composer/ComposerPopover";
import {
  REWIND_BUSY_TITLE,
  REWIND_DISABLED_EXPLAINS_ITSELF,
  RewindConfirmPanel,
  rewindDroppedTurnCount
} from "../../composer/RewindControl";
import { ChatIconButton, CopyButton, DisclosureChevron, ShimmerText } from "../../primitives";
import { useTimelineRowContext } from "../context";
import { ChatMarkdown } from "../markdown/ChatMarkdown";
import { queuedStatusLabel, shouldClampUserMessage } from "../row-format";
import { splitSkillMentions } from "../row-chrome";
import { formatRowTimestamp, formatRowTimestampTooltip } from "../timestamp";

type Row<K extends AgentChatTimelineRow["kind"]> = Extract<AgentChatTimelineRow, { kind: K }>;

/** The row's own author heading: structure for screen readers, alignment for eyes. */
function AuthorHeading({ children }: { children: React.ReactNode }): React.ReactElement {
  return <h3 className="sr-only">{children}</h3>;
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Attachment chips.
 *
 * DELIBERATE DIFFERENCE FROM T3: T3 renders image thumbnails from a signed
 * asset URL. §6.3's read-back route exists, but the timeline does not fetch
 * it (§7.3 Built): nothing decodes a 10 MiB image into a bubble on a phone.
 * An attachment renders as a named chip with the file-type icon the composer
 * uses (`icons/files`), so a sent `.xlsx` looks like the chip the user staged.
 */
function AttachmentChips({ attachments }: { attachments: readonly AttachmentRef[] }): React.ReactElement {
  return (
    <div className="mb-2 flex flex-col gap-1">
      {attachments.map((attachment) => (
        <div key={attachment.id} className="flex min-w-0 items-center gap-1.5 text-xs text-neutral-400">
          <FileTypeIcon name={attachment.name} mimeType={attachment.mimeType} size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
          <span className="ac-tabular shrink-0 text-neutral-500">
            {formatBytes(attachment.sizeBytes)}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * A sent message's text, with `$skill` mentions re-chipped (§4.6.7).
 *
 * **No `isCommand` flag is persisted** — the text is the record — so the chip
 * is derived at render time by running the same shape of tokeniser the composer
 * uses over the stored text and matching against the *current* per-cwd skill
 * list. A mention of a skill that no longer exists therefore reads as the plain
 * text it is, which is the honest outcome.
 *
 * *T3: `packages/shared/src/composerInlineTokens.ts:100-127`.*
 */
function MessageBodyText({ text }: { text: string }): React.ReactElement {
  const { skills } = useTimelineRowContext();
  const runs = React.useMemo(() => splitSkillMentions(text, skills), [text, skills]);
  if (runs.length === 1) return <>{text}</>;
  return (
    <>
      {runs.map((run, index) =>
        run.skill === undefined ? (
          // eslint-disable-next-line react/no-array-index-key
          <React.Fragment key={index}>{run.text}</React.Fragment>
        ) : (
          <span
            // eslint-disable-next-line react/no-array-index-key
            key={index}
            title={`Skill: ${run.skill}`}
            className="rounded border border-neutral-700 bg-neutral-900/60 px-1 font-mono text-[0.75rem] text-neutral-200"
          >
            {run.text}
          </span>
        )
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// User message
// ---------------------------------------------------------------------------

/**
 * "Rewind to here" (§5.5, T3's "Edit from here").
 *
 * A micro icon in the hover-revealed meta row that opens a confirm anchored to
 * itself — never a modal: the confirm names what the rewind removes and that
 * files stay as they are, and Rewind is focused so Enter confirms. Disabled,
 * and saying why, while a turn runs or a revert is already in flight; the host
 * would refuse the first and the second is rewriting the very history the
 * button points at.
 *
 * *T3: `MessagesTimeline.tsx` `RevertUserMessageButton` (disabled while
 * working or reverting) and `ChatView.tsx`'s "Edit from here?" dialog.*
 */
function RewindToHereButton({
  messageId,
  text,
  revertTurnCount,
  onOpenChange
}: {
  messageId: string;
  text: string;
  revertTurnCount: number;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const ctx = useTimelineRowContext();
  const busy = ctx.revertBusy;
  return (
    <ComposerPopover
      label="Rewind to here"
      align="end"
      width="w-80"
      onOpenChange={onOpenChange}
      renderTrigger={(triggerProps) => (
        <ChatIconButton
          {...triggerProps}
          size="micro"
          label="Rewind to here"
          title={busy ? REWIND_BUSY_TITLE : "Rewind to here"}
          disabled={busy}
          // Still answers the pointer, so the title can say why it is disabled.
          className={REWIND_DISABLED_EXPLAINS_ITSELF}
        >
          <Undo2 size={12} strokeWidth={1.8} aria-hidden />
        </ChatIconButton>
      )}
    >
      {(close) => (
        <RewindConfirmPanel
          text={text}
          // The turns kept are `revertTurnCount`; everything the thread has
          // started since — this message's own turn included — goes.
          droppedTurnCount={rewindDroppedTurnCount({
            startedTurnCount: ctx.startedTurnCount,
            targetTurnCount: revertTurnCount
          })}
          busy={busy}
          onBack={close}
          onConfirm={() => {
            close();
            ctx.onRevert({ messageId, targetTurnCount: revertTurnCount });
          }}
        />
      )}
    </ComposerPopover>
  );
}

/**
 * The only filled bubble in the timeline (§5.1 of the design reference).
 *
 * Right-aligned, capped at 80 %, no border, no avatar and no name label — the
 * asymmetry with the assistant's full-width, unbubbled output *is* the
 * conversation design.
 */
export const UserMessageRow = React.memo(function UserMessageRow({
  row
}: {
  row: Row<"message">;
}): React.ReactElement {
  const ctx = useTimelineRowContext();
  const [expanded, setExpanded] = React.useState(false);
  // The meta row is hover-revealed; while the rewind confirm is open it stays
  // shown, so the button the popover is anchored to does not fade out under it.
  const [rewindOpen, setRewindOpen] = React.useState(false);
  const text = row.message.text;
  const clamp = shouldClampUserMessage(text) && !expanded;
  const attachments = row.message.attachments ?? [];
  const revertTurnCount = row.revertTurnCount;

  return (
    <div className="group flex flex-col items-end gap-1">
      <div className="relative max-w-[80%] rounded-2xl bg-neutral-800 p-3 text-neutral-100">
        <AuthorHeading>You</AuthorHeading>
        {attachments.length > 0 ? <AttachmentChips attachments={attachments} /> : null}
        <div
          className={cn(
            "whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]",
            clamp && "max-h-44 overflow-hidden [mask-image:linear-gradient(to_bottom,black_calc(100%-1.75rem),transparent)]"
          )}
        >
          <MessageBodyText text={text} />
        </div>
        {shouldClampUserMessage(text) ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="mt-1.5 rounded text-xs text-neutral-400 hover:text-neutral-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
          >
            {expanded ? "Show less" : "Show full message"}
          </button>
        ) : null}
      </div>
      <div
        className="ac-reveal ac-tabular flex w-full max-w-[80%] items-center justify-end gap-2 pe-1 text-xs"
        data-visible={rewindOpen ? "true" : undefined}
      >
        <span className="text-neutral-500" title={formatRowTimestampTooltip(row.createdAt)}>
          {formatRowTimestamp(row.createdAt)}
        </span>
        {/* The rewind affordance is only offered where the adapter supports a
            conversation rollback, and never in the read-only drill-in. */}
        {!ctx.readOnly && ctx.canRevert && typeof revertTurnCount === "number" ? (
          <RewindToHereButton
            messageId={row.message.id}
            text={text}
            revertTurnCount={revertTurnCount}
            onOpenChange={setRewindOpen}
          />
        ) : null}
        {text.length > 0 ? <CopyButton size="micro" value={text} label="Copy message" /> : null}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Assistant message
// ---------------------------------------------------------------------------

/**
 * No bubble, no background, full column width: the agent's output is the page.
 *
 * A message the provider marked as **commentary** rather than the turn's answer
 * (Codex's `phase`) is rendered quietly — muted and indented under the activity
 * column. The projection is meant to demote it into the activity group before
 * it ever gets here (§7.3); this is the graceful degradation if one slips
 * through, because a thread of "I'll do X next" narration rendered as full
 * answers is unreadable.
 */
export const AssistantMessageRow = React.memo(function AssistantMessageRow({
  row
}: {
  row: Row<"message">;
}): React.ReactElement {
  const ctx = useTimelineRowContext();
  const commentary = row.message.messageKind === "commentary";
  const text = row.message.text || (row.message.streaming ? "" : "(empty response)");
  return (
    <div
      className={cn(
        "group/assistant relative min-w-0 px-1 py-0.5",
        commentary && "ms-7 text-neutral-400"
      )}
    >
      <AuthorHeading>Agent</AuthorHeading>
      <ChatMarkdown
        text={text}
        streaming={row.message.streaming}
        onOpenFile={ctx.onOpenFile}
        {...(commentary ? { className: "text-neutral-500" } : {})}
      />
    </div>
  );
});

/** The hover-revealed meta strip under a terminal assistant message. */
export const AssistantMetaRow = React.memo(function AssistantMetaRow({
  row
}: {
  row: Row<"assistant-meta">;
}): React.ReactElement {
  return (
    <div className="group/assistant ac-reveal ac-tabular flex items-center gap-2 px-1 text-xs text-neutral-500">
      <span title={formatRowTimestampTooltip(row.createdAt)}>{formatRowTimestamp(row.createdAt)}</span>
      <CopyButton size="micro" value={() => row.message.text} label="Copy response" />
    </div>
  );
});

// ---------------------------------------------------------------------------
// Reasoning
// ---------------------------------------------------------------------------

function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  return line ?? "";
}

/**
 * Collapsed to one line (§7.3).
 *
 * The badge reads "summary" only where the provider actually sent
 * `reasoning_summary_text`; raw reasoning gets no badge, and an item from an
 * adapter that does not report the distinction gets none either. A blanket
 * "summary" label would be a claim about the provider's output we cannot make —
 * and on the providers that hand over a summary *instead of* the reasoning, it
 * is the one thing worth saying.
 */
export const ReasoningRow = React.memo(function ReasoningRow({
  row
}: {
  row: Row<"message">;
}): React.ReactElement {
  const ctx = useTimelineRowContext();
  const id = row.message.id;
  const text = row.message.text;
  const live = row.message.streaming;
  const summary = firstLine(text);
  // REALITY: the Codex CLI emits a `reasoning` item whose summary AND content
  // are always empty (W7's capture). A reasoning row must therefore survive
  // having no text at all — it stays a one-liner, it does not offer a
  // disclosure, and it never opens an empty card.
  const body = text.slice(summary.length).trim();
  const canExpand = body.length > 0;
  const expanded = canExpand && ctx.isReasoningExpanded(id);
  const label = summary || (live ? "Thinking" : "Thought");

  const header = (
    <>
      {row.message.reasoningKind === "summary" ? (
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
          summary
        </span>
      ) : null}
      <ShimmerText live={live} className="min-w-0 flex-1 truncate">
        {label}
      </ShimmerText>
    </>
  );

  return (
    <div className="px-0.5">
      {canExpand ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => ctx.setReasoningExpanded(id, !expanded)}
          className="flex min-h-6 w-fit max-w-full min-w-0 cursor-pointer select-none items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-sm leading-relaxed transition-colors hover:bg-neutral-800/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500"
        >
          {header}
          <DisclosureChevron open={expanded} />
        </button>
      ) : (
        <div className="flex min-h-6 w-fit max-w-full min-w-0 items-center gap-1.5 px-0.5 py-0.5 text-sm leading-relaxed">
          {header}
        </div>
      )}
      {expanded ? (
        <div className="ms-7 mt-1 whitespace-pre-wrap select-text text-sm leading-relaxed text-neutral-400">
          {text}
        </div>
      ) : null}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Queued ghost bubble
// ---------------------------------------------------------------------------

/**
 * Dashed and unfilled against the user bubble's solid fill — "this is not sent
 * yet" without a word — and the clock chip names *when* it will go.
 *
 * > Queueing that is invisible is alarming; queueing that names its own trigger
 * > is not.
 */
export const QueuedMessageRow = React.memo(function QueuedMessageRow({
  row
}: {
  row: Row<"queued-message">;
}): React.ReactElement {
  const ctx = useTimelineRowContext();
  const queued = row.queuedMessage;
  const text = queued.text.trim();
  const attachmentCount = queued.attachments.length;
  const contextCount = queued.context.length;
  const status = queuedStatusLabel(queued.holdUntilUserAction, row.isNext);

  return (
    <div className="flex flex-col items-end" data-queued-message-id={queued.id}>
      <div className="max-w-[80%] rounded-2xl border border-dashed border-neutral-700 p-3 text-neutral-300">
        {text.length > 0 ? (
          <div className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">
            <MessageBodyText text={text} />
          </div>
        ) : null}
        {attachmentCount > 0 || contextCount > 0 ? (
          <div className={cn("text-xs text-neutral-500", text.length > 0 && "mt-1.5")}>
            {[
              attachmentCount > 0
                ? `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`
                : null,
              contextCount > 0 ? `${contextCount} context item${contextCount === 1 ? "" : "s"}` : null
            ]
              .filter((value) => value !== null)
              .join(", ")}
          </div>
        ) : null}
        <div className="mt-2 flex items-center gap-4 text-xs text-neutral-500">
          <span className="inline-flex h-6 items-center gap-1" title={status} aria-label={`Queued. ${status}.`}>
            <Clock size={14} strokeWidth={1.8} aria-hidden />
            Queued
          </span>
          {!ctx.readOnly ? (
            <span className="ml-auto flex items-center gap-0.5">
              <ChatIconButton
                size="micro"
                label="Send now"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => ctx.onSendQueuedNow(queued.id)}
              >
                <ArrowUp size={14} strokeWidth={1.8} aria-hidden />
              </ChatIconButton>
              <ChatIconButton
                size="micro"
                label="Cancel and return to the composer"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => ctx.onReturnQueuedToComposer(queued.id)}
              >
                <X size={14} strokeWidth={1.8} aria-hidden />
              </ChatIconButton>
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
});
