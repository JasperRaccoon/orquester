import React from "react";
import { ChevronsDown, RotateCw } from "lucide-react";

import {
  checkpointRewindPrompt,
  filterCheckpointsBySearch,
  promptCheckpoint,
  type CheckpointEntry
} from "../../../lib/prompt-history/checkpoints.logic";
import {
  PromptIndexCaches,
  useIsGitRepo,
  usePromptHistory,
  usePromptIndexCache,
  useAutoLoadsOlder
} from "../../../lib/prompt-history/hooks";
import { fillWantsOlder } from "../../../lib/prompt-history/index-cache";
import {
  filterPromptsBySearch,
  foldSearchText,
  matchesSearchTerms,
  searchTermsOf,
  type HistoryPrompt
} from "../../../lib/prompt-history/prompts.logic";
import { promptRewindTarget, rewindBusyReason } from "../../../lib/prompt-history/rewind.logic";
import { TurnDiffModal, type TurnDiffRequest } from "../../agent-chat/timeline/TurnDiffModal";
import { useComposerSending } from "../../agent-chat/composer/use-composer-sending";
import { RailEmptyState, RailSearchInput, RailSegmented, type RailSegmentOption } from "../primitives";
import type { RightRailPanelProps } from "../types";
import { CheckpointCard } from "./CheckpointCard";
import {
  CHECKPOINTS_HINT,
  indexViewOf,
  LIST_RENDER_STEP,
  NO_CHAT_TITLE,
  NO_CHECKPOINTS_TITLE,
  NO_PROMPTS_HINT,
  NO_PROMPTS_TITLE,
  noMatchTitle,
  NOT_A_REPO_HINT,
  SEARCH_OLDER_HINT,
  SEARCH_PLACEHOLDER,
  SEARCHING_OLDER,
  showMoreLabel,
  type IndexView
} from "./history-format";
import { Spinner } from "./HistoryParts";
import { PromptCard } from "./PromptCard";
import { TurnDiffInline } from "./TurnDiffInline";

/**
 * History & checkpoints — the right rail's second panel.
 *
 * **Prompts**: every prompt of the visible chat, newest first — what the chat
 * has loaded (whole, live) and, below it, what the host's index adds, page by
 * page. Each one can be reused exactly as a saved prompt (Insert / Send),
 * saved as one, shown in the chat, its turn's diff opened, and the chat
 * rewound to it.
 *
 * **Checkpoints**: every turn a git project captured, newest first — the files
 * it changed, its diff, and "Rewind to here" on the prompt that started it.
 * Browse and rewind only: the rewind is the existing conversation-only one,
 * and files are never touched.
 *
 * Fills its container (`flex min-h-0 flex-1 flex-col`) and scrolls its own
 * list under the fixed search and switch. The list mounts
 * {@link LIST_RENDER_STEP} cards at a time: a search that paged thousands of
 * prompts in must not mount thousands of cards.
 */

type HistoryView = "prompts" | "checkpoints";

const VIEW_OPTIONS: readonly RailSegmentOption<HistoryView>[] = [
  { id: "prompts", label: "Prompts", title: "The prompts of this chat" },
  { id: "checkpoints", label: "Checkpoints", title: "The file changes each turn captured" }
];

export const PromptHistoryPanel: React.FC<RightRailPanelProps> = ({
  sessionId,
  projectPath,
  variant,
  onDelivered
}) => {
  // Held for as long as the panel lives, across chats: the index pages a chat
  // fetched are reused when the user comes back to it.
  const [caches] = React.useState(() => new PromptIndexCaches());
  const [query, setQuery] = React.useState("");
  const [view, setView] = React.useState<HistoryView>("prompts");

  if (sessionId === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-history-panel="">
        <RailEmptyState title={NO_CHAT_TITLE} />
      </div>
    );
  }
  return (
    <SessionHistory
      // One chat's state — the open card, a diff, a confirm — never carries
      // over to the next.
      key={sessionId}
      sessionId={sessionId}
      projectPath={projectPath}
      variant={variant}
      onDelivered={onDelivered}
      caches={caches}
      query={query}
      onQueryChange={setQuery}
      view={view}
      onViewChange={setView}
    />
  );
};

interface SessionHistoryProps extends Omit<RightRailPanelProps, "sessionId"> {
  sessionId: string;
  caches: PromptIndexCaches;
  query: string;
  onQueryChange: (query: string) => void;
  view: HistoryView;
  onViewChange: (view: HistoryView) => void;
}

/** An open turn diff, and the button that opened it — the keyboard's way back. */
interface OpenDiff {
  request: TurnDiffRequest;
  trigger: HTMLElement | null;
}

function SessionHistory({
  sessionId,
  projectPath,
  variant,
  onDelivered,
  caches,
  query,
  onQueryChange,
  view,
  onViewChange
}: SessionHistoryProps): React.ReactElement {
  const cache = usePromptIndexCache(caches);
  const model = usePromptHistory(cache, sessionId);
  const [expandedPrompt, setExpandedPrompt] = React.useState<string | null>(null);
  const [expandedCheckpoint, setExpandedCheckpoint] = React.useState<string | null>(null);
  const [diff, setDiff] = React.useState<OpenDiff | null>(null);
  // How many cards are mounted — per list: a new search, or the other view,
  // starts from the first {@link LIST_RENDER_STEP} again.
  const listKey = `${view}\u0000${query}`;
  const [shown, setShown] = React.useState({ key: listKey, limit: LIST_RENDER_STEP });
  const renderLimit = shown.key === listKey ? shown.limit : LIST_RENDER_STEP;

  const terms = React.useMemo(() => searchTermsOf(query), [query]);
  const searching = view === "prompts" && terms.length > 0;
  // A search covers the whole thread, and the list is never left with a short
  // page and more behind it: the older index pages come in on their own.
  useAutoLoadsOlder(cache, sessionId, model.index, searching);
  const visiblePrompts = React.useMemo(
    () => filterPromptsBySearch(model.prompts, query),
    [model.prompts, query]
  );
  const visibleCheckpoints = React.useMemo(
    () =>
      terms.length === 0
        ? model.checkpoints
        : filterCheckpointsBySearch(model.checkpoints, (text) =>
            matchesSearchTerms(foldSearchText(text), terms)
          ),
    [model.checkpoints, terms]
  );

  // A composer send in flight holds a rewind back, as the composer's picker does.
  const sending = useComposerSending(sessionId);
  const busyReason = rewindBusyReason({ ...model.thread.busy, isSending: sending });
  const indexView = indexViewOf(model.index, { searching });
  const threadLoading = !model.thread.hasHead;
  const gitRepo = useIsGitRepo(
    model.thread.cwd ?? projectPath,
    view === "checkpoints" && !threadLoading && model.checkpoints.length === 0
  );

  const togglePrompt = React.useCallback(
    (messageId: string) => setExpandedPrompt((current) => (current === messageId ? null : messageId)),
    []
  );
  const toggleCheckpoint = React.useCallback(
    (key: string) => setExpandedCheckpoint((current) => (current === key ? null : key)),
    []
  );
  const openDiff = React.useCallback(
    (turnCount: number, title: string, trigger: HTMLElement | null) =>
      setDiff({ request: { sessionId, turnCount, title }, trigger }),
    [sessionId]
  );
  // Closing hands the keyboard back to the "View diff" that opened it — the
  // list under the sheet's diff stayed mounted, so that button is still there.
  const returnFocus = React.useRef<HTMLElement | null>(null);
  const diffRef = React.useRef(diff);
  diffRef.current = diff;
  const closeDiff = React.useCallback(() => {
    returnFocus.current = diffRef.current?.trigger ?? null;
    setDiff(null);
  }, []);
  React.useEffect(() => {
    if (diff !== null) return;
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target !== null && target.isConnected) target.focus({ preventScroll: true });
  }, [diff]);
  const onRewound = React.useCallback(() => {
    setExpandedPrompt(null);
    setExpandedCheckpoint(null);
  }, []);
  // On the phone the sheet covers the chat: a jump or a rewind that lands
  // there is the moment it steps aside — through the same door an Insert or a
  // Send closes it by. Docked beside the chat, nothing needs to move.
  const onLeave = variant === "sheet" ? onDelivered : undefined;
  const loadOlder = React.useCallback(() => cache.loadOlder(sessionId), [cache, sessionId]);
  const retry = React.useCallback(() => cache.retry(sessionId), [cache, sessionId]);
  const showMore = React.useCallback(
    () => setShown({ key: listKey, limit: renderLimit + LIST_RENDER_STEP }),
    [listKey, renderLimit]
  );

  const renderPrompt = (prompt: HistoryPrompt) => (
    <PromptCard
      key={prompt.messageId}
      prompt={prompt}
      variant={variant}
      expanded={expandedPrompt === prompt.messageId}
      onToggle={togglePrompt}
      sessionId={sessionId}
      projectPath={projectPath}
      cache={cache}
      checkpoint={promptCheckpoint(prompt, model.checkpointByTurnId)}
      rewindTarget={promptRewindTarget({
        prompt,
        facts: model.thread.rewind,
        rollbackSupported: model.rollbackSupported
      })}
      rewindBusyReason={busyReason}
      startedTurnCount={model.startedTurnCount}
      onOpenDiff={openDiff}
      jumpTo={model.jumpTo}
      rewind={model.rewind}
      onRewound={onRewound}
      onDelivered={onDelivered}
      onLeave={onLeave}
    />
  );

  const renderCheckpoint = (entry: CheckpointEntry) => {
    const opener = checkpointRewindPrompt(entry.origin);
    return (
      <CheckpointCard
        key={entry.key}
        entry={entry}
        variant={variant}
        expanded={expandedCheckpoint === entry.key}
        onToggle={toggleCheckpoint}
        rewindTarget={
          opener !== null
            ? promptRewindTarget({
                prompt: opener,
                facts: model.thread.rewind,
                rollbackSupported: model.rollbackSupported
              })
            : null
        }
        rewindBusyReason={busyReason}
        startedTurnCount={model.startedTurnCount}
        onOpenDiff={openDiff}
        rewind={model.rewind}
        onRewound={onRewound}
        onLeave={onLeave}
      />
    );
  };

  // The sheet's diff is laid over the panel: the list under it stays mounted,
  // scrolled where it was, and out of reach of the keyboard meanwhile.
  const covered = variant === "sheet" && diff !== null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-history-panel="">
      <div
        className="flex min-h-0 flex-1 flex-col"
        {...(covered ? { inert: "", "aria-hidden": true } : {})}
      >
        <div className="shrink-0 space-y-2 px-3 pb-2 pt-1">
          <RailSearchInput value={query} onChange={onQueryChange} placeholder={SEARCH_PLACEHOLDER} />
          <RailSegmented options={VIEW_OPTIONS} value={view} onChange={onViewChange} label="History view" />
        </div>
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-3">
          {view === "prompts" ? (
            <PromptsBody
              prompts={visiblePrompts}
              total={model.prompts.length}
              query={query}
              index={indexView}
              loading={
                threadLoading ||
                indexView.kind === "loading" ||
                (indexView.kind === "fallback" && indexView.busy) ||
                // Nothing listed yet, and the pages that may hold prompts are
                // still coming in: not "No prompts yet" — not yet.
                (indexView.kind === "ready" &&
                  model.prompts.length === 0 &&
                  (indexView.loadingOlder || fillWantsOlder(model.index)))
              }
              renderLimit={renderLimit}
              renderPrompt={renderPrompt}
              onShowMore={showMore}
              onLoadOlder={loadOlder}
              onRetry={retry}
            />
          ) : threadLoading ? (
            <RailEmptyState title="Loading checkpoints…" />
          ) : model.checkpoints.length === 0 ? (
            <RailEmptyState
              title={NO_CHECKPOINTS_TITLE}
              hint={gitRepo === false ? NOT_A_REPO_HINT : CHECKPOINTS_HINT}
            />
          ) : visibleCheckpoints.length === 0 ? (
            <RailEmptyState title={noMatchTitle("checkpoints", query)} />
          ) : (
            <>
              {visibleCheckpoints.slice(0, renderLimit).map(renderCheckpoint)}
              {visibleCheckpoints.length > renderLimit ? (
                <ShowMoreRow hidden={visibleCheckpoints.length - renderLimit} onShowMore={showMore} />
              ) : null}
            </>
          )}
        </div>
      </div>
      {covered ? (
        <TurnDiffInline
          request={diff.request}
          onBack={closeDiff}
          className="absolute inset-0 z-10 bg-neutral-900"
        />
      ) : null}
      {variant !== "sheet" ? <TurnDiffModal request={diff?.request ?? null} onClose={closeDiff} /> : null}
    </div>
  );
}

/** The Prompts view's list, its edges and its empty states. */
function PromptsBody({
  prompts,
  total,
  query,
  index,
  loading,
  renderLimit = LIST_RENDER_STEP,
  renderPrompt,
  onShowMore,
  onLoadOlder,
  onRetry
}: {
  /** What the search leaves, newest first. */
  prompts: readonly HistoryPrompt[];
  /** How many prompts there are before the search. */
  total: number;
  query: string;
  index: IndexView;
  /** Nothing to judge "empty" by yet: the thread's snapshot or the first page is on its way. */
  loading: boolean;
  /** How many cards are mounted; the rest wait behind "Show more". */
  renderLimit?: number;
  renderPrompt: (prompt: HistoryPrompt) => React.ReactNode;
  onShowMore: () => void;
  onLoadOlder: () => void;
  onRetry: () => void;
}): React.ReactElement {
  const note =
    index.kind === "fallback" ? (
      <FallbackNote
        note={index.note}
        busy={index.busy}
        retryable={index.retryable}
        detail={index.detail}
        onRetry={onRetry}
      />
    ) : null;
  const end = <PromptListEnd index={index} hasPrompts={total > 0} onLoadOlder={onLoadOlder} />;
  if (prompts.length === 0) {
    if (total === 0) {
      return (
        <>
          {note}
          {loading ? (
            <RailEmptyState title="Loading prompts…" />
          ) : (
            <>
              <RailEmptyState title={NO_PROMPTS_TITLE} hint={NO_PROMPTS_HINT} />
              {end}
            </>
          )}
        </>
      );
    }
    const pagingHint =
      index.kind !== "ready"
        ? undefined
        : index.autoPaging
          ? SEARCHING_OLDER
          : index.hasOlder
            ? SEARCH_OLDER_HINT
            : undefined;
    return (
      <>
        {note}
        <RailEmptyState title={noMatchTitle("prompts", query)} hint={pagingHint} />
        {end}
      </>
    );
  }
  const hidden = prompts.length - renderLimit;
  return (
    <>
      {note}
      {prompts.slice(0, renderLimit).map(renderPrompt)}
      {/* Older prompts come after every loaded one is on screen. */}
      {hidden > 0 ? <ShowMoreRow hidden={hidden} onShowMore={onShowMore} /> : end}
    </>
  );
}

/**
 * Why the list shows only what the chat has loaded — the host's index is
 * still catching up (asked again by itself), it has none, or it failed — with
 * Retry where asking again can help.
 */
function FallbackNote({
  note,
  busy,
  retryable,
  detail,
  onRetry
}: {
  note: string;
  /** The index is being asked again by itself. */
  busy: boolean;
  retryable: boolean;
  /** Why, for the tooltip. */
  detail: string | null;
  onRetry: () => void;
}): React.ReactElement {
  return (
    <p
      data-history-fallback=""
      role="status"
      title={detail ?? undefined}
      className="flex items-center gap-1.5 px-0.5 pb-0.5 text-[11px] leading-4 text-neutral-500"
    >
      {busy ? <Spinner size={11} /> : null}
      <span className="min-w-0 flex-1">{note}</span>
      {retryable ? (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex shrink-0 items-center gap-1 rounded px-1 text-neutral-400 hover:text-neutral-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
        >
          <RotateCw size={11} aria-hidden />
          Retry
        </button>
      ) : null}
    </p>
  );
}

const QUIET_BUTTON =
  "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-900 hover:text-neutral-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-neutral-500";

/**
 * The list's end: the first page on its way, a search paging the rest of the
 * thread in by itself, "Load older prompts" (once that pager has stopped — at
 * its cap or on a failure — or without a search), or why a page failed.
 */
function PromptListEnd({
  index,
  hasPrompts,
  onLoadOlder
}: {
  index: IndexView;
  hasPrompts: boolean;
  onLoadOlder: () => void;
}): React.ReactElement | null {
  if (index.kind === "loading") {
    return hasPrompts ? (
      <p className="flex items-center justify-center gap-1.5 py-2 text-[11px] text-neutral-500">
        <Spinner size={11} />
        Loading older prompts…
      </p>
    ) : null;
  }
  if (index.kind !== "ready") return null;
  if (index.autoPaging) {
    return (
      <p
        role="status"
        data-history-search-paging=""
        className="flex items-center justify-center gap-1.5 py-2 text-[11px] text-neutral-500"
      >
        <Spinner size={11} />
        {SEARCHING_OLDER}
      </p>
    );
  }
  if (!index.hasOlder) return null;
  return (
    <div data-history-load-older="" className="flex flex-col items-center gap-1 py-1.5">
      <button
        type="button"
        onClick={onLoadOlder}
        disabled={index.loadingOlder}
        aria-busy={index.loadingOlder ? true : undefined}
        className={QUIET_BUTTON}
      >
        {index.loadingOlder ? <Spinner /> : <ChevronsDown size={12} strokeWidth={1.8} aria-hidden />}
        {index.loadingOlder ? "Loading older prompts…" : "Load older prompts"}
      </button>
      {index.olderError !== null && !index.loadingOlder ? (
        <p role="alert" className="px-2 text-center text-[11px] leading-4 text-danger">
          {index.olderError}
        </p>
      ) : null}
    </div>
  );
}

/** "Show 200 more" — the next cards of a list the render cap cut. */
function ShowMoreRow({
  hidden,
  onShowMore
}: {
  hidden: number;
  onShowMore: () => void;
}): React.ReactElement {
  return (
    <div data-history-show-more="" className="flex justify-center py-1.5">
      <button type="button" onClick={onShowMore} className={QUIET_BUTTON}>
        <ChevronsDown size={12} strokeWidth={1.8} aria-hidden />
        {showMoreLabel(hidden)}
      </button>
    </div>
  );
}
