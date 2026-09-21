import React from "react";
import { ArrowUp, Clock, FileText, Image as ImageIcon, Undo2, X } from "lucide-react";

import type { AttachmentRef } from "@orquester/api";

import { cn } from "../../../../lib/cn";
import type { AgentChatTimelineRow } from "../../../../lib/agent-chat/contracts";
import { ChatIconButton, CopyButton, DisclosureChevron, ShimmerText } from "../../primitives";
import { useTimelineRowContext } from "../context";
import { ChatMarkdown } from "../markdown/ChatMarkdown";
import { queuedStatusLabel, shouldClampUserMessage } from "../row-format";
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
 * asset URL. No route serves a thread attachment's bytes (§6.3 has no such
 * read and `ChatTimelineProps` no such seam), so an attachment renders as a
 * named chip. Inventing a URL here would produce a broken `<img>` on every
 * message, which is strictly worse than a chip that is honest.
 */
function AttachmentChips({ attachments }: { attachments: readonly AttachmentRef[] }): React.ReactElement {
  return (
    <div className="mb-2 flex flex-col gap-1">
      {attachments.map((attachment) => (
        <div key={attachment.id} className="flex min-w-0 items-center gap-1.5 text-xs text-neutral-400">
          {attachment.type === "image" ? (
            <ImageIcon size={13} strokeWidth={1.8} aria-hidden className="shrink-0" />
          ) : (
            <FileText size={13} strokeWidth={1.8} aria-hidden className="shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
          <span className="ac-tabular shrink-0 text-neutral-500">
            {formatBytes(attachment.sizeBytes)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// User message
// ---------------------------------------------------------------------------

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
          {text}
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
      <div className="ac-reveal ac-tabular flex w-full max-w-[80%] items-center justify-end gap-2 pe-1 text-xs">
        <span className="text-neutral-500" title={formatRowTimestampTooltip(row.createdAt)}>
          {formatRowTimestamp(row.createdAt)}
        </span>
        {/* The rewind affordance is only offered where the adapter supports a
            conversation rollback, and never in the read-only drill-in. */}
        {!ctx.readOnly && ctx.canRevert && typeof revertTurnCount === "number" ? (
          <ChatIconButton
            size="micro"
            label="Rewind the conversation to here"
            onClick={() => ctx.onRevert(revertTurnCount)}
          >
            <Undo2 size={12} strokeWidth={1.8} aria-hidden />
          </ChatIconButton>
        ) : null}
        {text.length > 0 ? <CopyButton size="micro" value={text} label="Copy message" /> : null}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Assistant message
// ---------------------------------------------------------------------------

/** No bubble, no background, full column width: the agent's output is the page. */
export const AssistantMessageRow = React.memo(function AssistantMessageRow({
  row
}: {
  row: Row<"message">;
}): React.ReactElement {
  const ctx = useTimelineRowContext();
  const text = row.message.text || (row.message.streaming ? "" : "(empty response)");
  return (
    <div className="group/assistant relative min-w-0 px-1 py-0.5">
      <AuthorHeading>Agent</AuthorHeading>
      <ChatMarkdown text={text} streaming={row.message.streaming} onOpenFile={ctx.onOpenFile} />
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
          <div className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">{text}</div>
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
