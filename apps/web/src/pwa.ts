// Service-worker registration for the web host only. Guarded by import.meta.env.PROD
// so the SW (which lives in dist/) is never registered in dev, and by feature
// detection so unsupported browsers are a no-op. Registration lives in the web
// host exclusively — the Electron/desktop renderer never imports this.
import { parseWorkflowRunMessage, requestWorkflowDeepLink } from "@orquester/ui";

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  // A workflow run's notification clicked while this window was open: the
  // service worker focuses it and says which run to show.
  navigator.serviceWorker.addEventListener("message", (event) => {
    const link = parseWorkflowRunMessage(event.data);
    if (link) requestWorkflowDeepLink(link);
  });
  navigator.serviceWorker.startMessages?.();
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // A failed SW registration must not break the app; it degrades to a
      // plain (non-installable, no-push) web client.
    });
  });
}
