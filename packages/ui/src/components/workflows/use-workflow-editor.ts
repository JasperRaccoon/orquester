/**
 * The React side of the editor store: one `WorkflowEditor` per open workflow,
 * shared by every tab that shows it and disposed (after a last save) shortly
 * after the last one closes. Reloads after a reconnect, like the rest of the
 * workflows UI, unless there are unsaved edits.
 */

import { useEffect, useRef, useSyncExternalStore } from "react";

import { useApi } from "../../context/orquester-context";
import {
  retainWorkflowEditor,
  workflowEditorFor,
  type WorkflowEditor,
  type WorkflowEditorState
} from "../../lib/workflows/editor-store";
import { useAppStore } from "../../store/app";

export function useWorkflowEditor(workflowId: string): { editor: WorkflowEditor; state: WorkflowEditorState } {
  const api = useApi();
  const editor = workflowEditorFor(api, workflowId);

  useEffect(() => retainWorkflowEditor(editor), [editor]);

  const connected = useAppStore((state) => state.connectionStatus === "connected");
  const wasConnected = useRef(connected);
  useEffect(() => {
    if (connected && !wasConnected.current && !editor.state.dirty) void editor.load();
    wasConnected.current = connected;
  }, [connected, editor]);

  const state = useSyncExternalStore(editor.store.subscribe, editor.store.getState, editor.store.getState);
  return { editor, state };
}
