/**
 * The workflow editor on a phone (workflows spec §7.4). The editor tab keeps
 * the draft, autosave, validation and Run now; this lays them out for a
 * finger:
 *
 * - a compact top bar and a **Steps · Canvas · Runs** switch — Steps first;
 * - **Steps**: the outline, "+" on every output, ⋯ / long press for a step's
 *   menu (rename, duplicate, disable, connect to…, move to another output,
 *   delete) — a whole workflow can be built here;
 * - **Canvas**: one finger pans, two pinch; a tap opens a block; a long press
 *   opens its menu (or, on empty canvas, adds a block there); an output is
 *   connected by tapping it, then the block it should feed;
 * - the inspector as a full-height sheet; the add menu as a sheet;
 * - a floating toolbar: Add · Undo · Redo · Fit · Tidy · Run.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Cable, X } from "lucide-react";

import {
  isTriggerType,
  outputHandles,
  workflowHandleLabel,
  type Workflow,
  type WorkflowNodeType
} from "@orquester/api";

import type { NodeSummaryContext } from "../../../lib/workflows/catalog-ui";
import type { WorkflowEditor, WorkflowEditorState } from "../../../lib/workflows/editor-store";
import type { AddMenuRequest } from "../canvas/canvas-context";
import { connectBlocks } from "../canvas/connection";
import { addBlock } from "../canvas/ops";
import { reduceTapConnect, TAP_CONNECT_IDLE, tapConnectPrompt, type TapConnectEvent, type TapConnectState } from "../canvas/tap-connect";
import type { EditorMode } from "../EditorToolbar";
import { Inspector } from "../inspector/Inspector";
import { StepMenuSheet, ConnectSheet, MoveSheet, OutputPickSheet, RenameSheet } from "../steps/StepSheets";
import {
  addFirstStep,
  addStepAfter,
  connectStep,
  deleteStep,
  duplicateStepAfter,
  moveStepToOutput,
  setStepsDisabled,
  type OutputRef,
  type StepRow
} from "../steps/steps-logic";
import { StepsView } from "../steps/StepsView";
import { AddBlockSheet } from "./AddBlockSheet";
import { PhoneToolbar, PhoneTopBar, PhoneViewSwitch, type PhoneEditorView } from "./PhoneEditorChrome";
import { WorkflowSheet } from "./WorkflowSheet";

/** What the canvas needs from the phone layout. */
export interface PhoneCanvasHooks {
  tapConnect: TapConnectState;
  onTapConnect: (event: TapConnectEvent) => void;
  onNodeTap: (nodeId: string) => void;
  onLongPressNode: (nodeId: string) => void;
  onLongPressPane: (request: AddMenuRequest) => void;
  onOpenAddMenu: (request: AddMenuRequest) => void;
}

export interface PhoneEditorProps {
  editor: WorkflowEditor;
  state: WorkflowEditorState;
  draft: Workflow;
  readOnly: boolean;
  summaryContext: NodeSummaryContext;
  /** The project the workflow runs in. */
  workflowProject: string;
  secretNames: readonly string[];
  mode: EditorMode;
  onMode: (mode: EditorMode) => void;
  liveRuns: number;
  /** Triggers whose last poll failed, by node id. */
  triggerErrors?: ReadonlyMap<string, string>;
  enableRefusal: string | null;
  onToggleEnabled: (enabled: boolean) => void;
  /** Conflict and notice banners. */
  banners: React.ReactNode;
  /** Runs mode's content. */
  runs: React.ReactNode;
  renderCanvas: (hooks: PhoneCanvasHooks) => React.ReactNode;
  runButtonRef: React.Ref<HTMLButtonElement>;
  onRunNow: () => void;
  onSettings: () => void;
  onSecrets: () => void;
  onOpenRun: (runId: string) => void;
  onTidy: () => void;
  onFit: () => void;
  /** Close the tab. */
  onClose: (() => void) | null;
}

type AddTarget =
  | { kind: "after"; from: OutputRef }
  | { kind: "first"; triggers: boolean }
  | { kind: "at"; request: AddMenuRequest };

type Picker =
  | { kind: "rename"; nodeId: string }
  | { kind: "connect-output"; nodeId: string; via: "list" | "tap" }
  | { kind: "connect"; from: OutputRef }
  | { kind: "move"; nodeId: string; current: OutputRef | null };

const EMPTY = { nodeIds: [] as string[], edgeIds: [] as string[] };

export const PhoneEditor: React.FC<PhoneEditorProps> = (props) => {
  const { editor, state, draft, readOnly, mode } = props;
  const [view, setView] = useState<Exclude<PhoneEditorView, "runs">>("steps");
  const shown: PhoneEditorView = mode === "runs" ? "runs" : view;
  const [inspectorFor, setInspectorFor] = useState<string | null>(null);
  const [addTarget, setAddTarget] = useState<AddTarget | null>(null);
  const [menu, setMenu] = useState<{ nodeId: string; parent: OutputRef | null } | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [tapConnect, setTapConnect] = useState<TapConnectState>(TAP_CONNECT_IDLE);
  const [toast, setToast] = useState<string | null>(null);

  const nodeOf = useCallback((id: string | null | undefined) => (id ? draft.nodes.find((node) => node.id === id) ?? null : null), [draft.nodes]);

  // A block that went away (undo, a delete elsewhere) takes its sheets with it.
  useEffect(() => {
    if (inspectorFor && !nodeOf(inspectorFor)) setInspectorFor(null);
    if (menu && !nodeOf(menu.nodeId)) setMenu(null);
  }, [inspectorFor, menu, nodeOf]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  const openStep = useCallback(
    (nodeId: string) => {
      editor.select({ nodeIds: [nodeId], edgeIds: [] });
      setInspectorFor(nodeId);
    },
    [editor]
  );

  const closeInspector = (): void => {
    setInspectorFor(null);
    if (shown === "steps") editor.select(EMPTY);
  };

  // ---- Adding -------------------------------------------------------------

  const addContext = (): string | null => {
    if (!addTarget) return null;
    if (addTarget.kind === "after") {
      const source = nodeOf(addTarget.from.nodeId);
      if (!source) return null;
      const handle = addTarget.from.handle;
      return `After ${source.name}${handle === "success" ? "" : ` · ${handle === "error" ? "on failure" : workflowHandleLabel(source, handle)}`}`;
    }
    if (addTarget.kind === "first") return addTarget.triggers ? null : "After the trigger";
    return "Here on the canvas";
  };

  const pick = (type: WorkflowNodeType): void => {
    const target = addTarget;
    setAddTarget(null);
    if (!target || readOnly) return;
    let created: string | null = null;
    editor.change((current) => {
      const result =
        target.kind === "after"
          ? addStepAfter(current, target.from, type, editor.mintId)
          : target.kind === "first"
            ? addFirstStep(current, type, editor.mintId)
            : addAt(current, type, target.request, editor.mintId);
      created = result.nodeId;
      return result.workflow;
    });
    if (created) {
      const id: string = created;
      // Straight into its settings — a new block has something to fill in.
      setTimeout(() => openStep(id), 60);
    }
  };

  /** The toolbar's Add: after the open block, else after the last step, else a trigger. */
  const addFromToolbar = (): void => {
    const blocks = draft.nodes.filter((node) => node.type !== "note");
    if (blocks.length === 0) {
      setAddTarget({ kind: "first", triggers: true });
      return;
    }
    const selected = nodeOf(state.selection.nodeIds.length === 1 ? state.selection.nodeIds[0] : null);
    const candidate =
      selected && outputHandles(selected).length > 0
        ? selected
        : [...blocks].reverse().find((node) => outputHandles(node).length > 0 && !draft.edges.some((edge) => edge.source === node.id));
    const from = candidate ?? blocks.find((node) => isTriggerType(node.type));
    if (from && outputHandles(from).length > 0) setAddTarget({ kind: "after", from: { nodeId: from.id, handle: outputHandles(from)[0]! } });
    else setAddTarget({ kind: "first", triggers: false });
  };

  // ---- A step's menu --------------------------------------------------------

  const parentOf = (nodeId: string): OutputRef | null => {
    const edge = draft.edges.find((candidate) => candidate.target === nodeId);
    return edge ? { nodeId: edge.source, handle: edge.sourceHandle } : null;
  };

  const openMenu = (row: StepRow): void => {
    const parent = row.parentId ? draft.edges.find((edge) => edge.source === row.parentId && edge.target === row.nodeId) : undefined;
    setMenu({ nodeId: row.nodeId, parent: parent ? { nodeId: parent.source, handle: parent.sourceHandle } : parentOf(row.nodeId) });
  };

  const menuNode = nodeOf(menu?.nodeId);

  const startConnect = (nodeId: string, via: "list" | "tap"): void => {
    const node = nodeOf(nodeId);
    if (!node) return;
    const handles = outputHandles(node);
    if (handles.length === 0) return;
    if (handles.length === 1) {
      const from = { nodeId, handle: handles[0]! };
      if (via === "tap") onTapConnect({ type: "start", from });
      else setPicker({ kind: "connect", from });
      return;
    }
    setPicker({ kind: "connect-output", nodeId, via });
  };

  const tapRef = useRef(tapConnect);
  tapRef.current = tapConnect;
  const onTapConnect = useCallback(
    (event: TapConnectEvent) => {
      const current = editor.state.draft ?? draft;
      const result = reduceTapConnect(tapRef.current, event, current);
      tapRef.current = result.state;
      setTapConnect(result.state);
      const edge = result.connect;
      if (edge) {
        editor.change((wf) => connectBlocks(wf, edge, editor.mintId));
        const target = current.nodes.find((node) => node.id === edge.target);
        setToast(target ? `Connected to ${target.name}` : "Connected");
      }
    },
    [editor, draft]
  );

  // ---- The inspector sheet --------------------------------------------------

  const inspectorNode = nodeOf(inspectorFor);

  const canvasHooks: PhoneCanvasHooks = useMemo(
    () => ({
      tapConnect,
      onTapConnect,
      onNodeTap: (nodeId) => {
        if (tapConnect.mode === "picking") return;
        setInspectorFor(nodeId);
      },
      onLongPressNode: (nodeId) => {
        editor.select({ nodeIds: [nodeId], edgeIds: [] });
        setMenu({ nodeId, parent: parentOf(nodeId) });
      },
      onLongPressPane: (request) => setAddTarget({ kind: "at", request }),
      onOpenAddMenu: (request) =>
        setAddTarget(
          request.from
            ? { kind: "after", from: request.from }
            : { kind: "at", request }
        )
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tapConnect, onTapConnect, editor, draft.edges]
  );

  const prompt = tapConnectPrompt(tapConnect, draft, (nodeId, handle) => {
    const node = nodeOf(nodeId);
    return node ? workflowHandleLabel(node, handle) : handle;
  });

  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 flex-col">
      <PhoneTopBar
        name={draft.name}
        onRename={(name) => editor.change((current) => ({ ...current, name }))}
        enabled={draft.enabled}
        onToggleEnabled={props.onToggleEnabled}
        enableRefusal={props.enableRefusal}
        saveState={state.saveState}
        onRetrySave={() => void editor.flush()}
        readOnly={state.status !== "ready"}
        onBack={null}
        onClose={props.onClose}
        onSettings={props.onSettings}
        onSecrets={props.onSecrets}
        onRuns={() => props.onMode("runs")}
        onTidy={props.onTidy}
        onUndo={() => editor.undo()}
        onRedo={() => editor.redo()}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
      />
      <PhoneViewSwitch
        view={shown}
        liveRuns={props.liveRuns}
        onView={(next) => {
          if (next === "runs") {
            props.onMode("runs");
            return;
          }
          setView(next);
          if (mode === "runs") props.onMode("editor");
          onTapConnect({ type: "cancel" });
        }}
      />
      {props.banners}

      {shown === "runs" ? (
        <div className="flex min-h-0 flex-1">{props.runs}</div>
      ) : shown === "steps" ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <StepsView
            workflow={draft}
            problems={state.problems}
            summaryContext={props.summaryContext}
            selectedNodeId={inspectorFor}
            readOnly={readOnly}
            onOpenStep={openStep}
            onAddAfter={(from) => setAddTarget({ kind: "after", from })}
            onAddFirst={(kind) => setAddTarget({ kind: "first", triggers: kind === "trigger" })}
            onStepMenu={openMenu}
            triggerErrors={props.triggerErrors}
          />
        </div>
      ) : (
        <div className="relative min-h-0 flex-1">
          {props.renderCanvas(canvasHooks)}
          {tapConnect.mode === "picking" ? (
            <div className="pointer-events-none absolute inset-x-3 top-3 z-20 flex justify-center">
              <div
                role="status"
                className="pointer-events-auto flex w-full max-w-md items-center gap-2.5 rounded-2xl border border-info/40 bg-neutral-900/95 py-2 pl-3.5 pr-1.5 shadow-xl shadow-black/40 backdrop-blur"
              >
                <Cable size={17} aria-hidden className="shrink-0 text-info" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium leading-5 text-neutral-50">{prompt}</div>
                  <div className={tapConnect.refusal ? "text-xs leading-4 text-warn" : "text-xs leading-4 text-neutral-400"}>
                    {tapConnect.refusal ?? "Tap a highlighted block"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onTapConnect({ type: "cancel" })}
                  className="flex h-10 shrink-0 items-center gap-1 rounded-xl px-3 text-[13px] font-medium text-neutral-200 active:bg-neutral-800"
                >
                  <X size={15} aria-hidden /> Cancel
                </button>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {toast ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-[84px] z-30 flex justify-center px-4">
          <div role="status" className="rounded-full border border-neutral-800 bg-neutral-900/95 px-4 py-2 text-[13px] text-neutral-100 shadow-lg shadow-black/40">
            {toast}
          </div>
        </div>
      ) : null}

      {shown !== "runs" && tapConnect.mode === "idle" ? (
        <PhoneToolbar
          canvas={shown === "canvas"}
          readOnly={readOnly}
          canUndo={state.canUndo}
          canRedo={state.canRedo}
          onAdd={addFromToolbar}
          onUndo={() => editor.undo()}
          onRedo={() => editor.redo()}
          onFit={props.onFit}
          onTidy={props.onTidy}
          onRun={props.onRunNow}
          runRef={props.runButtonRef}
        />
      ) : null}

      {/* The inspector: a full-height sheet. */}
      <WorkflowSheet
        open={inspectorNode !== null && shown !== "runs"}
        onClose={closeInspector}
        label={inspectorNode ? `${inspectorNode.name} — settings` : "Settings"}
        title={null}
        size="full"
        scroll={false}
      >
        {inspectorNode ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <Inspector
              editor={editor}
              workflow={draft}
              selectedIds={[inspectorNode.id]}
              problems={state.problems}
              summaryContext={props.summaryContext}
              readOnly={readOnly}
              projectPath={props.workflowProject}
              secretNames={props.secretNames}
              onOpenSecrets={props.onSecrets}
              onOpenRun={(runId) => {
                setInspectorFor(null);
                props.onOpenRun(runId);
              }}
              onClose={closeInspector}
              onDeleteSelection={() => {
                const id = inspectorNode.id;
                setInspectorFor(null);
                editor.change((wf) => deleteStep(wf, id, editor.mintId), { select: EMPTY });
              }}
              onDuplicateSelection={() => {
                const result = editor.state.draft ? duplicateStepAfter(editor.state.draft, inspectorNode.id, editor.mintId) : null;
                if (result) editor.change(() => result.workflow);
              }}
              onToggleDisabled={() =>
                editor.change((wf) => setStepsDisabled(wf, [inspectorNode.id], !inspectorNode.disabled))
              }
              onSelectNode={openStep}
            />
          </div>
        ) : null}
      </WorkflowSheet>

      <AddBlockSheet
        open={addTarget !== null}
        onClose={() => setAddTarget(null)}
        context={addContext()}
        allowTriggers={addTarget?.kind === "at" || (addTarget?.kind === "first" && addTarget.triggers)}
        triggersOnly={addTarget?.kind === "first" && addTarget.triggers}
        onPick={pick}
      />

      <StepMenuSheet
        open={menu !== null && menuNode !== null}
        onClose={() => setMenu(null)}
        node={menuNode}
        readOnly={readOnly}
        canMove={menuNode !== null && !isTriggerType(menuNode.type)}
        onOpenSettings={() => menu && openStep(menu.nodeId)}
        onRename={() => menu && setPicker({ kind: "rename", nodeId: menu.nodeId })}
        onDuplicate={() => {
          if (!menu) return;
          const id = menu.nodeId;
          let created: string | null = null;
          editor.change((wf) => {
            const result = duplicateStepAfter(wf, id, editor.mintId);
            created = result?.nodeId ?? null;
            return result?.workflow ?? wf;
          });
          if (created) setToast("Duplicated — the copy is right after it");
        }}
        onToggleDisabled={() => {
          if (!menuNode) return;
          const id = menuNode.id;
          const off = !menuNode.disabled;
          editor.change((wf) => setStepsDisabled(wf, [id], off));
        }}
        onConnect={() => menu && startConnect(menu.nodeId, shown === "canvas" ? "tap" : "list")}
        onMove={() => menu && setPicker({ kind: "move", nodeId: menu.nodeId, current: menu.parent })}
        onDelete={() => {
          if (!menu) return;
          const id = menu.nodeId;
          const name = menuNode?.name ?? "The step";
          editor.change((wf) => deleteStep(wf, id, editor.mintId), { select: EMPTY });
          setToast(`${name} deleted — Undo brings it back`);
        }}
      />

      <RenameSheet
        open={picker?.kind === "rename"}
        onClose={() => setPicker(null)}
        node={picker?.kind === "rename" ? nodeOf(picker.nodeId) : null}
        workflow={draft}
        onRename={(name) => (picker?.kind === "rename" ? editor.applyOps([{ op: "rename_node", node: picker.nodeId, to: name }]) : null)}
      />
      <OutputPickSheet
        open={picker?.kind === "connect-output"}
        onClose={() => setPicker(null)}
        node={picker?.kind === "connect-output" ? nodeOf(picker.nodeId) : null}
        title="Connect which output?"
        onPick={(handle) => {
          if (picker?.kind !== "connect-output") return;
          const from = { nodeId: picker.nodeId, handle };
          if (picker.via === "tap") {
            setPicker(null);
            onTapConnect({ type: "start", from });
          } else setPicker({ kind: "connect", from });
        }}
      />
      <ConnectSheet
        open={picker?.kind === "connect"}
        onClose={() => setPicker(null)}
        workflow={draft}
        from={picker?.kind === "connect" ? picker.from : null}
        onPick={(targetId) => {
          if (picker?.kind !== "connect") return;
          const from = picker.from;
          setPicker(null);
          editor.change((wf) => connectStep(wf, from, targetId, editor.mintId));
          const target = nodeOf(targetId);
          if (target) setToast(`Connected to ${target.name}`);
        }}
      />
      <MoveSheet
        open={picker?.kind === "move"}
        onClose={() => setPicker(null)}
        workflow={draft}
        nodeId={picker?.kind === "move" ? picker.nodeId : null}
        current={picker?.kind === "move" ? picker.current : null}
        onPick={(to) => {
          if (picker?.kind !== "move") return;
          const { nodeId, current } = picker;
          setPicker(null);
          editor.change((wf) => moveStepToOutput(wf, nodeId, current, to, editor.mintId));
        }}
      />
    </div>
  );
};

/** A block dropped at a point (a long press on empty canvas): loose, where the finger was. */
function addAt(workflow: Workflow, type: WorkflowNodeType, request: AddMenuRequest, mintId: () => string): { workflow: Workflow; nodeId: string } {
  const at = request.flowPoint ?? { x: 0, y: 0 };
  return addBlock(workflow, type, { x: at.x - 120, y: at.y - 40 }, mintId);
}
