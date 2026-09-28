/**
 * The React side of the editor store: one `WorkflowEditor` per open workflow,
 * shared by every tab that shows it and disposed (after a last save) shortly
 * after the last one closes. The editor is keyed by the CONNECTION, not the
 * client: a reconnect rebuilds the client and hands it to the same editor, so
 * a draft being typed survives it. On reconnect a clean draft reloads and a
 * dirty one re-checks the daemon's revision, then saves again.
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
    if (connected && !wasConnected.current) void editor.onReconnect();
    wasConnected.current = connected;
  }, [connected, editor]);

  const state = useSyncExternalStore(editor.store.subscribe, editor.store.getState, editor.store.getState);
  return { editor, state };
}
