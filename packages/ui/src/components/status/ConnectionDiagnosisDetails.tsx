import React, { useEffect, useRef, useState } from "react";
import { Check, Circle, Copy, Loader2, Minus, X } from "lucide-react";
import { useAppStore } from "../../store/app";
import { useOrquester } from "../../context/orquester-context";
import { copyText } from "../../lib/clipboard";
import {
  connectionDiagnosticsText,
  type ConnectionDiagnosis,
  type ConnectionDiagnosisInput,
  type ProbeResult
} from "../../lib/connection/diagnosis.logic";
import { probeHttp, probeWebSocket, type ProbeSocket } from "../../lib/connection/probes";
import { clientRuntimeLabel } from "../../lib/connection/client-info";

const RUNNING: ProbeResult = { outcome: "running", summary: "checking…" };

const ProbeRow: React.FC<{ label: string; probe: ProbeResult }> = ({ label, probe }) => (
  <li className="flex items-start gap-2">
    <span className="mt-0.5 shrink-0">
      {probe.outcome === "running" ? (
        <Loader2 size={12} className="animate-spin text-neutral-400" />
      ) : probe.outcome === "ok" ? (
        <Check size={12} className="text-ok" />
      ) : probe.outcome === "failed" ? (
        <X size={12} className="text-danger" />
      ) : (
        <Minus size={12} className="text-neutral-500" />
      )}
    </span>
    <span className="min-w-0">
      <span className="text-neutral-300">{label}:</span> <span className="text-neutral-400">{probe.summary}</span>
    </span>
  </li>
);

/**
 * The expanded connection diagnosis: what failed, what to try, live HTTP and
 * WebSocket checks (run when it opens), the facts, and Copy diagnostics. The
 * checks run first so the copy itself is immediate: a phone browser only lets a
 * tap write the clipboard while the tap is fresh.
 */
// Adapted from T3 Code (MIT): apps/web/src/components/settings/ConnectionDiagnosisDetails.tsx
export const ConnectionDiagnosisDetails: React.FC<{
  input: ConnectionDiagnosisInput;
  diagnosis: ConnectionDiagnosis | null;
}> = ({ input, diagnosis }) => {
  const { runtime } = useOrquester();
  const api = useAppStore((s) => s.api);
  const [http, setHttp] = useState<ProbeResult>(RUNNING);
  const [ws, setWs] = useState<ProbeResult>(RUNNING);
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One run of the checks per opening (and per client, after a reconnect rebuilt it).
  useEffect(() => {
    if (!api) return;
    let live = true;
    setHttp(RUNNING);
    setWs(RUNNING);
    void probeHttp((signal) => api.health(signal), { online: input.online }).then((result) => {
      if (live) setHttp(result);
    });
    const credential = api.connection.password;
    const wsUrl = input.wsUrl && credential ? `${input.wsUrl}?token=${encodeURIComponent(credential)}` : input.wsUrl;
    // The DOM socket calls the handlers the probe sets with its own (wider) events.
    void probeWebSocket(wsUrl, (url) => new WebSocket(url) as unknown as ProbeSocket).then((result) => {
      if (live) setWs(result);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    []
  );

  const copy = async () => {
    const text = connectionDiagnosticsText({
      diagnosis,
      input,
      http,
      ws,
      client: {
        runtimeLabel: clientRuntimeLabel(runtime),
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : ""
      },
      secrets: [api?.connection.password]
    });
    const ok = await copyText(text);
    setCopied(ok ? "ok" : "failed");
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(null), 2_000);
  };

  return (
    <div className="w-full space-y-2.5 rounded-xl border border-neutral-700 bg-neutral-900/95 p-3 text-xs shadow-xl shadow-black/40 backdrop-blur">
      {diagnosis ? (
        <>
          <p className="text-sm font-medium text-neutral-100">{diagnosis.headline}</p>
          <ul className="space-y-1 text-neutral-300">
            {diagnosis.steps.map((step) => (
              <li key={step} className="flex gap-2">
                <Circle size={5} className="mt-1.5 shrink-0 fill-current text-neutral-500" />
                <span>{step}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-sm text-neutral-200">Trying to reach the server again.</p>
      )}

      <ul className="space-y-1 border-t border-neutral-800 pt-2">
        <ProbeRow label="HTTP" probe={http} />
        <ProbeRow label="WebSocket" probe={ws} />
      </ul>

      {diagnosis && diagnosis.facts.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 border-t border-neutral-800 pt-2 text-neutral-400">
          {diagnosis.facts.map(([label, value]) => (
            <React.Fragment key={label}>
              <dt className="text-neutral-500">{label}</dt>
              <dd className="min-w-0 break-words font-mono text-[11px] text-neutral-300">{value}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-neutral-800 pt-2">
        {copied && (
          <span className={copied === "ok" ? "text-ok" : "text-danger"}>
            {copied === "ok" ? "Copied — no passwords or tokens included." : "Could not copy."}
          </span>
        )}
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex items-center gap-1.5 rounded-full border border-neutral-700 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-800"
        >
          <Copy size={12} />
          Copy diagnostics
        </button>
      </div>
    </div>
  );
};
