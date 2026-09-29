/**
 * The block inspector (workflows spec §7.2): the selected block's name (a
 * rename rewrites every `{{nodes.Old…}}` reference) and what it is — its
 * type, a one-line summary of its settings, and (behind the (i)) the full
 * description, its output and how to reference it —, its problems in a
 * compact bar (picking one opens and focuses its field), and two tabs:
 * Settings (a form per type, then "Run behaviour") and Data (how to use its
 * output, the latest run's input/output, the pinned output, Test block). With
 * several blocks selected it offers what applies to all of them; with none,
 * the workflow's own problems and how to start.
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, ChevronDown, Copy, Info, MousePointerClick, Pin, Power, Trash2, X } from "lucide-react";

import {
  isTriggerType,
  WORKFLOW_BLOCK_CATALOG,
  WORKFLOW_NODE_NAME_PATTERN,
  type Workflow,
  type WorkflowNode,
  type WorkflowProblem
} from "@orquester/api";

import { cn } from "../../../lib/cn";
import { blockAgent, blockTitle, nodeSummary, type NodeSummaryContext } from "../../../lib/workflows/catalog-ui";
import type { WorkflowEditor } from "../../../lib/workflows/editor-store";
import { completionScopeFor } from "../../../lib/workflows/inspector-autocomplete";
import { outputReference } from "../../../lib/workflows/inspector-data";
import { BlockTile } from "../AddBlockMenu";
import { usePhoneLayout } from "../phone/phone-context";
import {
  Callout,
  CopyChip,
  FOCUS_RING,
  HelpTip,
  IconButton,
  Pill,
  ProblemBadge,
  ReadOnlyFieldset,
  Segmented,
  SmallButton,
  type ProblemCounts
} from "../ui/controls";
import { BlockGuide } from "../ui/GuideText";
import { AgentSettings } from "./AgentSettings";
import { CommonSettings } from "./CommonSettings";
import { DataTab } from "./DataTab";
import {
  IfSettings,
  MergeSettings,
  NoteSettings,
  StopSettings,
  SubWorkflowSettings,
  SwitchSettings,
  WaitSettings
} from "./FlowSettings";
import { InspectorContext, useInspector, useNodeSetter, type InspectorContextValue, type InspectorReveal } from "./inspector-context";
import { CodeSettings, HttpSettings, ShellSettings } from "./ProcessSettings";
import { GitSettings, ManualSettings, ScheduleSettings } from "./TriggerSettings";

export interface InspectorProps {
  editor: WorkflowEditor;
  workflow: Workflow;
  selectedIds: readonly string[];
  problems: readonly WorkflowProblem[];
  readOnly: boolean;
  projectPath: string;
  secretNames: readonly string[];
  onOpenSecrets: () => void;
  onOpenRun: (runId: string) => void;
  onClose: () => void;
  onDeleteSelection: () => void;
  onDuplicateSelection: () => void;
  onToggleDisabled: () => void;
  onSelectNode: (nodeId: string) => void;
  /** Labels for the one-line summary under the name (agent and model names…); the canvas's. */
  summaryContext?: NodeSummaryContext;
}

const SEVERITY_ICON = { error: AlertCircle, warning: AlertTriangle, info: Info } as const;

function SettingsFor({ type }: { type: WorkflowNode["type"] }): React.ReactElement | null {
  switch (type) {
    case "agent":
      return <AgentSettings />;
    case "code":
      return <CodeSettings />;
    case "shell":
      return <ShellSettings />;
    case "http":
      return <HttpSettings />;
    case "if":
      return <IfSettings />;
    case "switch":
      return <SwitchSettings />;
    case "merge":
      return <MergeSettings />;
    case "stop":
      return <StopSettings />;
    case "wait":
      return <WaitSettings />;
    case "workflow":
      return <SubWorkflowSettings />;
    case "note":
      return <NoteSettings />;
    case "trigger.schedule":
      return <ScheduleSettings />;
    case "trigger.git":
      return <GitSettings />;
    case "trigger.manual":
      return <ManualSettings />;
    default:
      return null;
  }
}

/** Focus the form field a problem names (the closest anchor that covers it). */
function focusField(root: HTMLElement | null, field: string | undefined): void {
  if (!root || !field) return;
  const anchors = [...root.querySelectorAll<HTMLElement>("[data-wf-field]")];
  const best = anchors
    .filter((anchor) => {
      const name = anchor.dataset.wfField ?? "";
      return field === name || field.startsWith(`${name}.`);
    })
    .sort((a, b) => (b.dataset.wfField?.length ?? 0) - (a.dataset.wfField?.length ?? 0))[0];
  if (!best) return;
  best.scrollIntoView({ block: "center", behavior: "smooth" });
  // The control itself, not the (i) or copy button in its label row: a form control first, then an
  // editing button (a switch, a choice, "Clear it"), then anything.
  const focusable =
    best.querySelector<HTMLElement>('input:not([type="hidden"]), select, textarea, [contenteditable="true"]') ??
    best.querySelector<HTMLElement>("button:not([data-view-button])") ??
    best.querySelector<HTMLElement>('button, [role="button"]');
  focusable?.focus({ preventScroll: true });
}

/**
 * Problems as tinted rows; a row is a button that calls `onPick` unless
 * `pickable` says there is nowhere to go for it. `strip` drops the leading
 * "BlockName: " (inside a block's inspector the name is on screen).
 */
export const ProblemList: React.FC<{
  problems: readonly WorkflowProblem[];
  onPick: (problem: WorkflowProblem) => void;
  strip?: boolean;
  pickable?: (problem: WorkflowProblem) => boolean;
}> = ({ problems, onPick, strip = true, pickable }) => (
  <ul className="space-y-1">
    {problems.map((problem, index) => {
      const Icon = SEVERITY_ICON[problem.severity];
      const canPick = pickable?.(problem) ?? true;
      const className = cn(
        "flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] leading-[18px] transition-colors",
        problem.severity === "error" && "bg-danger-soft/25 text-danger",
        problem.severity === "warning" && "bg-warn-soft/20 text-warn",
        problem.severity === "info" && "bg-neutral-900 text-neutral-400",
        canPick && problem.severity === "error" && "hover:bg-danger-soft/40",
        canPick && problem.severity === "warning" && "hover:bg-warn-soft/35",
        canPick && problem.severity === "info" && "hover:bg-neutral-800",
        canPick && FOCUS_RING
      );
      const content = (
        <>
          <Icon size={13} aria-hidden className="mt-[3px] shrink-0" />
          <span className="min-w-0 break-words">{strip ? problem.message.replace(/^[A-Za-z][A-Za-z0-9_]*: /, "") : problem.message}</span>
        </>
      );
      return (
        <li key={`${problem.code}:${problem.field ?? ""}:${index}`}>
          {canPick ? (
            <button type="button" onClick={() => onPick(problem)} className={className}>
              {content}
            </button>
          ) : (
            <div className={className}>{content}</div>
          )}
        </li>
      );
    })}
  </ul>
);

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * A block's problems in one line ("2 errors · 1 warning") that opens into the
 * list; a single problem shows as its own row straight away.
 */
export const ProblemBar: React.FC<{
  problems: readonly WorkflowProblem[];
  onPick: (problem: WorkflowProblem) => void;
  pickable?: (problem: WorkflowProblem) => boolean;
  className?: string;
}> = ({ problems, onPick, pickable, className }) => {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (problems.length === 0) return null;
  if (problems.length === 1) {
    return (
      <div className={className}>
        <ProblemList problems={problems} onPick={onPick} pickable={pickable} />
      </div>
    );
  }
  const errors = problems.filter((problem) => problem.severity === "error").length;
  const warnings = problems.filter((problem) => problem.severity === "warning").length;
  const others = problems.length - errors - warnings;
  const words = [
    errors > 0 ? plural(errors, "error") : null,
    warnings > 0 ? plural(warnings, "warning") : null,
    others > 0 ? plural(others, "note") : null
  ].filter((part): part is string => part !== null);
  const Icon = errors > 0 ? AlertCircle : AlertTriangle;
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] leading-[18px] transition-colors [.wf-touch_&]:min-h-9",
          errors > 0 ? "bg-danger-soft/25 text-danger hover:bg-danger-soft/40" : "bg-warn-soft/20 text-warn hover:bg-warn-soft/35",
          FOCUS_RING
        )}
      >
        <Icon size={13} aria-hidden className="shrink-0" />
        <span className="min-w-0 flex-1 font-medium">{words.join(" · ")}</span>
        <span className="text-[11px] text-neutral-400">{open ? "Hide" : "Show"}</span>
        <ChevronDown size={13} aria-hidden className={cn("shrink-0 text-neutral-400 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div id={listId} className="mt-1.5 max-h-[40vh] overflow-y-auto overscroll-contain">
          <ProblemList problems={problems} onPick={onPick} pickable={pickable} />
        </div>
      ) : null}
    </div>
  );
};

/** A problem about the block's pinned output (it lives on the Data tab). */
const isPinnedProblem = (problem: WorkflowProblem): boolean => problem.field?.startsWith("pinned.") ?? false;

function severityCounts(problems: readonly WorkflowProblem[]): ProblemCounts {
  return {
    errors: problems.filter((problem) => problem.severity === "error").length,
    warnings: problems.filter((problem) => problem.severity === "warning").length
  };
}

/** A disabled block says so at the top of its settings, with the way back. */
const DisabledNotice: React.FC = () => {
  const { node } = useInspector();
  const setNode = useNodeSetter();
  if (node.disabled !== true || node.type === "note") return null;
  const trigger = isTriggerType(node.type);
  return (
    <div className="px-4 pt-4">
      <Callout
        tone="warn"
        title={trigger ? "This trigger is disabled" : "This block is disabled"}
        action={<SmallButton onClick={() => setNode({ disabled: undefined }, "disabled")}>Enable</SmallButton>}
      >
        {trigger ? "It won't start the workflow." : "Runs skip it and pass its input straight to the next block."}
      </Callout>
    </div>
  );
};

const NameField: React.FC<{ editor: WorkflowEditor; node: WorkflowNode; workflow: Workflow; readOnly: boolean }> = ({
  editor,
  node,
  workflow,
  readOnly
}) => {
  const [text, setText] = useState(node.name);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(node.name);
    setError(null);
  }, [node.id, node.name]);

  const validate = (value: string): string | null => {
    if (!WORKFLOW_NODE_NAME_PATTERN.test(value)) return "Letters, digits and _; starts with a letter; at most 40.";
    if (workflow.nodes.some((other) => other.id !== node.id && other.name === value)) return "Another block has this name.";
    return null;
  };

  const commit = (): void => {
    const value = text.trim();
    if (value === node.name) return;
    const problem = validate(value);
    if (problem) {
      setError(problem);
      return;
    }
    const refusal = editor.applyOps([{ op: "rename_node", node: node.id, to: value }]);
    setError(refusal);
  };

  return (
    <div className="min-w-0 flex-1" data-wf-field="name">
      <input
        value={text}
        readOnly={readOnly}
        aria-label="Block name"
        aria-invalid={error !== null}
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value);
          setError(event.target.value.trim() === node.name ? null : validate(event.target.value.trim()));
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
            (event.target as HTMLInputElement).blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setText(node.name);
            setError(null);
            (event.target as HTMLInputElement).blur();
          }
        }}
        className={cn(
          "h-8 w-full rounded-md border bg-transparent px-1.5 text-[15px] font-semibold text-neutral-50",
          "hover:border-neutral-800 focus:border-neutral-600 focus:bg-neutral-950/60 focus:outline-none",
          error ? "border-danger/60" : "border-transparent"
        )}
      />
      {error ? (
        <p className="px-1.5 text-[11px] leading-4 text-danger">{error}</p>
      ) : node.type !== "note" && node.type !== "stop" ? (
        <p className="px-1.5 text-[11px] leading-4 text-neutral-500">
          Used in templates as <code className="break-all font-mono text-neutral-400">nodes.{node.name}</code>
          {readOnly ? null : " · renaming updates them"}
        </p>
      ) : null}
    </div>
  );
};

export const Inspector: React.FC<InspectorProps> = ({
  editor,
  workflow,
  selectedIds,
  problems,
  readOnly,
  projectPath,
  secretNames,
  onOpenSecrets,
  onOpenRun,
  onClose,
  onDeleteSelection,
  onDuplicateSelection,
  onToggleDisabled,
  onSelectNode,
  summaryContext
}) => {
  const phone = usePhoneLayout();
  const [tab, setTab] = useState<"settings" | "data">("settings");
  // The whole inspector: the name (header) is a problem's target as well as the Settings body.
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Picking a problem: Settings shows, the sections holding the field open (they read `reveal` while
  // rendering), and the field is focused once that has committed.
  const [reveal, setReveal] = useState<InspectorReveal | null>(null);
  const revealNonce = useRef(0);
  const revealField = useCallback((field: string) => {
    const nonce = ++revealNonce.current;
    setTab("settings");
    setReveal({ field, nonce });
    requestAnimationFrame(() => {
      focusField(rootRef.current, field);
      setReveal((current) => (current?.nonce === nonce ? null : current));
    });
  }, []);
  const node = selectedIds.length === 1 ? workflow.nodes.find((candidate) => candidate.id === selectedIds[0]) : undefined;
  const nodeProblems = useMemo(
    () =>
      node
        ? problems
            .filter((problem) => problem.nodeId === node.id)
            .sort((a, b) => ["error", "warning", "info"].indexOf(a.severity) - ["error", "warning", "info"].indexOf(b.severity))
        : [],
    [problems, node]
  );

  const context = useMemo<InspectorContextValue | null>(() => {
    if (!node) return null;
    return {
      editor,
      workflow,
      node,
      readOnly,
      projectPath,
      secretNames,
      scope: completionScopeFor(workflow, node.id, { secretNames }),
      promptScope: completionScopeFor(workflow, node.id, { secretNames, promptVariables: true }),
      problems: nodeProblems,
      openSecrets: onOpenSecrets,
      reveal,
      revealField
    };
  }, [editor, workflow, node, readOnly, projectPath, secretNames, nodeProblems, onOpenSecrets, reveal, revealField]);

  /** A picked problem: a pinned-output one opens the Data tab; any other opens and focuses its field. */
  const pickProblem = useCallback(
    (problem: WorkflowProblem) => {
      if (isPinnedProblem(problem)) setTab("data");
      else if (problem.field) revealField(problem.field);
    },
    [revealField]
  );

  if (selectedIds.length > 1) {
    const chosen = workflow.nodes.filter((candidate) => selectedIds.includes(candidate.id));
    const someOn = chosen.some((candidate) => !candidate.disabled);
    const someOff = chosen.some((candidate) => candidate.disabled);
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-neutral-800 px-4">
          <span className="text-[14px] font-semibold text-neutral-100">{selectedIds.length} blocks selected</span>
          <IconButton label="Clear the selection" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </div>
        <div className="space-y-4 overflow-y-auto p-4">
          {!readOnly ? (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <SmallButton icon={<Copy size={12} />} onClick={onDuplicateSelection}>
                  Duplicate
                </SmallButton>
                <SmallButton
                  icon={<Power size={12} />}
                  onClick={onToggleDisabled}
                  title={someOn && someOff ? "Some are already disabled: this disables every selected block" : undefined}
                >
                  {someOn ? (someOff ? "Disable all" : "Disable") : "Enable"}
                </SmallButton>
                <SmallButton icon={<Trash2 size={12} />} onClick={onDeleteSelection} className="hover:border-danger/50 hover:text-danger">
                  Delete
                </SmallButton>
              </div>
              <p className="text-[11px] leading-4 text-neutral-500">These act on every selected block. Pick one below to edit its settings.</p>
            </div>
          ) : (
            <p className="text-[11px] leading-4 text-neutral-500">Pick one to see its settings.</p>
          )}
          <ul className="space-y-1">
            {chosen.map((candidate) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  onClick={() => onSelectNode(candidate.id)}
                  className={cn("flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1 text-left hover:bg-neutral-900", FOCUS_RING)}
                >
                  <BlockTile type={candidate.type} agent={blockAgent(candidate)} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-neutral-200" title={candidate.name}>
                      {candidate.name}
                    </span>
                    <span className="block text-[11px] leading-4 text-neutral-500">{blockTitle(candidate.type)}</span>
                  </span>
                  {candidate.disabled ? <Pill>Disabled</Pill> : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  if (!node || !context) {
    const general = problems.filter((problem) => !problem.nodeId || problem.severity === "info");
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-12 shrink-0 items-center border-b border-neutral-800 px-4">
          <span className="text-[14px] font-semibold text-neutral-100">Inspector</span>
        </div>
        <div className="space-y-5 overflow-y-auto p-4">
          <div className="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-neutral-800 px-4 py-7 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-neutral-900 text-neutral-400 ring-1 ring-neutral-800">
              <MousePointerClick size={18} />
            </span>
            <div className="text-[13px] font-medium text-neutral-200">Select a block to see its settings</div>
            <p className="max-w-[240px] text-[11.5px] leading-[18px] text-neutral-500">
              Add blocks with the “+” after a block, from the palette, or by pressing Tab over the canvas.
            </p>
          </div>
          {general.length > 0 ? (
            <div className="space-y-2">
              <div className="text-xs font-medium text-neutral-400">This workflow</div>
              <ProblemList
                problems={general}
                onPick={(problem) => problem.nodeId && onSelectNode(problem.nodeId)}
                pickable={(problem) => problem.nodeId !== undefined}
                strip={false}
              />
            </div>
          ) : null}
          <div className="space-y-2">
            <div className="text-xs font-medium text-neutral-400">Shortcuts</div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[11.5px] text-neutral-500">
              {[
                ["Tab", "add a block at the pointer"],
                ["⌘/Ctrl C · V · D", "copy · paste · duplicate"],
                ["⌘/Ctrl Z · ⇧Z", "undo · redo"],
                ["Arrows", "nudge (⇧ ×10)"],
                ["Delete", "remove the selection"],
                ["Shift-drag", "select an area"]
              ].map(([keys, text]) => (
                <React.Fragment key={keys}>
                  <dt className="font-medium text-neutral-400">{keys}</dt>
                  <dd>{text}</dd>
                </React.Fragment>
              ))}
            </dl>
          </div>
        </div>
      </div>
    );
  }

  const entry = WORKFLOW_BLOCK_CATALOG[node.type];
  const listed = nodeProblems.filter((problem) => problem.severity !== "info");
  const settingsCounts = severityCounts(listed.filter((problem) => !isPinnedProblem(problem)));
  const dataCounts = severityCounts(listed.filter(isPinnedProblem));
  const hasPin = workflow.pinned !== undefined && node.id in workflow.pinned;
  const summary = node.type === "note" ? "" : nodeSummary(node, summaryContext ?? {});
  const referable = node.type !== "note" && node.type !== "stop";
  return (
    <InspectorContext.Provider value={context}>
      <div ref={rootRef} className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 border-b border-neutral-800 px-3 pb-2.5 pt-3">
          <div className="flex items-start gap-2.5">
            <div className="pt-0.5">
              <BlockTile type={node.type} agent={blockAgent(node)} />
            </div>
            <NameField key={node.id} editor={editor} node={node} workflow={workflow} readOnly={readOnly} />
            <IconButton label="Close the inspector" onClick={onClose}>
              <X size={15} />
            </IconButton>
          </div>
          <div className="mt-1.5 flex items-start gap-1.5 pl-[42px]">
            <p className="min-w-0 flex-1 break-words text-[11.5px] leading-4 text-neutral-500">
              <span className="font-medium text-neutral-300">{entry.title}</span>
              {summary ? ` · ${summary}` : null}
            </p>
            <HelpTip label={`the ${entry.title} block`} align="end" className="mt-px">
              <BlockGuide type={node.type} />
              {referable ? (
                <div className="space-y-1">
                  <p>Blocks after it read its output as</p>
                  <CopyChip text={outputReference(node.name)} />
                </div>
              ) : null}
            </HelpTip>
          </div>
          {node.disabled || hasPin ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-[42px]">
              {node.disabled ? (
                <button
                  type="button"
                  onClick={() => revealField("disabled")}
                  title="Runs skip this block — change it under Run behaviour"
                  className={cn("inline-flex items-center rounded-full [.wf-touch_&]:min-h-9", FOCUS_RING)}
                >
                  <Pill tone="warn">
                    <Power size={10} aria-hidden />
                    Disabled
                  </Pill>
                </button>
              ) : null}
              {hasPin && node.type !== "note" ? (
                <button
                  type="button"
                  onClick={() => setTab("data")}
                  title="It has a pinned output — see it on the Data tab"
                  className={cn("inline-flex items-center rounded-full [.wf-touch_&]:min-h-9", FOCUS_RING)}
                >
                  <Pill tone="info">
                    <Pin size={10} aria-hidden />
                    Pinned output
                  </Pill>
                </button>
              ) : null}
            </div>
          ) : null}
          {node.type !== "note" ? (
            <Segmented
              label="Inspector tab"
              size={phone ? "md" : "sm"}
              value={tab}
              onChange={setTab}
              className="mt-3"
              options={[
                {
                  id: "settings",
                  label: (
                    <>
                      Settings
                      <ProblemBadge problems={settingsCounts} />
                    </>
                  )
                },
                {
                  id: "data",
                  label: (
                    <>
                      Data
                      <ProblemBadge problems={dataCounts} />
                    </>
                  )
                }
              ]}
            />
          ) : null}
          <ProblemBar problems={listed} onPick={pickProblem} pickable={(problem) => problem.field !== undefined} className="mt-2.5" />
        </div>
        {/* Keyed by the block: pin editor text, field drafts and CodeMirror undo stacks never carry over to another block. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-inspector-body="">
          {tab === "settings" || node.type === "note" ? (
            <ReadOnlyFieldset key={node.id} readOnly={readOnly} className="min-w-0">
              <DisabledNotice />
              <SettingsFor type={node.type} />
              {node.type !== "note" ? <CommonSettings /> : null}
            </ReadOnlyFieldset>
          ) : (
            <DataTab key={node.id} onOpenRun={onOpenRun} />
          )}
        </div>
      </div>
    </InspectorContext.Provider>
  );
};
