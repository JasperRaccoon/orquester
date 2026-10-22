import {
  OrquesterApp,
  createLocalStorageAppConfigAdapter,
  parseSessionDeepLink,
  parseWorkflowDeepLink,
  requestSessionDeepLink,
  requestWorkflowDeepLink,
  stripSessionDeepLink,
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

// A session's notification opened a fresh window on `/?session=<id>`: the
// same, for that session's tab.
const sessionLink = parseSessionDeepLink(window.location.search);
if (sessionLink) {
  requestSessionDeepLink(sessionLink);
  window.history.replaceState(window.history.state, "", stripSessionDeepLink(window.location.href));
}

// When served by the daemon itself the API is same-origin; in standalone dev
// VITE_ORQUESTER_API_URL points at the daemon. A password-protected daemon
// triggers an in-app sign-in (the bearer is a stored, revocable session token).
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
