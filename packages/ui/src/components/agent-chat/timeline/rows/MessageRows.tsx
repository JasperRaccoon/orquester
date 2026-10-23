import React from "react";
import { ArrowRightLeft, ArrowUp, Clock, GitFork, GitMerge, MessagesSquare, Undo2, X } from "lucide-react";

import type { AttachmentRef } from "@orquester/api";
import {
  isMergeBackMessage,
  isThreadAuthoredMessage,
  isToolsetContinueMessage,
  parseMergeBackMessage,
  parseThreadMessage,
  type ParsedThreadMessage,
  type ThreadLineageRelation
} from "@orquester/api/agent-chat";

import { noteRender } from "../../../../lib/render-probe";
import { FileTypeIcon } from "../../../../icons/files";
import { cn } from "../../../../lib/cn";
import { PROMPT_CUT_AT_REST_NOTE, type AgentPrompt } from "../../../../lib/agent-chat/agent-prompt.logic";
import type { AgentChatTimelineRow } from "../../../../lib/agent-chat/contracts";
import { ComposerPopover } from "../../composer/ComposerPopover";
import { splitLeadingQuotes } from "../../composer/composer-quotes";
import {
  REWIND_BUSY_TITLE,
  REWIND_DISABLED_EXPLAINS_ITSELF,
  RewindConfirmPanel,
  rewindDroppedTurnCount
} from "../../composer/RewindControl";
import { ChatIconButton, CopyButton, DisclosureChevron, ShimmerText } from "../../primitives";
import { useTimelineRowContext } from "../context";
import { ChatMarkdown } from "../markdown/ChatMarkdown";
import { QUOTE_SOURCE_ATTR } from "../quote-selection";
import { splitForgeLinks, type ForgeTextRun } from "../../../../lib/github-links/text-links";
import { ForgeLinkPill } from "../../forge-links/ForgeLinkPill";
import { foldedMessageSummary, foldsThreadMessage, queuedStatusLabel, shouldClampUserMessage } from "../row-format";
import { splitSkillMentions, type MessageTextRun } from "../row-chrome";
import { formatRowTimestamp, formatRowTimestampTooltip } from "../timestamp";

type Row<K extends AgentChatTimelineRow["kind"]> = Extract<AgentChatTimelineRow, { kind: K }>;

/**
 * The caption over a message another chat sent (unified MCP §8.2): how it came — sent, opened,
 * delegated, a reply to this chat's own message, or Orquester's notice that a task it delegated
 * needs input — and from which chat (and project, when the v2 header names one).
 */
export function threadMessageCaption(message: Pick<ParsedThreadMessage, "origin" | "fromTitle" | "fromProject">): string {
  const verb =
    message.origin === "delegated"
      ? "Delegated by"
      : message.origin === "opened"
        ? "Opened by"
        : message.origin === "reply"
          ? "Reply from"
          : message.origin === "attention"
            ? "Needs input in"
            : "Sent by";
  return `${verb} “${message.fromTitle}”${message.fromProject ? ` · ${message.fromProject}` : ""}`;
}

/** The caption over a child chat's result sent back here (thread lineage §6; `opened` chats too). */
export function mergedBackCaption(relation: ThreadLineageRelation, childTitle: string): string {
  const what =
    relation === "delegate" ? "Result of delegated task" : relation === "opened" ? "Merged back from opened chat" : "Merged back from fork";
  return `${what} “${childTitle}”`;
}

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
  // GitHub links first (they are pills, as in assistant markdown), then skill mentions in the rest.
  const runs = React.useMemo<Array<MessageTextRun & ForgeTextRun>>(
    () => splitForgeLinks(text).flatMap((run) => (run.link ? [run] : splitSkillMentions(run.text, skills))),
    [text, skills]
  );
  if (runs.length === 1 && !runs[0]?.link && runs[0]?.skill === undefined) return <>{text}</>;
  return (
    <>
      {runs.map((run, index) =>
        run.link ? (
          <ForgeLinkPill
            // eslint-disable-next-line react/no-array-index-key
            key={index}
            link={run.link}
            // The bubble is neutral-800 already; a darker wash keeps the pill visible on it.
            className="border-neutral-700 bg-neutral-900/60 hover:bg-neutral-900"
          />
        ) : run.skill === undefined ? (
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
 * "Fork from here" (thread lineage, spec 2026-10-14 §6): a new chat tab whose
 * conversation is this one's up to this message — through its turn for a
 * reply, just before it for a prompt (whose text the fork offers as its
 * draft). The host refuses a reply still being written and says so.
 */
function ForkFromHereButton({
  messageId,
  turnId,
  role,
  text
}: {
  messageId: string;
  turnId: string | null;
  role: "user" | "assistant";
  text: string;
}): React.ReactElement | null {
  const { onFork, onContinueIn } = useTimelineRowContext();
  // One fork per click: held until the daemon answered, so a double click
  // never opens two tabs (the view also refuses a second fork in flight).
  const [busy, setBusy] = React.useState(false);
  if (!onFork) return null;
  const label = role === "user" ? "Fork from before this message" : "Fork from here";
  return (
    <>
      <ChatIconButton
        size="micro"
        label={label}
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={() => {
          if (busy) return;
          setBusy(true);
          void Promise.resolve(onFork({ messageId, turnId, role, text })).finally(() => setBusy(false));
        }}
      >
        <GitFork size={12} strokeWidth={1.8} aria-hidden />
      </ChatIconButton>
      {/* The same cut in another agent, model or account — the picker says what it carries. */}
      {onContinueIn ? (
        <ChatIconButton
          size="micro"
          label={role === "user" ? "Continue in another agent from before this message…" : "Continue in another agent…"}
          aria-haspopup="dialog"
          disabled={busy}
          onClick={() => onContinueIn({ messageId, turnId, role, text })}
        >
          <ArrowRightLeft size={12} strokeWidth={1.8} aria-hidden />
        </ChatIconButton>
      ) : null}
    </>
  );
}

/**
 * A user message that opens with blockquotes — the passages quoted from the
 * agent's replies, which a send puts ahead of the user's words
 * (`composeQuotedPrompt`) — shows them as quotes: each its own block, rendered
 * as the markdown it is (a quoted code block stays a code block), and the
 * user's own text under them as the bubble always shows it. A message that
 * does not open that way is the bubble's plain text.
 */
function QuotedBodyText({ text }: { text: string }): React.ReactElement {
  const { onOpenFile } = useTimelineRowContext();
  const split = React.useMemo(() => splitLeadingQuotes(text), [text]);
  if (split.quotes.length === 0) return <MessageBodyText text={text} />;
  return (
    <>
      {split.quotes.map((quote, index) => (
        <blockquote
          // A message's quotes never reorder.
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          data-user-quote="true"
          className="mb-2 whitespace-normal border-l-2 border-neutral-600 pl-3 last:mb-0"
        >
          <ChatMarkdown text={quote} onOpenFile={onOpenFile} className="text-[13px] text-neutral-300" />
        </blockquote>
      ))}
      {split.body.length > 0 ? <MessageBodyText text={split.body} /> : null}
    </>
  );
}

/**
 * The text of a bubble, clamped past a few lines with a mask fade and a toggle
 * that names what it reveals (`shouldClampUserMessage`). With `onShowFull` the
 * text it holds is not the whole of it (a prompt the wire cut): it stays
 * clamped, and the one toggle reads the whole elsewhere instead of unclamping
 * a cut text as if it were whole.
 */
function ClampedBubbleText({
  text,
  showLabel,
  onShowFull,
  mono = false,
  quotes = false
}: {
  text: string;
  showLabel: string;
  onShowFull?: (() => void) | undefined;
  /** Code, not prose: a workflow's script. */
  mono?: boolean;
  /** The user's own message: blockquotes it opens with show as quotes (`QuotedBodyText`). */
  quotes?: boolean;
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  const clampable = onShowFull !== undefined || shouldClampUserMessage(text);
  const clamped = clampable && (onShowFull !== undefined || !expanded);
  return (
    <>
      <div
        className={cn(
          "whitespace-pre-wrap [overflow-wrap:anywhere]",
          mono ? "font-mono text-xs leading-normal" : "text-sm leading-relaxed",
          clamped &&
            "max-h-44 overflow-hidden [mask-image:linear-gradient(to_bottom,black_calc(100%-1.75rem),transparent)]"
        )}
      >
        {quotes && !mono ? <QuotedBodyText text={text} /> : <MessageBodyText text={text} />}
      </div>
      {clampable ? (
        <button
          type="button"
          onClick={onShowFull ?? (() => setExpanded((value) => !value))}
          className="mt-1.5 rounded text-xs text-neutral-400 hover:text-neutral-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
        >
          {!clamped ? "Show less" : showLabel}
        </button>
      ) : null}
    </>
  );
}

// Adapted from T3 Code (MIT): apps/web/src/components/chat/TimelineUserMessageRow.tsx
// (`FoldedMessageHeader`, and the folded body that stays mounted for find).

/**
 * Another chat's message, folded to one line (`foldsThreadMessage`) so the user's own messages
 * stay easy to find: a button naming how and from which chat it came (the caption the open
 * bubble wears) and the body's first line, which opens the whole message in the bubble below.
 *
 * The folded body stays mounted as `hidden="until-found"`: the browser's find-in-page searches
 * it and fires `beforematch` on a hit, which opens the fold. React 18 renders `hidden` as a
 * plain boolean, so the effect upgrades the attribute.
 *
 * Opening or closing keeps the header where the user clicked it: the scroller moves by however
 * far the header moved (nothing, when the browser's own scroll anchoring already held it).
 */
function FoldedThreadMessage({
  message,
  attachments
}: {
  message: ParsedThreadMessage;
  attachments: readonly AttachmentRef[];
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  const bodyId = React.useId();
  const headerRef = React.useRef<HTMLButtonElement>(null);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const headerTopRef = React.useRef<number | null>(null);
  const caption = threadMessageCaption(message);
  const summary = React.useMemo(() => foldedMessageSummary(message.body), [message.body]);

  React.useLayoutEffect(() => {
    if (!expanded) bodyRef.current?.setAttribute("hidden", "until-found");
    const header = headerRef.current;
    const before = headerTopRef.current;
    headerTopRef.current = null;
    if (!header || before === null) return;
    const moved = header.getBoundingClientRect().top - before;
    const scroller = header.closest<HTMLElement>("[data-agent-chat-timeline]");
    if (scroller && moved !== 0) scroller.scrollTop += moved;
  }, [expanded]);

  React.useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const reveal = (): void => setExpanded(true);
    body.addEventListener("beforematch", reveal);
    return () => body.removeEventListener("beforematch", reveal);
  }, []);

  return (
    <div
      className={cn("relative min-w-0 max-w-[80%] rounded-2xl bg-neutral-800 text-neutral-100", expanded && "w-full")}
      data-from-thread={message.origin}
      data-folded={expanded ? undefined : "true"}
    >
      <AuthorHeading>Another chat</AuthorHeading>
      <button
        ref={headerRef}
        type="button"
        aria-expanded={expanded}
        aria-controls={bodyId}
        title={caption}
        onClick={() => {
          headerTopRef.current = headerRef.current?.getBoundingClientRect().top ?? null;
          setExpanded((value) => !value);
        }}
        className="flex min-h-9 w-full min-w-0 select-none items-center gap-1.5 rounded-2xl px-3 py-2 text-left text-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
      >
        <MessagesSquare size={14} strokeWidth={1.8} aria-hidden className="shrink-0 text-neutral-500" />
        <span className="max-w-[50%] shrink-0 truncate text-xs text-neutral-400">{caption}</span>
        <span className={cn("min-w-0 flex-1 truncate", summary === "" && "text-neutral-500")}>
          {summary === "" ? "No text" : summary}
        </span>
        <DisclosureChevron open={expanded} />
      </button>
      <div id={bodyId} ref={bodyRef} hidden={!expanded} className="px-3 pb-3" data-folded-body="true">
        {attachments.length > 0 ? <AttachmentChips attachments={attachments} /> : null}
        <ClampedBubbleText text={message.body} showLabel="Show full message" quotes />
      </div>
    </div>
  );
}

/**
 * The user's filled bubble (§5.1 of the design reference) — the one filled
 * bubble in the timeline, which an agent's launch prompt reuses in its drill-in
 * ({@link AgentPromptRow}): to the agent the prompt is its user turn.
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
  // The meta row is hover-revealed; while the rewind confirm is open it stays
  // shown, so the button the popover is anchored to does not fade out under it.
  const [rewindOpen, setRewindOpen] = React.useState(false);
  const text = row.message.text;
  const attachments = row.message.attachments ?? [];
  const revertTurnCount = row.revertTurnCount;
  // A fork's result sent back to this thread (spec 2026-10-14 §6): its header
  // becomes a caption, and the bubble holds the result alone.
  // Only a message Orquester marked as such (its context chip, T6-M3) — the same header typed by
  // the user is the user's own text, never another chat's.
  const markedMerge = isMergeBackMessage(row.message);
  const markedThread = isThreadAuthoredMessage(row.message);
  const merged = React.useMemo(() => (markedMerge ? parseMergeBackMessage(text) : null), [markedMerge, text]);
  // Sent, opened or delegated by another thread through a session tool (design 2026-10-14 §5), or
  // another chat's reply to this one's message (unified MCP §8.2): the provenance header the agent
  // read becomes a caption; the bubble holds the message alone.
  const fromThread = React.useMemo(() => (merged || !markedThread ? null : parseThreadMessage(text)), [merged, markedThread, text]);
  // An older build's automatic "continue" after an approved toolset card (legacy chip): Orquester's own.
  const fromOrquester = !merged && !markedThread && isToolsetContinueMessage(row.message);

  return (
    <div className="group flex flex-col items-end gap-1">
      {merged ? (
        <span className="inline-flex items-center gap-1 pe-1 text-[11px] text-neutral-500" data-merged-back="true">
          <GitMerge size={11} strokeWidth={1.8} aria-hidden />
          {mergedBackCaption(merged.relation, merged.childTitle)}
        </span>
      ) : null}
      {fromThread && foldsThreadMessage(fromThread.origin) ? (
        <FoldedThreadMessage message={fromThread} attachments={attachments} />
      ) : (
        <>
          {fromThread ? (
            <span className="inline-flex items-center gap-1 pe-1 text-[11px] text-neutral-500" data-from-thread={fromThread.origin}>
              {threadMessageCaption(fromThread)}
            </span>
          ) : null}
          <div className="relative max-w-[80%] rounded-2xl bg-neutral-800 p-3 text-neutral-100">
            {/* The chip alone says another chat sent it, even when its header is one this build no
                longer reads (an agent's scheduled task from before scheduling was removed). */}
            <AuthorHeading>{fromThread || markedThread ? "Another chat" : fromOrquester ? "Orquester" : "You"}</AuthorHeading>
            {attachments.length > 0 ? <AttachmentChips attachments={attachments} /> : null}
            <ClampedBubbleText
              text={merged ? merged.body : fromThread ? fromThread.body : text}
              showLabel="Show full message"
              quotes
            />
          </div>
        </>
      )}
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
        {!ctx.readOnly && row.forkable === true ? (
          <ForkFromHereButton
            messageId={row.message.id}
            turnId={row.message.turnId}
            role="user"
            text={text}
          />
        ) : null}
        {text.length > 0 ? <CopyButton size="micro" value={text} label="Copy message" /> : null}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// An agent's launch prompt (§7.6)
// ---------------------------------------------------------------------------

/**
 * An agent's launch prompt, heading the run it started — "its prompt at the
 * top" of a drill-in, and a relaunch's at its place (`agent-prompt.logic.ts`).
 *
 * In the user's bubble, because to the agent it IS its user turn — what it was
 * asked, verbatim — with a caption that says whose words these are not. Read-
 * only like the whole drill-in: no rewind. A long prompt clamps behind "Show
 * full prompt". One the wire cut (§5.6) offers that same ONE affordance, which
 * reads the whole prompt in the parent's viewer (titled "Prompt"; the item
 * read, as the compaction summary's "Load the full summary" does) rather than
 * unclamping the cut text, and offers no Copy of the cut text; one ingestion
 * cut at rest says only its start was kept, up to the cap it was cut at
 * (`PROMPT_CUT_AT_REST_NOTE`, naming `TASK_PROMPT_MAX_CHARS`) — no read of its
 * start row holds the rest.
 */
export const AgentPromptRow = React.memo(function AgentPromptRow({
  row,
  prompt
}: {
  row: Row<"message">;
  prompt: AgentPrompt;
}): React.ReactElement {
  const ctx = useTimelineRowContext();
  const text = row.message.text;
  // A workflow's coordinator was "prompted" with the script it runs.
  const script = prompt.script === true;
  const caption = script ? "Workflow script" : "Prompt";
  return (
    <div className="group flex flex-col items-end gap-1" data-agent-prompt="true">
      <span className="pe-1 text-[11px] text-neutral-500">{caption}</span>
      <div
        className={cn(
          "relative rounded-2xl bg-neutral-800 p-3 text-neutral-100",
          script ? "w-full" : "max-w-[80%]"
        )}
      >
        <AuthorHeading>{caption}</AuthorHeading>
        <ClampedBubbleText
          text={text}
          mono={script}
          showLabel={script ? "Show full script" : "Show full prompt"}
          // Cut on the wire: its one "Show full prompt" reads the whole prompt
          // in the parent's viewer, never unclamps the cut text.
          onShowFull={prompt.truncated ? () => ctx.onLoadFullOutput(prompt.itemId, "prompt") : undefined}
        />
        {prompt.cutAtRest ? (
          <p className="mt-1.5 text-xs text-neutral-400">{PROMPT_CUT_AT_REST_NOTE}</p>
        ) : null}
      </div>
      <div className="ac-reveal ac-tabular flex w-full max-w-[80%] items-center justify-end gap-2 pe-1 text-xs">
        <span className="text-neutral-500" title={formatRowTimestampTooltip(row.createdAt)}>
          {formatRowTimestamp(row.createdAt)}
        </span>
        {!prompt.truncated && text.length > 0 ? (
          <CopyButton size="micro" value={text} label={script ? "Copy script" : "Copy prompt"} />
        ) : null}
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
 * Codex commentary is the narration between tool calls. It remains a visible
 * message while the turn runs and after the history is reloaded.
 *
 * Streaming is the row's `streaming` — the rule's answer, never the message's
 * bare flag, which a dead host leaves `true` for good (`isMessageStreaming`).
 */
export const AssistantMessageRow = React.memo(function AssistantMessageRow({
  row
}: {
  row: Row<"message">;
}): React.ReactElement {
  noteRender("AssistantMessageRow");
  const ctx = useTimelineRowContext();
  const streaming = row.streaming === true;
  const text = row.message.text || (streaming ? "" : "(empty response)");
  return (
    <div className="group/assistant relative min-w-0 px-1 py-0.5">
      <AuthorHeading>Agent</AuthorHeading>
      {/* The body a selection may be quoted from (`QuoteSelectionToolbar`) —
          the reply's own text, never the placeholder for an empty one. */}
      <div {...(row.message.text ? { [QUOTE_SOURCE_ATTR]: row.message.id } : {})}>
        <ChatMarkdown
          text={text}
          streaming={streaming}
          onOpenFile={ctx.onOpenFile}
        />
      </div>
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
      <ForkFromHereButton
        messageId={row.message.id}
        turnId={row.message.turnId}
        role="assistant"
        text={row.message.text}
      />
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
 *
 * "Thinking" and its shimmer are the row's `streaming`, never the message's
 * bare flag: a subagent's words no turn carried stayed `streaming: true` for
 * good, thousands to a thread, and each shimmered in its drill-in forever.
 */
export const ReasoningRow = React.memo(function ReasoningRow({
  row
}: {
  row: Row<"message">;
}): React.ReactElement {
  const ctx = useTimelineRowContext();
  const id = row.message.id;
  const text = row.message.text;
  const live = row.streaming === true;
  const summary = firstLine(text);
  // Codex can emit an empty reasoning item. Keep its one-line status, while
  // every nonempty trace can open even when it has only one long line.
  const canExpand = text.trim().length > 0;
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
        <div className="ms-7 mt-1 max-h-96 overflow-auto select-text text-sm leading-relaxed text-neutral-400">
          <ChatMarkdown text={text} onOpenFile={ctx.onOpenFile} />
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
            <QuotedBodyText text={text} />
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
