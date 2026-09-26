/**
 * The subagent drill-in (§7.6).
 *
 * Clicking a roster row swaps the **main area** — not the whole view — to that
 * agent's own timeline: its prompt at the top (the first row of the scroll,
 * from its launch's `task.started`, `agent-prompt.logic.ts`), then its items
 * filtered by `agentId`, streaming live, rendered with the same row
 * components, read-only, with a breadcrumb and Escape back to main. Under the
 * breadcrumb, one fixed line says what it is doing now, or how it ended.
 *
 * Two constraints shape the component:
 *
 *  - **It must not remount the parent.** The composer and the roster stay
 *    mounted around it so the parent thread can still be steered while the
 *    user watches a child, which is why this renders only the scrolling area
 *    and takes `onBack` rather than owning any navigation. They float over it
 *    as they float over the thread's own timeline, so it takes the view's
 *    `bottomInset` too.
 *  - **The child view dispatches no commands.** Every command callback here
 *    is inert: there is no revert, no approval and no queue inside a child.
 *    Navigation and reads are no commands, and pass the parent's own handlers
 *    through (`drill-in-callbacks.ts`): opening a file a child's words link to
 *    (`onOpenFile`), reading a call's whole output in the parent's viewer
 *    (`onLoadFullOutput`) — an agent's window keeps 200 rows, and a long
 *    command's output outlives them — and opening an agent the child launched
 *    from its spawn row (`onOpenAgent`), which switches this view to it.
 *
 * §7.2's rule holds on the way in: items stamped with an `agentId` never
 * render in the parent timeline, they are re-homed here. **Both halves come
 * from W11's `useAgentChatDrillIn`**, which projects them off the *parent's*
 * slice — so the child streams live without opening a second stream, and the
 * parent's composer and roster keep their state. **That projection is the one
 * the timeline renders**: `ChatTimeline` takes the rows handed to it and
 * projects nothing of its own. On OpenCode and Grok the surface shows whatever
 * their protocols report and nothing more; when a provider reports a task but
 * no per-agent items, the timeline says so rather than this view inventing
 * lineage.
 *
 * **A background shell is the one exception** (§7.6). Its drill-in is ONE
 * row, its command with every chunk it printed, projected here by
 * `background-shell.ts` — the hook projects nothing for a shell — because the
 * shared projection would fold it behind a turn fold per turn its chunks rode
 * and cap its output pane like any conversation's tool row. Its rows also open
 * themselves: a shell's output is the reason its row was clicked.
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
import { ArrowLeft, Terminal } from "lucide-react";
import { cn } from "../../../lib/cn";
import type { AgentChatTimelineRow, DisclosureState } from "../../../lib/agent-chat/contracts";
import { collapsedTurnsAfter } from "../../../lib/agent-chat/drill-in.logic";
import { useAgentChatDrillIn } from "../../../lib/agent-chat/hooks";
import type { AgentDrillInProps, TimelineScrollPosition } from "../contracts";
import { ChatTimeline } from "../timeline/ChatTimeline";
import { ElapsedTicker, StatusDot } from "../primitives";
import { backgroundShellDisclosureIds, backgroundShellRows } from "./background-shell";
import { drillInTimelineCallbacks } from "./drill-in-callbacks";
import { drillInOpening } from "./drill-in-memory";
import { rosterRowIcon } from "./AgentRosterRow";
import { agentActivityText, rosterRowMetrics } from "./format";
import { isBackgroundShellRow, rosterRowTicks, rosterRowVisual } from "./roster-rows";

const EMPTY_ROWS: AgentChatTimelineRow[] = [];

const EMPTY_ROW_IDS: readonly string[] = [];

const noop = (): void => {};

export function AgentDrillIn({
  sessionId,
  agentId,
  agent: agentOverride,
  rows: rowsOverride,
  onBack,
  bottomInset,
  roster,
  projectPath,
  onLoadFullOutput,
  onOpenFile,
  onOpenAgent,
  errorBanner = null,
  onDismissErrorBanner,
  remembered = null,
  onRemember,
  skills
}: AgentDrillInProps): React.ReactElement {
  // Opened once, from what the host remembered of THIS agent: the host keys
  // this component by the agent, so A → B mounts B from B's own entry
  // (`drill-in-memory.ts`) and nothing of A's carries over.
  const [opening] = React.useState(() => drillInOpening(remembered));
  const [disclosures, setDisclosures] = React.useState<DisclosureState>(opening.disclosures);
  // Live-follow for the child's own list (§7.3): armed on entry, disarmed by
  // the user's scroll, re-armed by the band at the end or the pill. The
  // parent's flag lives in its slice, and a child's list is not the thread's,
  // so it is kept here. Pinned to `true` with every change dropped, each
  // streamed row pulled a reader back down and the pill never showed. Off
  // when the agent reopens where the reader left it mid-list, or the first
  // re-pin would carry the list to its end over the restore.
  const [follow, setFollow] = React.useState(opening.follow);
  /**
   * Turn folds the user closed. Folds start open — the child's rows are why
   * the view was opened — so what is kept is what was closed, as for a
   * shell's rows below, and a collapse sticks as the agent keeps working.
   */
  const [collapsedTurnIds, setCollapsedTurnIds] = React.useState<readonly string[]>(opening.collapsedTurnIds);
  const projectionDisclosures = React.useMemo(
    () => ({ expandedGroupIds: disclosures.expandedGroupIds, collapsedTurnIds }),
    [disclosures.expandedGroupIds, collapsedTurnIds]
  );
  const live = useAgentChatDrillIn(sessionId, agentId, {
    disclosures: projectionDisclosures,
    agent: agentOverride
  });
  const agent = live.agent;
  const background = agent !== null && isBackgroundShellRow(agent);

  // A shell's own rows are projected here — the hook projects nothing for a
  // shell (`live.rows` is null) — because its drill-in is one row, its
  // command, and the shared projection would fold it behind the turn its
  // chunks rode. See `background-shell.ts`. The shell's roster title names its
  // row once no frame of its call is left to name it.
  const shellTitle = agent?.title;
  const shellRows = React.useMemo(
    () =>
      live.rows === null && rowsOverride === undefined
        ? backgroundShellRows(live.items, agentId, shellTitle)
        : null,
    [live.rows, live.items, rowsOverride, agentId, shellTitle]
  );
  // The hook is the source, and the ONLY projection: the timeline renders
  // these rows as they are. The prop overrides it for a host that already
  // holds the rows (and for tests, which have no store).
  const rows = rowsOverride ?? live.rows ?? shellRows ?? EMPTY_ROWS;

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
  const [collapsedShellRowIds, setCollapsedShellRowIds] = React.useState<readonly string[]>(
    opening.collapsedShellRowIds
  );

  // The host's memory of this agent, kept current: every change of what is
  // open and of the follow, and every published reading position. Memory
  // only — a drill-in never writes the thread's §7.2 LRU.
  const position = React.useRef(opening.position);
  const latest = React.useRef({ disclosures, collapsedTurnIds, collapsedShellRowIds, follow });
  latest.current = { disclosures, collapsedTurnIds, collapsedShellRowIds, follow };
  const remember = React.useCallback(() => {
    onRemember?.(agentId, { ...latest.current, position: position.current });
  }, [agentId, onRemember]);
  React.useEffect(remember, [disclosures, collapsedTurnIds, collapsedShellRowIds, follow, remember]);
  const onScrollPositionChange = React.useCallback(
    (next: TimelineScrollPosition) => {
      position.current = next;
      remember();
    },
    [remember]
  );

  const openTurnIds = live.openTurnIds;
  const onDisclosureChange = React.useCallback(
    (patch: Partial<DisclosureState>) => {
      const { expandedTurnIds: turns, ...rest } = patch;
      if (turns !== undefined) {
        // The timeline patches the WHOLE open list it was handed: the fold it
        // is missing was just closed, and a closed one it names was reopened.
        setCollapsedTurnIds((current) => collapsedTurnsAfter(current, openTurnIds, turns));
      }
      const groups = rest.expandedGroupIds;
      if (groups !== undefined && shellRowIds.length > 0) {
        // The timeline patches the WHOLE list, so a default-open id missing
        // from it is one the user just collapsed — and one that reappears was
        // re-opened.
        setCollapsedShellRowIds(shellRowIds.filter((id) => !groups.includes(id)));
      }
      if (Object.keys(rest).length > 0) {
        setDisclosures((current) => ({ ...current, ...rest }));
      }
    },
    [openTurnIds, shellRowIds]
  );

  const timelineDisclosures = React.useMemo<DisclosureState>(() => {
    const open = shellRowIds.filter(
      (id) => !collapsedShellRowIds.includes(id) && !disclosures.expandedGroupIds.includes(id)
    );
    return {
      ...disclosures,
      // The folds open now: the projection's, which every toggle patches.
      expandedTurnIds: openTurnIds as string[],
      ...(open.length === 0 ? {} : { expandedGroupIds: [...disclosures.expandedGroupIds, ...open] })
    };
  }, [collapsedShellRowIds, disclosures, openTurnIds, shellRowIds]);

  // Navigation and reads are the host's; every command is inert (§7.6).
  const callbacks = React.useMemo(
    () => drillInTimelineCallbacks({ onOpenFile, onLoadFullOutput, onOpenAgent }),
    [onOpenFile, onLoadFullOutput, onOpenAgent]
  );

  const visuals = agent ? rosterRowVisual(agent) : null;
  const Icon = background ? Terminal : rosterRowIcon(agent ?? { kind: "subagent" });
  // The line under the breadcrumb: what the agent is doing now, or how it
  // ended — the roster's own activity line, live/settled precedence and all.
  // Its prompt is not here: that is the first row of the scroll, where a
  // prompt of any length has room (`agent-prompt.logic.ts`). A shell's line
  // is its description, its title (the Bash call's own `description`): the
  // header already carries its state twice — the status chip and the
  // metrics line. ONE line, whatever it says, with the whole of it as the
  // tooltip: a line that wrapped as the activity changed moved every row
  // below it.
  const description = background ? (agent?.title.trim() ?? "") : "";
  const activity = agent ? agentActivityText(agent) : null;
  const line =
    (background && description.length > 0 && description !== agentId ? description : activity) ??
    visuals?.label ??
    "";
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
            <p className="truncate text-sm leading-relaxed text-neutral-300" title={line}>
              {line}
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
        skills={skills}
        rows={rows}
        follow={follow}
        onFollowChange={setFollow}
        // Where the reader left this agent, restored on mount; published back
        // into the host's memory, never the thread's LRU.
        scroll={opening.position}
        onScrollPositionChange={onScrollPositionChange}
        disclosures={timelineDisclosures}
        onDisclosureChange={onDisclosureChange}
        bottomInset={bottomInset}
        {...callbacks}
        // The thread's banner: the overlay's commands fail through it, and it
        // is on screen whichever timeline the main area shows.
        errorBanner={errorBanner}
        onDismissErrorBanner={onDismissErrorBanner ?? noop}
      />
    </div>
  );
}

export default AgentDrillIn;
