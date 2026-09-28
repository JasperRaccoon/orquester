import {
  OrquesterApp,
  createLocalStorageAppConfigAdapter,
  parseWorkflowDeepLink,
  requestWorkflowDeepLink,
  stripWorkflowDeepLink
} from "@orquester/ui";
import React from "react";
import ReactDOM from "react-dom/client";
import { registerServiceWorker } from "./pwa";
import "./styles.css";

registerServiceWorker();

// A workflow run's notification opened a fresh window on `/?workflow=…&run=…`:
// the app opens it once it is connected; the address bar drops the link so a
// reload does not open it again.
const workflowLink = parseWorkflowDeepLink(window.location.search);
if (workflowLink) {
  requestWorkflowDeepLink(workflowLink);
  window.history.replaceState(window.history.state, "", stripWorkflowDeepLink(window.location.href));
}

// When served by the daemon itself the API is same-origin; in standalone dev
// VITE_ORQUESTER_API_URL points at the daemon. A password-protected daemon
// triggers an in-app prompt (the bearer is a stored bcrypt hash).
const endpoint = import.meta.env.VITE_ORQUESTER_API_URL ?? window.location.origin;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <OrquesterApp
      runtime="web"
      appConfigAdapter={createLocalStorageAppConfigAdapter()}
      initialConnection={{
        id: "remote",
        name: "Remote server",
        kind: "remote",
        endpoint,
        status: "disconnected"
      }}
    />
  </React.StrictMode>
);
