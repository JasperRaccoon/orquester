/**
 * The subagent drill-in (§7.6).
 *
 * Clicking a roster row swaps the **main area** — not the whole view — to that
 * agent's own timeline: its prompt at the top, then its items filtered by
 * `agentId`, streaming live, rendered with the same row components, read-only,
 * with a breadcrumb and Escape back to main.
 *
 * Two constraints shape the component:
 *
 *  - **It must not remount the parent.** The composer and the roster stay
 *    mounted around it so the parent thread can still be steered while the
 *    user watches a child, which is why this renders only the scrolling area
 *    and takes `onBack` rather than owning any navigation.
 *  - **The child view dispatches no commands.** Every timeline callback here
 *    is inert: there is no revert, no approval and no queue inside a child.
 *    The one exception is opening a file, which is navigation, not a command —
 *    and even that is left to the parent through props we do not have, so it
 *    is a no-op here too.
 *
 * §7.2's rule holds on the way in: items stamped with an `agentId` never
 * render in the parent timeline, they are re-homed here. **Both halves come
 * from W11's `useAgentChatDrillIn`**, which projects them off the *parent's*
 * slice — so the child streams live without opening a second stream, and the
 * parent's composer and roster keep their state. On OpenCode and Grok the
 * surface shows whatever their protocols report and nothing more; when a
 * provider reports a task but no per-agent items, the timeline says so rather
 * than this view inventing lineage.
 *
 * **A background shell is the one exception** (§7.6). Its rows are projected
 * here, by `background-shell.ts`, because the shared projection applies the
 * quiet-timeline filter a second time inside the child's own view and drops
 * every row the shell owns — the drill-in then claimed the shell had reported
 * nothing while it was printing. They also open themselves: a shell's output
 * is the reason its row was clicked.
 *
 * Escape is **not** bound here: the app has one window-level key listener
 * (AGENTS.md), and the view that owns the drill-in state owns the key that
 * closes it. This component's own affordance is the breadcrumb's Back.
 *
 * *T3 has no equivalent: its rows are not clickable and there is no per-agent
 * timeline (`AgentsPanel.tsx:139-140`, "Flat, non-interactive agent status
 * line. No unfold."). The closest thing is an "Open Agents panel ›" link
 * (`MessagesTimeline.tsx:4654-4660`). This surface is new.*
 */

import React from "react";
import { ArrowLeft, Bot, Terminal } from "lucide-react";
import type { ThreadItem } from "@orquester/api/agent-chat";
import { cn } from "../../../lib/cn";
import type { DisclosureState } from "../../../lib/agent-chat/contracts";
import { useAgentChatDrillIn } from "../../../lib/agent-chat/hooks";
import { peekThreadStore } from "../../../lib/agent-chat/store";
import type { AgentDrillInProps } from "../contracts";
import { ChatTimeline } from "../timeline/ChatTimeline";
import { ElapsedTicker, StatusDot } from "../primitives";
import { backgroundShellDisclosureIds, backgroundShellRows } from "./background-shell";
import { agentActivityText, rosterRowMetrics } from "./format";
import { isBackgroundShellRow, rosterRowTicks, rosterStatusVisual } from "./roster-rows";

const EMPTY_DISCLOSURES: DisclosureState = {
  expandedTurnIds: [],
  expandedGroupIds: [],
  expandedAgentIds: [],
  expandedReasoningIds: [],
  toolOutputOffsets: {}
};

const EMPTY_ITEMS: readonly ThreadItem[] = [];

const EMPTY_ROW_IDS: readonly string[] = [];

const noop = (): void => {};

/**
 * The thread's own items, live.
 *
 * Only a background shell needs them: its rows come from this component's own
 * projection (see `background-shell.ts`), not from the shared drill-in one.
 * `peekThreadStore` never creates a slice — `useAgentChatDrillIn` has already
 * ensured it during this same render, and a host without one (a static render
 * check) simply reads as an empty thread.
 */
function useThreadItems(sessionId: string, enabled: boolean): readonly ThreadItem[] {
  const store = enabled ? peekThreadStore(sessionId) : null;
  const subscribe = React.useCallback(
    (onChange: () => void) => (store === null ? noop : store.subscribe(onChange)),
    [store]
  );
  const read = React.useCallback(
    () => (store === null ? EMPTY_ITEMS : store.getState().slice.entries),
    [store]
  );
  return React.useSyncExternalStore(subscribe, read, read);
}

export function AgentDrillIn({
  sessionId,
  agentId,
  agent: agentOverride,
  rows: rowsOverride,
  onBack,
  roster,
  projectPath
}: AgentDrillInProps): React.ReactElement {
  const [disclosures, setDisclosures] = React.useState<DisclosureState>(EMPTY_DISCLOSURES);
  const live = useAgentChatDrillIn(sessionId, agentId, disclosures);
  const agent = agentOverride ?? live.agent;
  const background = agent !== null && isBackgroundShellRow(agent);

  // A shell's own rows are projected here rather than by the shared drill-in
  // hook, which applies the quiet-timeline filter a second time and drops
  // them. See `background-shell.ts`.
  const items = useThreadItems(sessionId, background);
  const shellRows = React.useMemo(
    () => (background ? backgroundShellRows(items, agentId) : null),
    [background, items, agentId]
  );
  // The hook is the source; the props are an override for a host that already
  // holds the projection (and for tests, which have no store).
  const rows = rowsOverride ?? shellRows ?? live.rows;

  // A shell's rows open THEMSELVES: the output is the whole reason the row was
  // clicked, and one more click to reach it is the bug this fixes. Seeded by
  // derivation rather than by an effect, so a row is open on the very first
  // paint — a chunk that arrives before an effect could run must not flash a
  // collapsed row — and so the opening survives a remount.
  const shellRowIds = React.useMemo(
    () => (background ? backgroundShellDisclosureIds(rows) : EMPTY_ROW_IDS),
    [background, rows]
  );
  /** Default-open rows the user closed; they stay closed as output keeps coming. */
  const [collapsedShellRowIds, setCollapsedShellRowIds] =
    React.useState<readonly string[]>(EMPTY_ROW_IDS);

  const onDisclosureChange = React.useCallback(
    (patch: Partial<DisclosureState>) => {
      const groups = patch.expandedGroupIds;
      if (groups !== undefined && shellRowIds.length > 0) {
        // The timeline patches the WHOLE list, so a default-open id missing
        // from it is one the user just collapsed — and one that reappears was
        // re-opened.
        setCollapsedShellRowIds(shellRowIds.filter((id) => !groups.includes(id)));
      }
      setDisclosures((current) => ({ ...current, ...patch }));
    },
    [shellRowIds]
  );

  const timelineDisclosures = React.useMemo<DisclosureState>(() => {
    const open = shellRowIds.filter(
      (id) => !collapsedShellRowIds.includes(id) && !disclosures.expandedGroupIds.includes(id)
    );
    return open.length === 0
      ? disclosures
      : { ...disclosures, expandedGroupIds: [...disclosures.expandedGroupIds, ...open] };
  }, [collapsedShellRowIds, disclosures, shellRowIds]);

  const visuals = agent ? rosterStatusVisual(agent.status) : null;
  const Icon = background ? Terminal : Bot;
  // The agent's prompt is the task description the provider reported: the
  // live/settled precedence of the roster's own activity line, so a settled
  // child leads with its outcome here too. A shell's description is its title
  // (the Bash call's own `description`), and the header already carries its
  // state twice — the status chip and the metrics line — so the prompt block
  // is the one place the full, untruncated description can live.
  const description = background ? (agent?.title.trim() ?? "") : "";
  const activity = agent ? agentActivityText(agent) : null;
  const prompt =
    background && description.length > 0 && description !== agentId ? description : activity;
  // The chip reads the shell's own state word — "Running", "Exited with code
  // 0" — rather than the agent vocabulary ("Working", "Completed"), which is
  // the same string its roster row shows. The DOT keeps the status colour and
  // the pulse: those are the roster's semantics and do not change for a shell.
  const statusText = (background ? activity : null) ?? visuals?.label ?? "";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-neutral-950" data-agent-drill-in={agentId}>
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-neutral-800 px-2">
        <button
          type="button"
          onClick={onBack}
          className={cn(
            "ac-press inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-xs",
            "text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
          )}
        >
          <ArrowLeft size={12} aria-hidden />
          <span>Back</span>
        </button>
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-xs">
          <span className="shrink-0 text-neutral-500">Agents</span>
          <span aria-hidden className="shrink-0 text-neutral-600">/</span>
          <Icon size={13} strokeWidth={1.8} aria-hidden className="shrink-0 text-neutral-500" />
          <span className="min-w-0 truncate font-medium text-neutral-200">
            {agent?.title ?? agentId}
          </span>
        </nav>
        {agent && visuals ? (
          <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px] text-neutral-500">
            <StatusDot tone={visuals.tone} size="xs" pulse={visuals.pulse} label={statusText} />
            <span>{statusText}</span>
            <ElapsedTicker
              startedAt={agent.startedAt}
              endedAt={agent.completedAt}
              live={rosterRowTicks(agent.status)}
            />
          </span>
        ) : null}
      </header>

      {agent ? (
        <div className="shrink-0 border-b border-neutral-800 px-3 py-2 sm:px-5">
          <div className="mx-auto w-full max-w-3xl">
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-neutral-300">
              {prompt ?? visuals?.label ?? ""}
            </p>
            <p className="ac-tabular mt-1 truncate font-mono text-[11px] text-neutral-500">
              {rosterRowMetrics(agent).join(" · ")}
            </p>
          </div>
        </div>
      ) : (
        // The roster dropped the row (retention, or a host restart) while its
        // items are still in the thread. Say so, and keep showing them.
        <div className="shrink-0 border-b border-neutral-800 px-3 py-2 sm:px-5">
          <p className="mx-auto w-full max-w-3xl text-sm italic text-neutral-600">
            This agent is no longer in the thread&apos;s roster.
          </p>
        </div>
      )}

      <ChatTimeline
        sessionId={sessionId}
        // `agentId` is what makes the timeline a child view: W12 forces
        // read-only from it, and we say so explicitly as well. It also owns
        // the empty state, so there is no second "nothing here yet" surface.
        agentId={agentId}
        readOnly
        roster={roster}
        projectPath={projectPath}
        rows={rows}
        follow
        onFollowChange={noop}
        disclosures={timelineDisclosures}
        onDisclosureChange={onDisclosureChange}
        bottomInset={0}
        canRevert={false}
        onRevert={noop}
        onOpenTurnDiff={noop}
        onOpenFile={noop}
        onLoadFullOutput={noop}
        onOpenAgent={noop}
        onSendQueuedNow={noop}
        onReturnQueuedToComposer={noop}
        errorBanner={null}
        onDismissErrorBanner={noop}
      />
    </div>
  );
}

export default AgentDrillIn;
