/**
 * One block of a run, in detail (spec §7.3 — the inspector in Runs mode, a
 * step's sheet on a phone): its state, timing and attempts; for an agent the
 * account decision (the pick and every skip with its reason), the hops
 * ("claude/a → usage limit (resets 22:40) → claude/b → finished"), "Working ·
 * 12m" with the latest activity line and **Open session**; a Wait block's
 * "waiting until …"; a sub-workflow's child run; then **Input | Output |
 * Error | Logs** — a JSON tree each ("Load full output" when the run carries
 * only a preview), the live log for code and shell blocks.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpRight, ChevronDown, Loader2, MessageSquare, TriangleAlert } from "lucide-react";

import type { AgentHop, WorkflowBlockRun, WorkflowNode } from "@orquester/api";

import { getRegistryIcon } from "../../../icons";
import { cn } from "../../../lib/cn";
import {
  accountText,
  agentLiveLine,
  blockElapsedMs,
  blockErrorKindLabel,
  blockInput,
  blockSkipReason,
  blockStatusView,
  blockTypeLabel,
  formatClock,
  finishedHandleText,
  formatStepDuration,
  hopReasonText,
  hopsText,
  hopViaText,
  selectionText,
  skipText,
  waitLine
} from "../../../lib/workflows/run-view";
import type { WorkflowRunEntry } from "../../../lib/workflows/store";
import { JsonTree } from "./JsonTree";
import { LogViewer } from "./LogViewer";
import { focusWorkflowSession, type OpenSessionResult } from "./open-run";
import {
  errorText,
  FOCUS_RING,
  RunSectionLabel,
  StatusGlyph,
  TONE_SOFT,
  TONE_TEXT,
  type RunsVariant,
  type WorkflowRunsApi
} from "./shared";

export type BlockDetailsTab = "input" | "output" | "error" | "logs";

export interface BlockRunDetailsProps {
  api: WorkflowRunsApi;
  /** The run as the store holds it (`useWorkflowRun`). */
  entry: WorkflowRunEntry;
  nodeId: string;
  now: number;
  variant?: RunsVariant;
  /** Focus an agent block's chat tab; says whether it was still open. Default: `focusWorkflowSession`. */
  onOpenSession?: (sessionId: string) => OpenSessionResult;
  /** Open a sub-workflow block's child run. */
  onOpenRun?: (runId: string) => void;
  /** The tab to start on (else chosen by the block's state). */
  initialTab?: BlockDetailsTab;
  className?: string;
}

type FullOutput =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; value: unknown }
  | { status: "error"; error: string };

/** The tab a block opens on: its error, its live log, else its output. */
export function defaultBlockTab(
  block: WorkflowBlockRun | undefined,
  type: WorkflowNode["type"] | undefined
): BlockDetailsTab {
  const logs = type === "code" || type === "shell";
  if (!block) return "input";
  if (block.status === "failed" && block.error) return logs ? "logs" : "error";
  if (logs && (block.status === "running" || block.status === "queued")) return "logs";
  if (block.status === "pending" || block.status === "queued" || block.status === "skipped") return "input";
  return "output";
}

export const BlockRunDetails: React.FC<BlockRunDetailsProps> = ({
  api,
  entry,
  nodeId,
  now,
  variant = "docked",
  onOpenSession = focusWorkflowSession,
  onOpenRun,
  initialTab,
  className
}) => {
  const sheet = variant === "sheet";
  const runId = entry.summary.id;
  const definition = entry.detail?.definition ?? null;
  const node = definition?.nodes.find((candidate) => candidate.id === nodeId);
  const block = entry.blocks[nodeId];
  const type = node?.type ?? block?.type;
  const name = block?.name || node?.name || nodeId;
  const logs = type === "code" || type === "shell";
  const runOver = entry.summary.status !== "queued" && entry.summary.status !== "running";

  const [tab, setTab] = useState<BlockDetailsTab>(() => initialTab ?? defaultBlockTab(block, type));
  const [full, setFull] = useState<FullOutput>({ status: "idle" });
  const [sessionNote, setSessionNote] = useState<string | null>(null);

  // Another block (or run): start fresh on its own default tab.
  useEffect(() => {
    setTab(initialTab ?? defaultBlockTab(entry.blocks[nodeId], type));
    setFull({ status: "idle" });
    setSessionNote(null);
    // The block's state is read once per selection, not on every live update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, nodeId]);

  // A retried block's new attempt has a new output: a loaded whole one is stale.
  const attempt = block?.attempt ?? 0;
  useEffect(() => setFull({ status: "idle" }), [attempt]);

  const loadFull = useCallback(() => {
    setFull({ status: "loading" });
    api
      .getWorkflowNodeOutput(runId, nodeId)
      .then((response) => setFull({ status: "loaded", value: (response as { output?: unknown })?.output }))
      .catch((error: unknown) =>
        setFull({ status: "error", error: errorText(error, "The whole output could not be read.") })
      );
  }, [api, runId, nodeId]);

  const input = useMemo(
    () =>
      definition
        ? blockInput(
            {
              status: entry.summary.status,
              blocks: entry.blocks,
              takenEdges: entry.takenEdges,
              deadEdges: entry.deadEdges,
              triggerPayload: entry.detail?.triggerPayload ?? null
            },
            definition,
            nodeId
          )
        : null,
    [
      definition,
      entry.summary.status,
      entry.blocks,
      entry.takenEdges,
      entry.deadEdges,
      entry.detail?.triggerPayload,
      nodeId
    ]
  );

  const status = block?.status ?? (runOver ? "skipped" : "pending");
  const view = blockStatusView(status);
  const elapsed = blockElapsedMs(block, now);
  const maxTries = node?.retry?.maxTries;
  const tabs: BlockDetailsTab[] = [
    "input",
    "output",
    ...(block?.error ? (["error"] as const) : []),
    ...(logs ? (["logs"] as const) : [])
  ];
  const activeTab = tabs.includes(tab) ? tab : "output";

  const meta: string[] = [];
  if (block?.startedAt) meta.push(`Started ${formatClock(block.startedAt, now)}`);
  if (elapsed !== null) meta.push(formatStepDuration(elapsed));
  if (block && block.attempt > 0 && (block.attempt > 1 || (maxTries ?? 1) > 1)) {
    meta.push(maxTries ? `Attempt ${block.attempt} of ${maxTries}` : `Attempt ${block.attempt}`);
  }
  const finishedOn =
    block && (block.status === "succeeded" || block.status === "failed")
      ? finishedHandleText(node, block.handle)
      : null;
  if (finishedOn) meta.push(`Finished on ${finishedOn}`);
  const skipReason =
    status === "skipped" && definition
      ? block
        ? blockSkipReason(definition, entry.blocks, nodeId)
        : "not reached before the run ended"
      : null;

  return (
    <section aria-label={`${name} — run details`} className={cn("flex min-h-0 flex-col gap-3 p-3", className)}>
      {/* Head. */}
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          className={cn(
            "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset",
            TONE_SOFT[view.tone]
          )}
        >
          <StatusGlyph icon={view.icon} tone={view.tone} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium leading-5 text-neutral-100">{name}</h3>
          <p className="text-xs leading-5 text-neutral-500">
            {type ? blockTypeLabel(type) : "Block"} ·{" "}
            <span className={view.tone === "neutral" ? undefined : TONE_TEXT[view.tone]}>{view.label}</span>
            {block?.pinned ? " · pinned output" : ""}
          </p>
          {meta.length > 0 ? (
            <p className="text-xs leading-5 tabular-nums text-neutral-500">{meta.join(" · ")}</p>
          ) : null}
        </div>
      </div>

      {skipReason ? <p className="text-xs text-neutral-500">Did not run · {skipReason}</p> : null}

      {/* Agent. */}
      {type === "agent" && block ? (
        <AgentSection
          block={block}
          now={now}
          sheet={sheet}
          sessionNote={sessionNote}
          onOpenSession={(sessionId) => {
            const result = onOpenSession(sessionId);
            setSessionNote(
              result === "closed" ? "This session's tab is closed — its transcript is gone from this client." : null
            );
          }}
        />
      ) : null}

      {/* Wait. */}
      {type === "wait" && block?.status === "waiting" ? (
        <p className="rounded-lg border border-warn/25 bg-warn/5 px-3 py-2 text-xs text-warn">{waitLine(block, now)}</p>
      ) : null}

      {/* Sub-workflow. */}
      {type === "workflow" && block?.childRunId ? (
        <button
          type="button"
          onClick={() => onOpenRun?.(block.childRunId!)}
          disabled={!onOpenRun}
          className={cn(
            "inline-flex w-fit items-center gap-1.5 rounded-md border border-neutral-700 px-2.5 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-60",
            FOCUS_RING,
            sheet ? "h-10" : "h-7"
          )}
        >
          <ArrowUpRight size={13} aria-hidden />
          Open child run <span className="font-mono text-neutral-500">#{block.childRunId.slice(0, 8)}</span>
        </button>
      ) : null}

      {block?.warnings && block.warnings.length > 0 ? (
        <ul className="space-y-1 rounded-lg border border-warn/25 bg-warn/5 px-3 py-2">
          {block.warnings.map((warning, index) => (
            <li key={index} className="flex items-start gap-1.5 text-xs leading-5 text-warn">
              <TriangleAlert size={12} aria-hidden className="mt-[3px] shrink-0" />
              <span className="min-w-0 break-words">{warning}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Data. */}
      <div
        role="tablist"
        aria-label="Block data"
        className="flex shrink-0 items-center gap-0.5 border-b border-neutral-800"
      >
        {tabs.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            onClick={() => setTab(id)}
            className={cn(
              "-mb-px border-b-2 px-3 text-xs font-medium capitalize transition-colors",
              FOCUS_RING,
              sheet ? "h-10" : "h-8",
              activeTab === id
                ? id === "error"
                  ? "border-danger text-danger"
                  : "border-neutral-300 text-neutral-100"
                : "border-transparent text-neutral-500 hover:text-neutral-200"
            )}
          >
            {id}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
        {activeTab === "input" ? (
          input === null ? (
            <Muted>Loading the run…</Muted>
          ) : input.kind === "none" ? (
            <Muted>{runOver ? "No input reached this block." : "Nothing has reached this block yet."}</Muted>
          ) : (
            <>
              {input.from.length > 0 ? (
                <p className="pb-1.5 text-[11px] text-neutral-500">
                  {input.kind === "merge" ? "Merged from " : "From "}
                  {input.from.map((source) => source.name).join(", ")}
                  {input.truncated ? " · a preview (an upstream output is large)" : ""}
                </p>
              ) : null}
              <JsonTree
                value={input.value}
                rootLabel={input.kind === "trigger" ? "trigger" : "input"}
                rootPath={input.kind === "trigger" ? "trigger" : "input"}
                variant={variant}
              />
            </>
          )
        ) : null}

        {activeTab === "output" ? (
          <OutputPanel block={block} name={name} full={full} onLoadFull={loadFull} sheet={sheet} variant={variant} />
        ) : null}

        {activeTab === "error" && block?.error ? (
          <div className="space-y-2">
            <div className="rounded-lg border border-danger-500/30 bg-danger-500/5 px-3 py-2">
              <p className="text-xs font-medium text-danger">{blockErrorKindLabel(block.error.kind)}</p>
              <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-neutral-200">
                {block.error.message}
              </p>
            </div>
            {block.error.detail !== undefined ? (
              <JsonTree
                value={block.error.detail}
                rootLabel="detail"
                rootPath={`nodes.${name}.error.detail`}
                variant={variant}
              />
            ) : null}
          </div>
        ) : null}

        {activeTab === "logs" && logs ? (
          block && block.attempt > 0 ? (
            <LogViewer
              key={block.attempt}
              api={api}
              runId={runId}
              nodeId={nodeId}
              blockName={name}
              attempt={block.attempt}
              live={block.status === "running"}
              sizes={block.logs}
              initialStream={block.status === "failed" && (block.logs?.stderrBytes ?? 0) > 0 ? "stderr" : "stdout"}
              variant={variant}
              className="min-h-0 flex-1"
            />
          ) : (
            <Muted>
              {runOver ? "This block never ran, so it wrote no log." : "The log starts when the block runs."}
            </Muted>
          )
        ) : null}
      </div>
    </section>
  );
};

const Muted: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="rounded-lg border border-dashed border-neutral-800 px-3 py-4 text-center text-xs text-neutral-500">
    {children}
  </p>
);

const OutputPanel: React.FC<{
  block: WorkflowBlockRun | undefined;
  name: string;
  full: FullOutput;
  onLoadFull: () => void;
  sheet: boolean;
  variant: RunsVariant;
}> = ({ block, name, full, onLoadFull, sheet, variant }) => {
  if (!block || !("output" in block) || block.output === undefined) {
    const live = block && (block.status === "running" || block.status === "waiting" || block.status === "queued");
    return <Muted>{live ? "No output yet — it arrives when the block finishes." : "This block has no output."}</Muted>;
  }
  const value = full.status === "loaded" ? full.value : block.output;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5">
      {block.outputTruncated && full.status !== "loaded" ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900/60 px-2.5 py-1.5 text-xs text-neutral-400">
          <span className="min-w-0 flex-1">
            {full.status === "error" ? (
              <span className="text-danger">{full.error}</span>
            ) : (
              "A preview — the whole output is large."
            )}
          </span>
          <button
            type="button"
            onClick={onLoadFull}
            disabled={full.status === "loading"}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-neutral-700 px-2 text-neutral-200 hover:bg-neutral-800 disabled:opacity-60",
              FOCUS_RING,
              sheet ? "h-10" : "h-7"
            )}
          >
            {full.status === "loading" ? <Loader2 size={13} aria-hidden className="animate-spin" /> : null}
            {full.status === "error" ? "Try again" : "Load full output"}
          </button>
        </div>
      ) : null}
      <JsonTree
        value={value}
        rootLabel="output"
        rootPath={`nodes.${name}.output`}
        variant={variant}
        className="min-h-0 flex-1"
      />
    </div>
  );
};

const AgentSection: React.FC<{
  block: WorkflowBlockRun;
  now: number;
  sheet: boolean;
  sessionNote: string | null;
  onOpenSession: (sessionId: string) => void;
}> = ({ block, now, sheet, sessionNote, onOpenSession }) => {
  const elapsed = blockElapsedMs(block, now);
  const live =
    agentLiveLine(block, now) ??
    (elapsed !== null && (block.status === "succeeded" || block.status === "failed" || block.status === "cancelled")
      ? `${block.status === "succeeded" ? "Worked" : "Ran"} for ${formatStepDuration(elapsed)}`
      : null);
  const hops = block.hops ?? [];
  const selection = block.selection;
  const [showSkips, setShowSkips] = useState(false);
  const skips = selection?.skipped ?? [];
  return (
    <div className="space-y-3">
      {live || block.sessionId ? (
        <div
          className={cn(
            "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-3 py-2",
            block.status === "running"
              ? "bg-info/5 ring-1 ring-inset ring-info/20"
              : "bg-neutral-900/60 ring-1 ring-inset ring-neutral-800"
          )}
        >
          <div className="min-w-0 flex-1">
            {live ? (
              <p
                className={cn(
                  "text-xs font-medium tabular-nums",
                  block.status === "running"
                    ? "text-info"
                    : block.status === "waiting" || block.status === "queued"
                      ? "text-warn"
                      : "text-neutral-300"
                )}
              >
                {live}
              </p>
            ) : null}
            {block.activity && block.status === "running" ? (
              <p className="truncate text-xs leading-5 text-neutral-300" title={block.activity}>
                {block.activity}
              </p>
            ) : null}
          </div>
          {block.sessionId ? (
            <button
              type="button"
              onClick={() => onOpenSession(block.sessionId!)}
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-md bg-neutral-200 px-2.5 text-xs font-medium text-neutral-900 hover:bg-neutral-50",
                FOCUS_RING,
                sheet ? "h-10" : "h-7"
              )}
            >
              <MessageSquare size={13} aria-hidden />
              Open session
            </button>
          ) : null}
          {sessionNote ? <p className="w-full text-xs text-warn">{sessionNote}</p> : null}
        </div>
      ) : null}

      {selection ? (
        <div className="space-y-1.5">
          <RunSectionLabel
            aside={
              skips.length > 0 ? (
                <button
                  type="button"
                  aria-expanded={showSkips}
                  onClick={() => setShowSkips((open) => !open)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded px-1 text-[11px] text-neutral-400 hover:text-neutral-100",
                    FOCUS_RING,
                    sheet && "min-h-10"
                  )}
                >
                  {skips.length} skipped
                  <ChevronDown
                    size={12}
                    aria-hidden
                    className={cn("transition-transform motion-reduce:transition-none", showSkips && "rotate-180")}
                  />
                </button>
              ) : null
            }
          >
            Account
          </RunSectionLabel>
          <div className="flex min-w-0 items-start gap-2 rounded-lg border border-neutral-800 px-3 py-2">
            {selection.chosen ? (
              <span className="mt-0.5 shrink-0 text-neutral-300">
                {getRegistryIcon("agent", selection.chosen.agent, 14)}
              </span>
            ) : null}
            <p className="min-w-0 break-words text-xs leading-5 text-neutral-300">{selectionText(selection, now)}</p>
          </div>
          {showSkips ? (
            <ul className="space-y-1 pl-1">
              {skips.map((skip) => (
                <li
                  key={`${skip.agent}:${skip.accountId}`}
                  className="flex items-start gap-1.5 text-xs leading-5 text-neutral-500"
                >
                  <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-neutral-600" />
                  <span className="min-w-0 break-words">{skipText(skip)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {hops.length > 0 ? (
        <div className="space-y-1.5">
          <RunSectionLabel>{hops.length > 1 ? `Hops · ${hops.length - 1}` : "Agent"}</RunSectionLabel>
          {hops.length > 1 ? (
            <p className="text-[11px] leading-4 text-neutral-500">{hopsText(hops, { status: block.status, now })}</p>
          ) : null}
          <ol className="space-y-1">
            {hops.map((hop, index) => (
              <HopRow
                key={`${hop.sessionId}:${index}`}
                hop={hop}
                index={index}
                last={index === hops.length - 1}
                status={block.status}
                now={now}
              />
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
};

const HopRow: React.FC<{
  hop: AgentHop;
  index: number;
  last: boolean;
  status: WorkflowBlockRun["status"];
  now: number;
}> = ({ hop, index, last, status, now }) => {
  const reason = hopReasonText(hop, now);
  const end = hop.endedAt ? formatClock(hop.endedAt, now) : last && status === "running" ? "now" : "";
  const range = [formatClock(hop.startedAt, now), end].filter(Boolean).join(" – ");
  return (
    <li className="flex min-w-0 items-start gap-2.5 rounded-lg border border-neutral-800 px-3 py-2">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-neutral-800 text-neutral-200">
        {getRegistryIcon("agent", hop.agent, 13)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-xs font-medium text-neutral-200">
            {accountText(hop.agent, hop.accountId, hop.accountLabel)}
          </span>
          <span className="shrink-0 text-[11px] text-neutral-500">{index === 0 ? "started" : hopViaText(hop.via)}</span>
        </span>
        <span className="block truncate text-[11px] leading-4 text-neutral-500">
          {[hop.model, range].filter(Boolean).join(" · ")}
        </span>
        {reason ? (
          <span className="mt-1 inline-flex items-center gap-1 rounded-full border border-warn/30 bg-warn/5 px-1.5 text-[10px] leading-4 text-warn">
            <TriangleAlert size={10} aria-hidden />
            {reason}
          </span>
        ) : last && (status === "succeeded" || status === "running") ? (
          <span
            className={cn("mt-1 inline-flex text-[10px] leading-4", status === "running" ? "text-info" : "text-ok")}
          >
            {status === "running" ? "working" : "finished"}
          </span>
        ) : null}
      </span>
    </li>
  );
};
