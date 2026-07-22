import React, { useEffect, useState } from "react";
import { AppWrapper, AppShell } from "./components/layout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { OrquesterProvider, type WindowControls } from "./context/orquester-context";
import { ApiClient } from "./lib/api-client";
import { createTransporter } from "./lib/transporters";
import type { AppConfigAdapter } from "./lib/app-config";
import { useAppStore } from "./store/app";
import type { HttpClient } from "./lib/http-client";
import type { Transporter } from "./lib/transporter";
import type { Runtime, UiConnection } from "./types";
import "./styles/globals.css";

export interface OrquesterAppProps {
  /** Which shell is hosting the UI. */
  runtime: Runtime;
  /** The default/local daemon connection (always present, not removable). */
  initialConnection: UiConnection;
  /** Render a custom (frameless) titlebar. Defaults to true on desktop. */
  useTitlebar?: boolean;
  /** Transport for the local connection (e.g. the desktop unix-socket transporter). */
  transporter?: Transporter;
  /** Custom HTTP client for remote transporters. */
  httpClient?: HttpClient;
  /** Native window controls bridge (desktop only). */
  windowControls?: WindowControls;
  /**
   * App-config persistence. Web passes a localStorage adapter; desktop omits it
   * so app config lives on the daemon (app.json). Remotes always live on the daemon.
   */
  appConfigAdapter?: AppConfigAdapter;
}

export const OrquesterApp: React.FC<OrquesterAppProps> = ({
  runtime,
  initialConnection,
  useTitlebar,
  transporter,
  httpClient,
  windowControls,
  appConfigAdapter
}) => {
  // A boot ApiClient so context always has one before the store initializes.
  const [bootApi] = useState(
    () =>
      new ApiClient(
        initialConnection,
        transporter ?? createTransporter(initialConnection, { httpClient })
      )
  );
  const storeApi = useAppStore((s) => s.api);
  const api = storeApi ?? bootApi;

  const defaultTitlebar = useTitlebar ?? runtime === "desktop";
  // Live value from app config (settings can toggle it).
  const titlebar = useAppStore((s) => s.appConfig.useTitlebar);

  // Set up connections, then connect (app config + remotes load from the daemon).
  useEffect(() => {
    void useAppStore.getState().initConnections({
      localConnection: initialConnection,
      localTransporter: transporter,
      httpClient,
      appConfigAdapter,
      defaultUseTitlebar: defaultTitlebar
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Instant reconnect on tab/app return. Mobile browsers freeze hidden tabs and
  // kill their sockets/streams, so every timer-driven recovery path stalls until
  // the page thaws. All regain signals route to one debounced wake: iOS fires
  // pageshow/focus more reliably than visibilitychange (WebKit 202399), Chrome
  // adds "resume" after a freeze, and "online" covers radio/NAT changes.
  useEffect(() => {
    const wake = () => useAppStore.getState().wakeConnections();
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        wake();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("resume", wake);
    window.addEventListener("pageshow", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("resume", wake);
      window.removeEventListener("pageshow", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    };
  }, []);

  // Global stray-drop guard. A file dropped OUTSIDE a registered drop zone (the
  // file browser, a terminal) would otherwise hit the browser default and, in
  // the web client, navigate the whole SPA to the file:// URL — destroying the
  // app. The real zones preventDefault on their own handlers and do the upload;
  // this is a backstop that neutralizes any FILE drag/drop bubbling to the
  // window. Scoped to drags carrying Files, so text drag-drop into inputs /
  // editors is unaffected; preventDefault here doesn't undo a zone's handling.
  useEffect(() => {
    const hasFiles = (e: DragEvent) =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    const neutralize = (e: DragEvent) => {
      if (hasFiles(e)) {
        e.preventDefault();
      }
    };
    window.addEventListener("dragover", neutralize);
    window.addEventListener("drop", neutralize);
    return () => {
      window.removeEventListener("dragover", neutralize);
      window.removeEventListener("drop", neutralize);
    };
  }, []);

  return (
    <ErrorBoundary>
      <OrquesterProvider
        runtime={runtime}
        api={api}
        useTitlebar={titlebar}
        windowControls={windowControls}
      >
        <AppWrapper>
          <AppShell />
        </AppWrapper>
      </OrquesterProvider>
    </ErrorBoundary>
  );
};
