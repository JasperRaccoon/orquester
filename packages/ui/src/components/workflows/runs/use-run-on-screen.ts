/**
 * A run view reports what it shows (workflows spec §5.11): the run on screen
 * gets no toast when it finishes, and a finished run the user actually looks
 * at has its toast and Attention entry cleared. "On screen" means the tab is
 * in Runs mode (only then is a run view mounted), the tab is shown, and the
 * document is visible — never a hidden tab, and never a live run glanced at
 * once: a live run is judged when it finishes.
 */

import { useEffect, useState, useSyncExternalStore } from "react";

import { markWorkflowRunViewed, setRunOnScreen } from "../../../lib/workflows/notifications";

function subscribeVisibility(listener: () => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

const documentVisible = (): boolean => typeof document === "undefined" || document.visibilityState !== "hidden";

export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, documentVisible, () => true);
}

export function useRunOnScreen(runId: string | null, shown: boolean, finished: boolean): void {
  const [owner] = useState(() => ({}));
  const visible = useDocumentVisible();
  useEffect(() => {
    setRunOnScreen(owner, shown && runId ? runId : null);
    return () => setRunOnScreen(owner, null);
  }, [owner, runId, shown]);
  useEffect(() => {
    if (runId && shown && visible && finished) markWorkflowRunViewed(runId, { finished: true });
  }, [runId, shown, visible, finished]);
}
