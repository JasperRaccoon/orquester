/**
 * The block inspector (workflows spec §7.2): the selected block's name (a
 * rename rewrites every `{{nodes.Old…}}` reference), its problems — each one
 * focuses its field — and two tabs: Settings (a form per type, then what every
 * block has) and Data (the latest run's input/output, the pinned output, Test
 * block). With several blocks selected it offers what applies to all of them;
 * with none, the workflow's own problems and how to start.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, Copy, Info, MousePointerClick, Power, Trash2, X } from "lucide-react";

import {
  WORKFLOW_BLOCK_CATALOG,
  WORKFLOW_NODE_NAME_PATTERN,
  type Workflow,
  type WorkflowNode,
  type WorkflowProblem
} from "@orquester/api";

import { cn } from "../../../lib/cn";
import type { WorkflowEditor } from "../../../lib/workflows/editor-store";
import { completionScopeFor } from "../../../lib/workflows/inspector-autocomplete";
import { BlockTile } from "../AddBlockMenu";
import { IconButton, Segmented, SmallButton } from "../ui/controls";
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
import { InspectorContext, type InspectorContextValue } from "./inspector-context";
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
  const focusable = best.querySelector<HTMLElement>('input, select, textarea, [contenteditable="true"], button');
  focusable?.focus({ preventScroll: true });
}

export const ProblemList: React.FC<{ problems: readonly WorkflowProblem[]; onPick: (problem: WorkflowProblem) => void; strip?: boolean }> = ({
  problems,
  onPick,
  strip = true
}) => (
  <ul className="space-y-1">
    {problems.map((problem, index) => {
      const Icon = SEVERITY_ICON[problem.severity];
      return (
        <li key={`${problem.code}:${problem.field ?? ""}:${index}`}>
          <button
            type="button"
            onClick={() => onPick(problem)}
            className={cn(
              "flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] leading-[18px] transition-colors",
              problem.severity === "error" && "bg-danger-soft/25 text-danger hover:bg-danger-soft/40",
              problem.severity === "warning" && "bg-warn-soft/20 text-warn hover:bg-warn-soft/35",
              problem.severity === "info" && "bg-neutral-900 text-neutral-400 hover:bg-neutral-800"
            )}
          >
            <Icon size={13} className="mt-[3px] shrink-0" />
            <span className="min-w-0">{strip ? problem.message.replace(/^[A-Za-z][A-Za-z0-9_]*: /, "") : problem.message}</span>
          </button>
        </li>
      );
    })}
  </ul>
);

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
    <div className="min-w-0 flex-1">
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
      {error ? <p className="px-1.5 text-[11px] text-danger">{error}</p> : null}
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
  onSelectNode
}) => {
  const [tab, setTab] = useState<"settings" | "data">("settings");
  const bodyRef = useRef<HTMLDivElement | null>(null);
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
      openSecrets: onOpenSecrets
    };
  }, [editor, workflow, node, readOnly, projectPath, secretNames, nodeProblems, onOpenSecrets]);

  if (selectedIds.length > 1) {
    const chosen = workflow.nodes.filter((candidate) => selectedIds.includes(candidate.id));
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-neutral-800 px-4">
          <span className="text-[14px] font-semibold text-neutral-100">{selectedIds.length} blocks selected</span>
          <IconButton label="Clear the selection" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </div>
        <div className="space-y-4 overflow-y-auto p-4">
          <ul className="space-y-1">
            {chosen.map((candidate) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  onClick={() => onSelectNode(candidate.id)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1 text-left hover:bg-neutral-900"
                >
                  <BlockTile type={candidate.type} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-200">{candidate.name}</span>
                  {candidate.disabled ? <span className="text-[10.5px] text-neutral-500">off</span> : null}
                </button>
              </li>
            ))}
          </ul>
          {!readOnly ? (
            <div className="flex flex-wrap gap-2">
              <SmallButton icon={<Copy size={12} />} onClick={onDuplicateSelection}>
                Duplicate
              </SmallButton>
              <SmallButton icon={<Power size={12} />} onClick={onToggleDisabled}>
                Disable / enable
              </SmallButton>
              <SmallButton icon={<Trash2 size={12} />} onClick={onDeleteSelection} className="hover:border-danger/50 hover:text-danger">
                Delete
              </SmallButton>
            </div>
          ) : null}
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
            <div className="text-[13px] font-medium text-neutral-200">Select a block to edit it</div>
            <p className="max-w-[240px] text-[11.5px] leading-[18px] text-neutral-500">
              Add blocks with the “+” after a block, from the palette, or by pressing Tab over the canvas.
            </p>
          </div>
          {general.length > 0 ? (
            <div className="space-y-2">
              <div className="text-xs font-medium text-neutral-400">This workflow</div>
              <ProblemList problems={general} onPick={(problem) => problem.nodeId && onSelectNode(problem.nodeId)} strip={false} />
            </div>
          ) : null}
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
    );
  }

  const entry = WORKFLOW_BLOCK_CATALOG[node.type];
  const errors = nodeProblems.filter((problem) => problem.severity !== "info");
  return (
    <InspectorContext.Provider value={context}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 border-b border-neutral-800 px-3 pb-2.5 pt-3">
          <div className="flex items-start gap-2.5">
            <div className="pt-0.5">
              <BlockTile type={node.type} />
            </div>
            <NameField editor={editor} node={node} workflow={workflow} readOnly={readOnly} />
            <IconButton label="Close the inspector" onClick={onClose}>
              <X size={15} />
            </IconButton>
          </div>
          <p className="mt-1 line-clamp-2 pl-[42px] text-[11.5px] leading-4 text-neutral-500" title={entry.description}>
            <span className="text-neutral-400">{entry.title}</span> — {entry.description}
          </p>
          {node.type !== "note" ? (
            <Segmented
              label="Inspector tab"
              size="sm"
              value={tab}
              onChange={setTab}
              className="mt-3"
              options={[
                { id: "settings", label: errors.length > 0 ? `Settings · ${errors.length}` : "Settings" },
                { id: "data", label: "Data" }
              ]}
            />
          ) : null}
        </div>
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-inspector-body="">
          {tab === "settings" || node.type === "note" ? (
            <fieldset disabled={readOnly} className="min-w-0">
              {errors.length > 0 ? (
                <div className="border-b border-neutral-800/80 px-4 py-3">
                  <ProblemList problems={errors} onPick={(problem) => focusField(bodyRef.current, problem.field)} />
                </div>
              ) : null}
              <SettingsFor type={node.type} />
              {node.type !== "note" ? <CommonSettings /> : null}
            </fieldset>
          ) : (
            <DataTab onOpenRun={onOpenRun} />
          )}
        </div>
      </div>
    </InspectorContext.Provider>
  );
};
