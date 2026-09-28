/**
 * The automated-workflow editor tab (workflows spec §7.2): toolbar, block
 * palette, canvas and inspector over one workflow's draft — autosaved,
 * undoable, validated live — and an Editor | Runs toggle.
 *
 * The props are the tab's contract with `MainView` (modelled on `GitView`):
 * `show` while the tab is visible (every visible grid cell), `active` while it
 * is the focused tab — keyboard shortcuts only then. `runId` opens the Runs
 * mode on that run.
 *
 * **Runs mode is a slot.** `renderRunsMode(ctx)` — or, for MainView, which
 * passes no such prop, a renderer registered once with
 * `registerWorkflowRunsMode` — draws it; without either, `RunsModeFallback`
 * (a runs list and the run's overlay on a read-only canvas).
 *
 * The root is a keyboard surface: the chat's chords stand down inside it, and
 * every popover and modal here holds an open layer.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { AlertTriangle, Loader2, RefreshCw, X } from "lucide-react";

import {
  autoLayout,
  hasWorkflowErrors,
  isRunActive,
  outputHandles,
  placeNewNodes,
  type Workflow,
  type WorkflowNodeType
} from "@orquester/api";

import { useApi } from "../../context/orquester-context";
import { KEYBOARD_SURFACE_PROPS } from "../../lib/keyboard-surfaces";
import { useProviderSnapshots } from "../../lib/agent-chat/hooks";
import { providerForRefId } from "../../lib/agent-chat/providers";
import { useSavedPrompts } from "../../lib/saved-prompts/hooks";
import { canvasFitOptions } from "../../lib/workflows/canvas-fit";
import { defaultAgentLabel, defaultModelLabel, type NodeSummaryContext } from "../../lib/workflows/catalog-ui";
import { triggerErrorsOf } from "../../lib/workflows/format";
import {
  duplicateWorkflowNodes,
  parseWorkflowClipboard,
  pasteWorkflowClipboard,
  serializeWorkflowSelection,
  WORKFLOW_CLIPBOARD_MIME
} from "../../lib/workflows/clipboard";
import type { EditorSelection } from "../../lib/workflows/editor-store";
import { useWorkflowSecrets, useWorkflowsState } from "../../lib/workflows/hooks";
import {
  clampInspectorWidth,
  INSPECTOR_DEFAULT_WIDTH,
  loadEditorLayout,
  saveEditorLayout,
  type WorkflowEditorLayout
} from "../../lib/workflows/inspector-layout";
import { subscribeWorkflowTabRun } from "../../lib/workflows/open-bridge";
import { runWorkflowNow } from "../../lib/workflows/store";
import { useAppStore } from "../../store/app";
import { WorkflowSecretsDialog } from "../right-rail/workflows/WorkflowSecretsDialog";
import { ResizeHandle } from "../ui/resize-handle";
import { AddBlockMenu } from "./AddBlockMenu";
import { BlockPalette } from "./BlockPalette";
import { CanvasHud } from "./CanvasHud";
import type { AddMenuRequest } from "./canvas/canvas-context";
import { addBlock, moveNodes, nudgeNodes, removeElements } from "./canvas/ops";
import { WorkflowCanvas, type WorkflowCanvasHandle } from "./canvas/WorkflowCanvas";
import { EditorToolbar, type EditorMode } from "./EditorToolbar";
import { Inspector } from "./inspector/Inspector";
import { PhoneEditor } from "./phone/PhoneEditor";
import { PhoneLayoutContext, useIsPhoneLayout } from "./phone/phone-context";
import { RunNowPopover, type RunNowResult } from "./RunNowPopover";
import { RunsModeFallback } from "./RunsModeFallback";
import { useWorkflowEditor } from "./use-workflow-editor";
import { WorkflowSettingsModal } from "./WorkflowSettingsModal";

// ---------------------------------------------------------------------------
// The Runs-mode slot
// ---------------------------------------------------------------------------

export interface WorkflowRunsModeContext {
  workflowId: string;
  /** The editor's draft (null while loading). */
  workflow: Workflow | null;
  /** The run to show (null: the renderer picks, e.g. the newest). */
  runId: string | null;
  selectRun: (runId: string | null) => void;
  /** Back to the editor, optionally selecting a block. */
  openEditor: (nodeId?: string) => void;
  /** The project the tab is open in. */
  projectPath: string;
  active: boolean;
  show: boolean;
  /** Block summaries in the editor's words (agent / model labels). */
  summaryContext: NodeSummaryContext;
}

export type WorkflowRunsModeRenderer = (context: WorkflowRunsModeContext) => React.ReactNode;

let registeredRunsMode: WorkflowRunsModeRenderer | null = null;

/** Plug the run view into every editor tab (MainView passes no `renderRunsMode`). `null` unplugs it. */
export function registerWorkflowRunsMode(renderer: WorkflowRunsModeRenderer | null): void {
  registeredRunsMode = renderer;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface WorkflowEditorTabProps {
  workflowId: string;
  /** The tab's own title — the workflow's name as last known. */
  title: string;
  /** The run the Runs mode shows, when one was asked for. */
  runId?: string | null;
  /** The project the tab is open in (the rail's), not necessarily the workflow's own. */
  projectPath: string;
  /** The focused tab. */
  active: boolean;
  /** Visible (the active tab, or any grid cell). */
  show: boolean;
  /** Draws Runs mode; else the registered renderer, else the built-in list + overlay. */
  renderRunsMode?: WorkflowRunsModeRenderer;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Copies made here outlive a clipboard the browser refuses to read. */
let memoryClipboard: string | null = null;

const EMPTY_SELECTION: EditorSelection = { nodeIds: [], edgeIds: [] };

function isEditable(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.closest !== "function") return false;
  if (element.isContentEditable) return true;
  return element.closest("input, textarea, select, [contenteditable='true'], .cm-editor") !== null;
}

function inCanvasZone(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element && typeof element.closest === "function" && element.closest("[data-wf-zone='canvas']") !== null;
}

const isMod = (event: KeyboardEvent | React.KeyboardEvent): boolean => event.metaKey || event.ctrlKey;

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

export const WorkflowEditorTab: React.FC<WorkflowEditorTabProps> = (props) => (
  <ReactFlowProvider>
    <EditorTab {...props} />
  </ReactFlowProvider>
);

const EditorTab: React.FC<WorkflowEditorTabProps> = ({ workflowId, title, runId = null, projectPath, active, show, renderRunsMode }) => {
  const api = useApi();
  const flow = useReactFlow();
  const { editor, state } = useWorkflowEditor(workflowId);
  const draft = state.draft;
  const readOnly = state.status !== "ready" || state.conflict !== null;

  const [layout, setLayoutState] = useState<WorkflowEditorLayout>(loadEditorLayout);
  const setLayout = useCallback((patch: Partial<WorkflowEditorLayout>, persist = true) => {
    setLayoutState((current) => {
      const next = { ...current, ...patch };
      if (persist) saveEditorLayout(next);
      return next;
    });
  }, []);

  const phone = useIsPhoneLayout();
  const [mode, setMode] = useState<EditorMode>(runId ? "runs" : "editor");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(runId);
  useEffect(() => {
    if (runId) {
      setMode("runs");
      setSelectedRunId(runId);
    }
  }, [runId]);
  // Asked to show a run the tab already names (a chip, a toast, a notification): show it again.
  useEffect(
    () =>
      subscribeWorkflowTabRun((target) => {
        if (target.workflowId !== workflowId) return;
        setMode("runs");
        setSelectedRunId(target.runId);
      }),
    [workflowId]
  );
  /** Pick a run: shown here, and remembered on the tab (it reopens on it). */
  const selectRun = useCallback(
    (id: string | null) => {
      setSelectedRunId(id);
      if (id && projectPath) useAppStore.getState().openWorkflowTab(projectPath, workflowId, { runId: id });
    },
    [projectPath, workflowId]
  );

  const [addMenu, setAddMenu] = useState<AddMenuRequest | null>(null);
  const [runNowOpen, setRunNowOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [secretsOpen, setSecretsOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const runButton = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<WorkflowCanvasHandle | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const zoneRef = useRef<HTMLDivElement | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const inspectorWidth = useRef(layout.inspectorWidth);
  inspectorWidth.current = layout.inspectorWidth;

  // -------------------------------------------------------------------------
  // What the editor knows about the world around the workflow
  // -------------------------------------------------------------------------

  const workflows = useWorkflowsState();
  const summary = workflows.summaries.get(workflowId);
  const liveRuns = summary?.activeRuns.filter((run) => isRunActive(run.status)).length ?? 0;
  const summaryTriggers = summary?.triggers;
  const triggerErrors = useMemo(() => triggerErrorsOf(summaryTriggers ? { triggers: summaryTriggers } : null), [summaryTriggers]);
  const workflowProject = draft?.project.kind === "existing" ? draft.project.projectPath : projectPath;
  const secrets = useWorkflowSecrets(workflowId);
  const secretNames = useMemo(() => [...new Set(secrets.secrets.map((secret) => secret.name))].sort(), [secrets.secrets]);
  const savedPrompts = useSavedPrompts(workflowProject);

  useEffect(() => {
    editor.setValidationContext({
      ...(secrets.status === "loaded" ? { secretNames } : {}),
      ...(savedPrompts.status === "loaded" ? { savedPromptIds: savedPrompts.prompts.map((prompt) => prompt.id) } : {}),
      ...(workflows.load.status === "loaded" ? { knownWorkflowIds: [...workflows.summaries.keys()] } : {})
    });
  }, [editor, secrets.status, secretNames, savedPrompts.status, savedPrompts.prompts, workflows.load.status, workflows.summaries]);

  const registryAgents = useAppStore((s) => s.registry.agents);
  const providers = useProviderSnapshots();
  const summaryContext = useMemo<NodeSummaryContext>(() => {
    const projectName = workflowProject.replace(/\/+$/, "").split("/").pop() || undefined;
    return {
      agentLabel: (refId) => registryAgents.find((agent) => agent.id === refId)?.name ?? defaultAgentLabel(refId),
      modelLabel: (refId, slug) => {
        const model = providerForRefId(providers, refId)?.models.find((candidate) => candidate.slug === slug);
        return model?.shortName ?? model?.name ?? defaultModelLabel(slug);
      },
      optionLabel: (refId, slug, optionId, value) => {
        const model = providerForRefId(providers, refId)?.models.find((candidate) => candidate.slug === slug);
        const descriptor = model?.capabilities?.optionDescriptors?.find((entry) => entry.id === optionId);
        return descriptor?.type === "select" ? descriptor.options.find((choice) => choice.id === value)?.label : undefined;
      },
      workflowName: (id) => workflows.summaries.get(id)?.name,
      ...(projectName ? { projectName } : {})
    };
  }, [registryAgents, providers, workflows.summaries, workflowProject]);

  const errorCount = useMemo(() => state.problems.filter((problem) => problem.severity === "error").length, [state.problems]);
  const enableRefusal = hasWorkflowErrors(state.problems)
    ? `Fix ${errorCount === 1 ? "the problem" : `the ${errorCount} problems`} marked in red to enable it.`
    : null;

  // -------------------------------------------------------------------------
  // Edits
  // -------------------------------------------------------------------------

  const select = useCallback((selection: EditorSelection) => editor.select(selection), [editor]);

  const viewportCenter = useCallback((): { x: number; y: number } => {
    const rect = zoneRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }, [flow]);

  /** Add a block: at a point, after an output, or into an edge; then select it. */
  const insertBlock = useCallback(
    (type: WorkflowNodeType, request: Omit<AddMenuRequest, "clientPoint"> & { flowPoint?: { x: number; y: number } }) => {
      let newId: string | null = null;
      editor.change((current) => {
        const wired = Boolean(request.from || request.intoEdgeId);
        const position = request.flowPoint ?? { x: 0, y: 0 };
        const added = addBlock(current, type, position, editor.mintId, {
          ...(request.from ? { from: request.from } : {}),
          ...(request.intoEdgeId ? { intoEdgeId: request.intoEdgeId } : {})
        });
        newId = added.nodeId;
        if (!wired && request.flowPoint) return added.workflow;
        // Wired, or no point: place it beside what it connects to, clear of other blocks.
        const positions = placeNewNodes(added.workflow, [added.nodeId]);
        let placed = added.workflow;
        const at = positions[added.nodeId];
        if (at) {
          // A second or third output (false, failure, a case) starts lower down.
          const offset = request.from
            ? Math.max(0, outputHandles(current.nodes.find((node) => node.id === request.from!.nodeId) ?? { id: "", type: "agent" }).indexOf(request.from.handle)) * 128
            : 0;
          placed = {
            ...placed,
            nodes: placed.nodes.map((node) => (node.id === added.nodeId ? { ...node, position: { x: at.x, y: at.y + offset } } : node))
          };
        }
        return placed;
      });
      if (newId) editor.select({ nodeIds: [newId], edgeIds: [] });
      setAddMenu(null);
    },
    [editor]
  );

  const addFromPalette = useCallback(
    (type: WorkflowNodeType) => {
      if (readOnly || !draft) return;
      // After the selected block's first free output, when one is selected and can take this.
      const selected = state.selection.nodeIds.length === 1 ? draft.nodes.find((node) => node.id === state.selection.nodeIds[0]) : undefined;
      const takesInput = !type.startsWith("trigger.") && type !== "note";
      if (selected && takesInput) {
        const handles = outputHandles(selected);
        const free = handles.find((handle) => !draft.edges.some((edge) => edge.source === selected.id && edge.sourceHandle === handle));
        if (free) {
          insertBlock(type, { from: { nodeId: selected.id, handle: free } });
          return;
        }
      }
      const center = viewportCenter();
      insertBlock(type, { flowPoint: { x: center.x - 120, y: center.y - 48 } });
    },
    [readOnly, draft, state.selection.nodeIds, insertBlock, viewportCenter]
  );

  const deleteSelection = useCallback(() => {
    const { nodeIds, edgeIds } = editor.state.selection;
    if (nodeIds.length === 0 && edgeIds.length === 0) return;
    editor.change((current) => removeElements(current, nodeIds, edgeIds), { select: EMPTY_SELECTION });
  }, [editor]);

  const duplicateSelection = useCallback(() => {
    const ids = editor.state.selection.nodeIds;
    let created: string[] = [];
    editor.change((current) => {
      const result = duplicateWorkflowNodes(current, ids, editor.mintId);
      if (!result) return current;
      created = result.nodeIds;
      return result.workflow;
    });
    if (created.length > 0) editor.select({ nodeIds: created, edgeIds: [] });
  }, [editor]);

  const toggleDisabledSelection = useCallback(() => {
    const ids = new Set(editor.state.selection.nodeIds);
    editor.change((current) => {
      const chosen = current.nodes.filter((node) => ids.has(node.id));
      const disable = chosen.some((node) => !node.disabled);
      return {
        ...current,
        nodes: current.nodes.map((node) => {
          if (!ids.has(node.id)) return node;
          const { disabled: _old, ...rest } = node;
          return (disable ? { ...rest, disabled: true } : rest) as typeof node;
        })
      };
    });
  }, [editor]);

  const paste = useCallback(
    (text: string | null) => {
      const clip = parseWorkflowClipboard(text ?? memoryClipboard);
      if (!clip) return false;
      const rect = zoneRef.current?.getBoundingClientRect();
      const at =
        pointer.current && rect && pointer.current.x >= rect.left && pointer.current.x <= rect.right && pointer.current.y >= rect.top && pointer.current.y <= rect.bottom
          ? flow.screenToFlowPosition(pointer.current)
          : null;
      let created: string[] = [];
      editor.change((current) => {
        const result = pasteWorkflowClipboard(current, clip, { mintId: editor.mintId, at });
        created = result.nodeIds;
        return result.workflow;
      });
      editor.select({ nodeIds: created, edgeIds: [] });
      return true;
    },
    [editor, flow]
  );

  const fit = useCallback(
    (duration = 300) => {
      const current = editor.state.draft;
      if (!current) return;
      // Fit shows the whole graph; on a phone that may go smaller than its opening frame.
      const options = canvasFitOptions(current);
      void flow.fitView({ padding: options.padding, maxZoom: options.maxZoom, minZoom: phone ? 0.2 : options.minZoom, duration });
    },
    [editor, flow, phone]
  );

  const tidy = useCallback(() => {
    if (!editor.state.draft) return;
    const selected = editor.state.selection.nodeIds;
    const positions = autoLayout(editor.state.draft, selected.length > 1 ? { onlyNodeIds: selected } : {});
    if (canvasRef.current) {
      canvasRef.current.animateTo(positions);
      setTimeout(() => fit(320), 360);
    } else {
      // No canvas on screen (the phone's Steps view): lay it out at once.
      editor.change((current) => moveNodes(current, positions));
    }
  }, [editor, fit]);

  // -------------------------------------------------------------------------
  // Keyboard and clipboard (only while this is the focused tab)
  // -------------------------------------------------------------------------

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (!active || mode !== "editor" || isEditable(event.target)) return;
    const onCanvas = inCanvasZone(event.target) || event.target === rootRef.current;
    if (!onCanvas) return;
    const key = event.key;
    const mod = isMod(event);
    if (mod && !event.altKey) {
      const lower = key.toLowerCase();
      if (lower === "z" && !event.shiftKey) {
        event.preventDefault();
        if (!readOnly) editor.undo();
      } else if ((lower === "z" && event.shiftKey) || lower === "y") {
        event.preventDefault();
        if (!readOnly) editor.redo();
      } else if (lower === "a") {
        event.preventDefault();
        if (draft) editor.select({ nodeIds: draft.nodes.map((node) => node.id), edgeIds: [] });
      } else if (lower === "d") {
        event.preventDefault();
        if (!readOnly) duplicateSelection();
      }
      return;
    }
    if (key === "Delete" || key === "Backspace") {
      event.preventDefault();
      if (!readOnly) deleteSelection();
    } else if (key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      if (readOnly) return;
      const rect = zoneRef.current?.getBoundingClientRect();
      const at = pointer.current ?? (rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: 200, y: 200 });
      setAddMenu({ clientPoint: at, flowPoint: flow.screenToFlowPosition(at) });
    } else if (key.startsWith("Arrow") && editor.state.selection.nodeIds.length > 0) {
      event.preventDefault();
      if (readOnly) return;
      const step = event.shiftKey ? 10 : 1;
      const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
      const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
      const ids = editor.state.selection.nodeIds;
      editor.change((current) => nudgeNodes(current, ids, dx, dy), { coalesce: "nudge" });
    } else if (key === "Escape") {
      if (editor.state.selection.nodeIds.length > 0 || editor.state.selection.edgeIds.length > 0) {
        event.preventDefault();
        editor.select(EMPTY_SELECTION);
      }
    } else if (key === "!" || (key === "1" && event.shiftKey)) {
      event.preventDefault();
      fit();
    }
  };

  useEffect(() => {
    if (!active || mode !== "editor") return;
    const owns = (): boolean => {
      const focused = document.activeElement;
      return !isEditable(focused) && (inCanvasZone(focused) || focused === rootRef.current);
    };
    const onCopy = (event: ClipboardEvent): void => {
      if (!owns() || !editor.state.draft) return;
      const text = serializeWorkflowSelection(editor.state.draft, editor.state.selection.nodeIds);
      if (text === null) return;
      event.preventDefault();
      memoryClipboard = text;
      event.clipboardData?.setData("text/plain", text);
      try {
        event.clipboardData?.setData(WORKFLOW_CLIPBOARD_MIME, text);
      } catch {
        // Some browsers refuse custom types; text/plain carries the marker.
      }
      if (event.type === "cut" && !readOnly) deleteSelection();
    };
    const onPaste = (event: ClipboardEvent): void => {
      if (!owns() || readOnly) return;
      const text = event.clipboardData?.getData(WORKFLOW_CLIPBOARD_MIME) || event.clipboardData?.getData("text/plain") || null;
      if (paste(text)) event.preventDefault();
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCopy);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCopy);
      document.removeEventListener("paste", onPaste);
    };
  }, [active, mode, editor, readOnly, deleteSelection, paste]);

  // A tab first shown after it mounted hidden has never been fitted.
  const fitted = useRef(false);
  useEffect(() => {
    // A phone's canvas mounts (and frames itself) only when it is picked.
    if (phone || !show || mode !== "editor" || !draft || fitted.current) return;
    fitted.current = true;
    const options = canvasFitOptions(draft);
    const frame = requestAnimationFrame(() => void flow.fitView(options));
    return () => cancelAnimationFrame(frame);
  }, [show, mode, draft, flow, phone]);

  // -------------------------------------------------------------------------
  // Run now / enable
  // -------------------------------------------------------------------------

  const manualExample = useMemo(() => {
    const manual = draft?.nodes.find((node) => node.type === "trigger.manual");
    return manual && manual.type === "trigger.manual" ? (manual.config.inputExample ?? "") : "";
  }, [draft]);

  const runNow = useCallback(
    async (input: unknown, options: { force: boolean }): Promise<RunNowResult> => {
      await editor.flush();
      const result = await runWorkflowNow(api, workflowId, {
        ...(input !== undefined ? { input } : {}),
        ...(options.force ? { force: true } : {})
      });
      if (!result.ok) return { ok: false, error: result.error };
      const answer = result.value;
      if (answer.runId) {
        selectRun(answer.runId);
        setMode("runs");
      }
      return { ok: true, runId: answer.runId, ...(answer.skipped ? { skipped: answer.skipped } : {}) };
    },
    [api, editor, workflowId, selectRun]
  );

  const toggleEnabled = useCallback(
    async (enabled: boolean) => {
      const refusal = await editor.setEnabled(enabled);
      if (refusal) setMessage(refusal);
    },
    [editor]
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const openRun = useCallback(
    (id: string) => {
      selectRun(id);
      setMode("runs");
    },
    [selectRun]
  );

  const runsContext: WorkflowRunsModeContext = {
    workflowId,
    workflow: draft,
    runId: selectedRunId,
    selectRun,
    openEditor: (nodeId) => {
      setMode("editor");
      if (nodeId) editor.select({ nodeIds: [nodeId], edgeIds: [] });
    },
    projectPath,
    active,
    show,
    summaryContext
  };
  const runsRenderer = renderRunsMode ?? registeredRunsMode;

  const selection = state.selection;
  const emptyHint = draft !== null && draft.nodes.filter((node) => node.type !== "note").length <= 1 && draft.edges.length === 0;
  const fromNode = addMenu?.from ? draft?.nodes.find((node) => node.id === addMenu.from!.nodeId) : undefined;
  const addContext = fromNode
    ? `After ${fromNode.name}${outputHandles(fromNode).length > 1 ? ` · ${addMenu?.from?.handle === "error" ? "failure" : addMenu?.from?.handle}` : ""}`
    : addMenu?.intoEdgeId
      ? "Insert on the connection"
      : null;

  if (state.status === "loading" && !draft) {
    return (
      <div {...KEYBOARD_SURFACE_PROPS} className="flex h-full w-full items-center justify-center bg-neutral-950 text-sm text-neutral-500">
        <Loader2 size={16} className="mr-2 motion-safe:animate-spin" />
        Opening {summary?.name ?? title}…
      </div>
    );
  }
  if (!draft) {
    return (
      <div {...KEYBOARD_SURFACE_PROPS} className="flex h-full w-full flex-col items-center justify-center gap-3 bg-neutral-950 px-6 text-center">
        <AlertTriangle size={20} className="text-warn" />
        <div className="text-sm text-neutral-200">{summary?.name ?? title}</div>
        <p className="max-w-sm text-xs text-neutral-500">{state.loadError ?? "The workflow could not be opened."}</p>
        <button
          type="button"
          onClick={() => void editor.load()}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-800 px-3 text-xs text-neutral-200 hover:bg-neutral-900"
        >
          <RefreshCw size={12} /> Try again
        </button>
      </div>
    );
  }

  const banners = (
    <>
      {state.conflict ? (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-warn/30 bg-warn-soft/25 px-4 py-2 text-[12.5px] text-warn">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="min-w-0 flex-1">
            Changed elsewhere (e.g. by an agent through MCP). Your edits are not saved.
          </span>
          <button type="button" onClick={() => void editor.reload()} className="h-7 rounded-md px-2.5 font-medium text-neutral-100 hover:bg-neutral-800">
            Reload
          </button>
          <button
            type="button"
            onClick={() => void editor.keepMine()}
            className="h-7 rounded-md border border-warn/40 px-2.5 font-medium text-warn hover:bg-warn-soft/30"
          >
            Keep mine (overwrite)
          </button>
        </div>
      ) : null}
      {state.notice || message || (state.loadError && draft) ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-neutral-800 bg-neutral-900 px-4 py-2 text-[12.5px] text-neutral-300">
          <span className="min-w-0 flex-1">{message ?? state.notice ?? state.loadError}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              setMessage(null);
              editor.dismissNotice();
            }}
            className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100"
          >
            <X size={13} />
          </button>
        </div>
      ) : null}

    </>
  );

  const runsContent = runsRenderer ? (
    runsRenderer(runsContext)
  ) : (
    <RunsModeFallback workflowId={workflowId} runId={selectedRunId} onSelectRun={selectRun} summaryContext={summaryContext} show={show} />
  );

  const overlays = (
    <>
      <AddBlockMenu
        open={addMenu !== null}
        point={addMenu?.clientPoint ?? { x: 0, y: 0 }}
        allowTriggers={!addMenu?.from && !addMenu?.intoEdgeId}
        context={addContext}
        onClose={() => setAddMenu(null)}
        onPick={(type) =>
          addMenu &&
          insertBlock(type, {
            ...(addMenu.flowPoint && !addMenu.from && !addMenu.intoEdgeId
              ? { flowPoint: { x: addMenu.flowPoint.x - 120, y: addMenu.flowPoint.y - 40 } }
              : addMenu.flowPoint
                ? { flowPoint: addMenu.flowPoint }
                : {}),
            ...(addMenu.from ? { from: addMenu.from } : {}),
            ...(addMenu.intoEdgeId ? { intoEdgeId: addMenu.intoEdgeId } : {})
          })
        }
      />
      <RunNowPopover
        open={runNowOpen}
        anchor={runButton.current}
        onClose={() => setRunNowOpen(false)}
        example={manualExample}
        blockingErrors={errorCount}
        onRun={runNow}
      />
      <WorkflowSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        editor={editor}
        workflow={draft}
        readOnly={readOnly}
        onOpenSecrets={() => setSecretsOpen(true)}
        defaultProjectPath={projectPath}
      />
      {secretsOpen ? (
        <WorkflowSecretsDialog workflows={summary ? [summary] : []} initialWorkflowId={workflowId} onClose={() => setSecretsOpen(false)} />
      ) : null}
    </>
  );

  if (phone) {
    const tab = useAppStore.getState().workflowTabsByProject[projectPath]?.find((candidate) => candidate.workflowId === workflowId);
    return (
      <PhoneLayoutContext.Provider value={true}>
        <div ref={rootRef} {...KEYBOARD_SURFACE_PROPS} tabIndex={-1} className="wf-touch flex h-full w-full min-w-0 flex-col bg-neutral-950 outline-none">
          <PhoneEditor
            editor={editor}
            state={state}
            draft={draft}
            readOnly={readOnly}
            summaryContext={summaryContext}
            workflowProject={workflowProject}
            secretNames={secretNames}
            mode={mode}
            onMode={setMode}
            liveRuns={liveRuns}
            triggerErrors={triggerErrors}
            enableRefusal={enableRefusal}
            onToggleEnabled={(enabled) => void toggleEnabled(enabled)}
            banners={banners}
            runs={runsContent}
            renderCanvas={(hooks) => (
              <div ref={zoneRef} data-wf-zone="canvas" tabIndex={-1} className="relative h-full w-full outline-none">
                <WorkflowCanvas
                  ref={canvasRef}
                  workflow={draft}
                  problems={state.problems}
                  triggerErrors={triggerErrors}
                  readOnly={readOnly}
                  selection={selection}
                  onSelectionChange={select}
                  onChange={(recipe, options) => editor.change(recipe, options)}
                  mintId={editor.mintId}
                  summaryContext={summaryContext}
                  onOpenAddMenu={hooks.onOpenAddMenu}
                  minimap={false}
                  hint={emptyHint}
                  phone
                  onNodeTap={hooks.onNodeTap}
                  onLongPressNode={hooks.onLongPressNode}
                  onLongPressPane={hooks.onLongPressPane}
                  tapConnect={hooks.tapConnect}
                  onTapConnect={hooks.onTapConnect}
                />
              </div>
            )}
            runButtonRef={runButton}
            onRunNow={() => setRunNowOpen((open) => !open)}
            onSettings={() => setSettingsOpen(true)}
            onSecrets={() => setSecretsOpen(true)}
            onOpenRun={openRun}
            onTidy={tidy}
            onFit={() => fit()}
            onClose={tab ? () => void useAppStore.getState().closeTab(tab.id) : null}
          />
          {overlays}
        </div>
      </PhoneLayoutContext.Provider>
    );
  }

  return (
    <div
      ref={rootRef}
      {...KEYBOARD_SURFACE_PROPS}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex h-full w-full min-w-0 flex-col bg-neutral-950 outline-none"
    >
      <EditorToolbar
        name={draft.name}
        onRename={(name) => editor.change((current) => ({ ...current, name }))}
        enabled={draft.enabled}
        onToggleEnabled={(enabled) => void toggleEnabled(enabled)}
        enableRefusal={enableRefusal}
        saveState={state.saveState}
        saveError={state.saveError}
        onRetrySave={() => void editor.flush()}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
        onUndo={() => editor.undo()}
        onRedo={() => editor.redo()}
        onTidy={tidy}
        onZoomIn={() => void flow.zoomIn({ duration: 180 })}
        onZoomOut={() => void flow.zoomOut({ duration: 180 })}
        onFit={() => fit()}
        mode={mode}
        onMode={setMode}
        liveRuns={liveRuns}
        runButtonRef={runButton}
        onRunNow={() => setRunNowOpen((open) => !open)}
        onSettings={() => setSettingsOpen(true)}
        readOnly={state.status !== "ready"}
      />

      {banners}

      {mode === "runs" ? (
        <div className="flex min-h-0 flex-1">
          {runsContent}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <BlockPalette open={layout.paletteOpen} onToggle={() => setLayout({ paletteOpen: !layout.paletteOpen })} onAdd={addFromPalette} disabled={readOnly} />
          <div
            ref={zoneRef}
            data-wf-zone="canvas"
            tabIndex={-1}
            className="relative min-w-0 flex-1 outline-none"
            onPointerDown={(event) => {
              if (!isEditable(event.target)) zoneRef.current?.focus({ preventScroll: true });
            }}
          >
            <WorkflowCanvas
              ref={canvasRef}
              workflow={draft}
              problems={state.problems}
              triggerErrors={triggerErrors}
              readOnly={readOnly}
              selection={selection}
              onSelectionChange={select}
              onChange={(recipe, options) => editor.change(recipe, options)}
              mintId={editor.mintId}
              summaryContext={summaryContext}
              onOpenAddMenu={setAddMenu}
              onDropBlock={(type, flowPoint) => insertBlock(type, { flowPoint })}
              onNodeDoubleClick={(nodeId) => editor.select({ nodeIds: [nodeId], edgeIds: [] })}
              minimap={layout.minimap}
              onToggleMinimap={() => setLayout({ minimap: !layout.minimap })}
              hint={emptyHint}
              onPointerMove={(point) => {
                pointer.current = point;
              }}
            />
            <CanvasHud
              problems={state.problems}
              nodeName={(nodeId) => draft.nodes.find((node) => node.id === nodeId)?.name}
              onSelectNode={(nodeId) => editor.select({ nodeIds: [nodeId], edgeIds: [] })}
            />
            {emptyHint && !readOnly ? (
              <div className="pointer-events-none absolute inset-x-0 top-5 flex justify-center">
                <div className="rounded-full border border-neutral-800 bg-neutral-900/90 px-3.5 py-1.5 text-[12px] text-neutral-400 shadow-lg shadow-black/20 backdrop-blur">
                  Click <span className="font-medium text-neutral-200">+</span> after the trigger to add the first step — or drag one in from the left.
                </div>
              </div>
            ) : null}
          </div>
          {selection.nodeIds.length > 0 ? (
            <div
              className="relative flex shrink-0 flex-col border-l border-neutral-800 bg-neutral-950"
              style={{ width: layout.inspectorWidth || INSPECTOR_DEFAULT_WIDTH }}
            >
              <ResizeHandle
                orientation="vertical"
                aria-label="Resize the inspector"
                className="absolute inset-y-0 left-0 z-10"
                getCurrent={() => -inspectorWidth.current}
                clamp={(next) => -clampInspectorWidth(-next)}
                onResize={(next) => setLayout({ inspectorWidth: clampInspectorWidth(-next) }, false)}
                onCommit={(next) => setLayout({ inspectorWidth: clampInspectorWidth(-next) })}
                onReset={() => setLayout({ inspectorWidth: INSPECTOR_DEFAULT_WIDTH })}
              />
              <Inspector
                editor={editor}
                workflow={draft}
                selectedIds={selection.nodeIds}
                problems={state.problems}
                readOnly={readOnly}
                projectPath={workflowProject}
                secretNames={secretNames}
                onOpenSecrets={() => setSecretsOpen(true)}
                onOpenRun={openRun}
                onClose={() => editor.select(EMPTY_SELECTION)}
                onDeleteSelection={deleteSelection}
                onDuplicateSelection={duplicateSelection}
                onToggleDisabled={toggleDisabledSelection}
                onSelectNode={(nodeId) => editor.select({ nodeIds: [nodeId], edgeIds: [] })}
              />
            </div>
          ) : null}
        </div>
      )}

      {overlays}
    </div>
  );
};
