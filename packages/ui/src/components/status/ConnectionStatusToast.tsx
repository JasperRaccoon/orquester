import React, { useEffect, useState, useSyncExternalStore } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Loader2, WifiOff, X } from "lucide-react";
import { ORQUESTER_PROTOCOL_VERSION } from "@orquester/api";
import { useAppStore } from "../../store/app";
import { useOrquester } from "../../context/orquester-context";
import { getConnectionLog, subscribeConnectionLog } from "../../lib/connection/connection-log";
import { presentConnectionDiagnosis, type ConnectionDiagnosisInput } from "../../lib/connection/diagnosis.logic";
import { deviceOnline } from "../../lib/connection/failure";
import { CLIENT_BUILD } from "../../lib/connection/client-info";
import { wakeReconnects } from "../../lib/connection/backoff";
import { sessionChannelUrl } from "../../lib/transporters/ws-session-channel";
import { ConnectionDiagnosisDetails } from "./ConnectionDiagnosisDetails";

/** `navigator.onLine`, re-rendering on change. */
function useOnline(): boolean {
  const [online, setOnline] = useState(deviceOnline);
  useEffect(() => {
    const update = () => setOnline(deviceOnline());
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

const sameOrigin = (endpoint: string): boolean => {
  try {
    return typeof window !== "undefined" && new URL(endpoint).origin === window.location.origin;
  } catch {
    return false;
  }
};

/** Everything the diagnosis reads, from the store, the connection log and the page. */
export function useConnectionDiagnosisInput(): ConnectionDiagnosisInput | null {
  const { runtime } = useOrquester();
  const status = useAppStore((s) => s.connectionStatus);
  const attempt = useAppStore((s) => s.reconnectAttempt);
  const connectionError = useAppStore((s) => s.connectionError);
  const api = useAppStore((s) => s.api);
  const connection = useAppStore((s) => s.connections.find((c) => c.id === s.activeConnectionId));
  const log = useSyncExternalStore(subscribeConnectionLog, getConnectionLog);
  const online = useOnline();
  // Re-evaluated every few seconds so the restart window and lockout countdowns move on.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);
  if (!connection) {
    return null;
  }
  const http = api?.transportKind === "http";
  return {
    status,
    attempt,
    connectionError,
    log,
    serverLabel: connection.kind === "local" ? "The local daemon" : connection.name,
    endpoint: connection.endpoint,
    wsUrl: http ? sessionChannelUrl(connection.endpoint) : null,
    runtime,
    sameOrigin: runtime === "web" && sameOrigin(connection.endpoint),
    online,
    clientProtocol: ORQUESTER_PROTOCOL_VERSION,
    clientBuild: CLIENT_BUILD,
    now
  };
}

/**
 * Toast for connection trouble. While the client retries it shows a spinner,
 * the attempt and what the last failure was; when it gives up, what failed and
 * its fix (Retry, Sign in, Reload). Connected but degraded (WebSockets
 * blocked, a protocol mismatch) shows a dismissible warning. Details opens the
 * steps, live checks and Copy diagnostics. Hidden during normal startup and
 * while the auth prompt is showing.
 *
 * Positioning belongs to {@link ToastStack} — this renders only its card.
 */
export const ConnectionStatusToast: React.FC = () => {
  const authPrompt = useAppStore((s) => s.authPrompt);
  const activeConnectionId = useAppStore((s) => s.activeConnectionId);
  const connect = useAppStore((s) => s.connect);
  const input = useConnectionDiagnosisInput();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const diagnosis = input ? presentConnectionDiagnosis(input) : null;
  const reconnecting = input?.status === "connecting" && input.attempt > 0;
  const errored = input?.status === "error";
  const warning = diagnosis?.severity === "warn" && dismissed !== diagnosis.kind;
  const visible = !authPrompt && input !== null && (reconnecting || errored || warning);

  // A new problem starts collapsed.
  const key = visible ? `${diagnosis?.kind ?? ""}:${input?.status ?? ""}` : null;
  useEffect(() => setOpen(false), [key]);

  if (!visible || !input) {
    return null;
  }

  const runAction = (): void => {
    switch (diagnosis?.action) {
      case "sign-in":
        // The existing sign-in path: the auth prompt for this connection.
        if (activeConnectionId) useAppStore.setState({ authPrompt: { connectionId: activeConnectionId } });
        return;
      case "reload":
        window.location.reload();
        return;
      default:
        // Given up: a fresh connect. Still retrying: run the pending retries now.
        if (errored) void connect();
        else wakeReconnects();
    }
  };
  const actionLabel =
    diagnosis?.action === "sign-in" ? "Sign in" : diagnosis?.action === "reload" ? "Reload" : errored ? "Retry" : null;

  const text = diagnosis?.headline ?? (reconnecting ? "Reconnecting…" : "Disconnected");

  return (
    <div className="pointer-events-auto flex w-full max-w-md flex-col items-center gap-1.5">
      <div className="flex max-w-full items-center gap-2.5 rounded-2xl border border-neutral-700 bg-neutral-900/95 py-1.5 pl-3 pr-2 text-sm shadow-xl shadow-black/40 backdrop-blur">
        {reconnecting ? (
          <Loader2 size={15} className="shrink-0 animate-spin text-neutral-300" />
        ) : warning ? (
          <AlertTriangle size={15} className="shrink-0 text-warn" />
        ) : (
          <WifiOff size={15} className="shrink-0 text-danger" />
        )}
        <span className="min-w-0 text-neutral-200">
          {reconnecting && diagnosis ? <span className="text-neutral-400">Reconnecting · </span> : null}
          {text}
        </span>
        {reconnecting && (
          <span className="shrink-0 rounded-full bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">
            attempt {input.attempt}
          </span>
        )}
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex shrink-0 items-center gap-0.5 rounded-full px-2 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          Details
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        {actionLabel && (
          <button
            type="button"
            onClick={runAction}
            className="shrink-0 rounded-full bg-neutral-200 px-3 py-0.5 text-xs font-medium text-neutral-900 hover:bg-neutral-50"
          >
            {actionLabel}
          </button>
        )}
        {warning && (
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setDismissed(diagnosis.kind)}
            className="shrink-0 rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          >
            <X size={13} />
          </button>
        )}
      </div>
      {open && <ConnectionDiagnosisDetails input={input} diagnosis={diagnosis} />}
    </div>
  );
};
