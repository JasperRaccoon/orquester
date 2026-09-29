/**
 * The sheets a step opens on a phone (workflows spec §7.4): its ⋯ menu
 * (settings, rename, duplicate, disable, connect, move, delete), a rename
 * field, and the pickers "Connect to…" (an output — when it has several —
 * then the block it should feed) and "Move to another output".
 */

import React, { useEffect, useMemo, useState } from "react";
import { ArrowRightLeft, Cable, Copy, Pencil, Power, Settings2, Trash2 } from "lucide-react";

import { acceptsInput, outputHandles, WORKFLOW_NODE_NAME_PATTERN, workflowHandleLabel, type Workflow, type WorkflowNode } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { blockAgent } from "../../../lib/workflows/catalog-ui";
import { BlockTile } from "../AddBlockMenu";
import { ActionSheet, WorkflowSheet } from "../phone/WorkflowSheet";
import { connectCandidates, moveCandidates, outputTone, type OutputRef } from "./steps-logic";
import { TONE_CHIP, TONE_DOT } from "./StepsView";

export const StepMenuSheet: React.FC<{
  open: boolean;
  onClose: () => void;
  node: WorkflowNode | null;
  readOnly: boolean;
  /** "Move to another output" applies (it hangs from an output). */
  canMove: boolean;
  onOpenSettings: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onToggleDisabled: () => void;
  onConnect: () => void;
  onMove: () => void;
  onDelete: () => void;
}> = ({ open, onClose, node, readOnly, canMove, ...on }) => {
  if (!node) return null;
  const outputs = outputHandles(node).length;
  return (
    <ActionSheet
      open={open}
      onClose={onClose}
      label={`${node.name} — actions`}
      title={node.name}
      leading={<BlockTile type={node.type} agent={blockAgent(node)} />}
      actions={[
        { id: "settings", label: "Settings", icon: <Settings2 size={18} />, onSelect: on.onOpenSettings },
        { id: "rename", label: "Rename", icon: <Pencil size={18} />, disabled: readOnly, onSelect: on.onRename },
        { id: "duplicate", label: "Duplicate", hint: "The copy goes right after it", icon: <Copy size={18} />, disabled: readOnly, onSelect: on.onDuplicate },
        {
          id: "disable",
          label: node.disabled ? "Enable" : "Disable",
          hint: node.disabled ? undefined : "Runs skip it, and what only it leads to",
          icon: <Power size={18} />,
          disabled: readOnly,
          onSelect: on.onToggleDisabled
        },
        "separator",
        {
          id: "connect",
          label: "Connect to…",
          hint: outputs === 0 ? "It has no output" : "Wire one of its outputs to another step",
          icon: <Cable size={18} />,
          disabled: readOnly || outputs === 0,
          onSelect: on.onConnect
        },
        {
          id: "move",
          label: "Move to another output…",
          hint: "Hang it from a different step or branch",
          icon: <ArrowRightLeft size={18} />,
          disabled: readOnly || !canMove || !acceptsInput(node),
          onSelect: on.onMove
        },
        "separator",
        { id: "delete", label: "Delete", icon: <Trash2 size={18} />, tone: "danger", disabled: readOnly, onSelect: on.onDelete }
      ]}
    />
  );
};

export const RenameSheet: React.FC<{
  open: boolean;
  onClose: () => void;
  node: WorkflowNode | null;
  workflow: Workflow;
  /** Rename it; a refusal's words, or null. */
  onRename: (name: string) => string | null;
}> = ({ open, onClose, node, workflow, onRename }) => {
  const [text, setText] = useState(node?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setText(node?.name ?? "");
      setError(null);
    }
  }, [open, node?.name]);
  if (!node) return null;
  const validate = (value: string): string | null => {
    if (!WORKFLOW_NODE_NAME_PATTERN.test(value)) return "Letters, digits and _; starts with a letter; at most 40.";
    if (workflow.nodes.some((other) => other.id !== node.id && other.name === value)) return "Another step has this name.";
    return null;
  };
  const submit = (): void => {
    const value = text.trim();
    if (value === node.name) {
      onClose();
      return;
    }
    const problem = validate(value) ?? onRename(value);
    if (problem) setError(problem);
    else onClose();
  };
  return (
    <WorkflowSheet
      open={open}
      onClose={onClose}
      label={`Rename ${node.name}`}
      title="Rename"
      subtitle="References to it in other steps are updated too"
      level={1}
      footer={
        <button
          type="button"
          onClick={submit}
          className="flex h-12 w-full items-center justify-center rounded-xl bg-neutral-100 text-[15px] font-semibold text-neutral-900 active:bg-neutral-300"
        >
          Save
        </button>
      }
    >
      <form
        className="px-4 pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          value={text}
          autoFocus
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          enterKeyHint="done"
          aria-label="Step name"
          aria-invalid={error !== null}
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
          className={cn(
            "h-12 w-full rounded-xl border bg-neutral-900 px-3.5 text-base text-neutral-50 focus:outline-none",
            error ? "border-danger/70" : "border-neutral-800 focus:border-neutral-600"
          )}
        />
        {error ? <p className="mt-1.5 text-[12.5px] text-danger">{error}</p> : null}
      </form>
    </WorkflowSheet>
  );
};

const PickRow: React.FC<{
  onClick: () => void;
  disabled?: boolean;
  current?: boolean;
  children: React.ReactNode;
}> = ({ onClick, disabled, current, children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-current={current ? "true" : undefined}
    className={cn(
      "flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors",
      "hover:bg-neutral-900 active:bg-neutral-800 focus:outline-none focus-visible:bg-neutral-900",
      "disabled:pointer-events-none",
      current && "bg-neutral-900 ring-1 ring-inset ring-neutral-700"
    )}
  >
    {children}
  </button>
);

/** Step one of "Connect to…" for a block with several outputs: which one. */
export const OutputPickSheet: React.FC<{
  open: boolean;
  onClose: () => void;
  node: WorkflowNode | null;
  title: string;
  onPick: (handle: string) => void;
}> = ({ open, onClose, node, title, onPick }) => {
  if (!node) return null;
  return (
    <WorkflowSheet open={open} onClose={onClose} label={title} title={title} subtitle={`From ${node.name}`} level={1}>
      <div className="px-2 pb-3">
        {outputHandles(node).map((handle) => {
          const tone = outputTone(handle);
          const label = workflowHandleLabel(node, handle);
          return (
            <PickRow key={handle} onClick={() => onPick(handle)}>
              <span aria-hidden className={cn("ml-1 h-2.5 w-2.5 shrink-0 rounded-full", TONE_DOT[tone])} />
              <span className={cn("text-[15px] font-medium", handle === "success" ? "text-neutral-100" : TONE_CHIP[tone])}>
                {handle === "success" ? "When it succeeds" : handle === "error" ? "When it fails" : label}
              </span>
            </PickRow>
          );
        })}
      </div>
    </WorkflowSheet>
  );
};

export const ConnectSheet: React.FC<{
  open: boolean;
  onClose: () => void;
  workflow: Workflow;
  from: OutputRef | null;
  onPick: (targetId: string) => void;
}> = ({ open, onClose, workflow, from, onPick }) => {
  const candidates = useMemo(() => (from ? connectCandidates(workflow, from) : []), [workflow, from]);
  const source = from ? workflow.nodes.find((node) => node.id === from.nodeId) : undefined;
  if (!from || !source) return null;
  const label = workflowHandleLabel(source, from.handle);
  return (
    <WorkflowSheet
      open={open}
      onClose={onClose}
      label="Connect to"
      title="Connect to…"
      subtitle={`${source.name}${from.handle === "success" ? "" : ` · ${label}`} leads to`}
      size="full"
      level={1}
    >
      <div className="px-2 pb-4">
        {candidates.length === 0 ? (
          <p className="px-3 py-10 text-center text-sm text-neutral-500">There is no other step to connect to yet.</p>
        ) : (
          candidates.map((candidate) => (
            <PickRow key={candidate.nodeId} disabled={candidate.refusal !== null} onClick={() => onPick(candidate.nodeId)}>
              <span className={cn(candidate.refusal !== null && "opacity-40")}>
                <BlockTile type={candidate.type} agent={candidate.agent} />
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate text-[15px] font-medium", candidate.refusal ? "text-neutral-500" : "text-neutral-100")}>
                  {candidate.name}
                </span>
                {candidate.refusal ? <span className="block text-xs leading-4 text-neutral-500">{candidate.refusal}</span> : null}
              </span>
            </PickRow>
          ))
        )}
      </div>
    </WorkflowSheet>
  );
};

export const MoveSheet: React.FC<{
  open: boolean;
  onClose: () => void;
  workflow: Workflow;
  nodeId: string | null;
  current: OutputRef | null;
  onPick: (to: OutputRef) => void;
}> = ({ open, onClose, workflow, nodeId, current, onPick }) => {
  const candidates = useMemo(() => (nodeId ? moveCandidates(workflow, nodeId, current) : []), [workflow, nodeId, current]);
  const node = nodeId ? workflow.nodes.find((candidate) => candidate.id === nodeId) : undefined;
  if (!node) return null;
  // Grouped by block.
  const groups: { nodeId: string; name: string; type: WorkflowNode["type"]; agent?: string; outputs: typeof candidates }[] = [];
  for (const candidate of candidates) {
    const last = groups[groups.length - 1];
    if (last && last.nodeId === candidate.nodeId) last.outputs.push(candidate);
    else groups.push({ nodeId: candidate.nodeId, name: candidate.name, type: candidate.type, agent: candidate.agent, outputs: [candidate] });
  }
  return (
    <WorkflowSheet open={open} onClose={onClose} label="Move to another output" title="Move to…" subtitle={`Where ${node.name} hangs from`} size="full" level={1}>
      <div className="space-y-1 px-2 pb-4">
        {groups.map((group) => {
          const blocked = group.outputs.every((output) => output.refusal !== null && !output.current);
          return (
            <div key={group.nodeId} className={cn("rounded-2xl px-1 py-1", blocked && "opacity-45")}>
              <div className="flex items-center gap-2.5 px-2 pb-1 pt-1.5">
                <BlockTile type={group.type} agent={group.agent} size="sm" />
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-neutral-200">{group.name}</span>
              </div>
              <div className="flex flex-wrap gap-1.5 pb-1 pl-[46px] pr-2">
                {group.outputs.map((output) => (
                  <button
                    key={output.handle}
                    type="button"
                    disabled={output.refusal !== null || output.current}
                    title={output.refusal ?? undefined}
                    onClick={() => onPick({ nodeId: output.nodeId, handle: output.handle })}
                    className={cn(
                      "inline-flex h-10 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition-colors",
                      output.current
                        ? "border-neutral-500 bg-neutral-800 text-neutral-50"
                        : "border-neutral-800 hover:border-neutral-700 active:bg-neutral-800 disabled:opacity-50",
                      !output.current && (output.handle === "success" ? "text-neutral-100" : TONE_CHIP[output.tone])
                    )}
                  >
                    <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", TONE_DOT[output.tone])} />
                    {output.label}
                    {output.current ? <span className="text-[11px] font-normal text-neutral-400">· now</span> : null}
                  </button>
                ))}
              </div>
              {blocked && group.outputs[0]?.refusal ? (
                <p className="pb-1 pl-[46px] text-[11.5px] text-neutral-500">{group.outputs[0].refusal}</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </WorkflowSheet>
  );
};
