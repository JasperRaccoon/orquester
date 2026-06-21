import { OrquesterApp, type UiConnection, type WindowControls } from "@orquester/ui";
import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { UnixSocketTransporter, type DesktopBridge } from "./transport/unix-socket-transporter";
import { NodeHttpClient } from "./transport/node-http-client";

const desktopBridge = window.orquesterDesktop;
const transporter = new UnixSocketTransporter(desktopBridge);
// Remote servers (the VPS) are reached over HTTP. The renderer is cross-origin
// to the daemon and the daemon serves no CORS headers, so route remote REST +
// the event stream through the main process (Node) where there is no CORS gate.
const httpClient = new NodeHttpClient(desktopBridge);

// Desktop persists app config + remotes on the local daemon (app.json /
// remotes.json under the appdir), so no client-side adapters are needed.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <OrquesterApp
      runtime="desktop"
      useTitlebar
      initialConnection={desktopBridge.defaultConnection}
      transporter={transporter}
      httpClient={httpClient}
      windowControls={desktopBridge.windowControls}
    />
  </React.StrictMode>
);

declare global {
  interface Window {
    orquesterDesktop: DesktopBridge & {
      runtime: "desktop";
      dataDir?: string;
      socketPath?: string;
      defaultConnection: UiConnection;
      windowControls: WindowControls;
    };
  }
}
