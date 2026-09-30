import React, { useCallback, useEffect, useState } from "react";
import { ArrowLeft, FileText, Loader2, Power, RefreshCw, RotateCw, Skull } from "lucide-react";
import type { DesktopAppSummary, DesktopSummary } from "@orquester/api";
import type { ApiClient } from "../../lib/api-client";
import type { DesktopAudioState } from "../../lib/desktop-audio";
import type { DesktopPrefs } from "../../lib/desktop-prefs";
import { cn } from "../../lib/cn";
import { Modal, ModalCloseButton } from "../ui/modal";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const ACTION_CLASS =
  "flex h-7 items-center gap-1 rounded-md border border-neutral-700 px-2 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-40";

const AppLog: React.FC<{ api: ApiClient; desktopId: string; app: DesktopAppSummary; onBack: () => void }> = ({
  api,
  desktopId,
  app,
  onBack
}) => {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setError(null);
    api.desktopAppLog(desktopId, app.id, ctrl.signal).then(
      (log) => setText(log),
      (err: unknown) => {
        if (!ctrl.signal.aborted) setError(errorText(err));
      }
    );
    return () => ctrl.abort();
  }, [api, desktopId, app.id, nonce]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onBack} className={ACTION_CLASS}>
          <ArrowLeft size={12} /> Apps
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-400" title={app.command}>
          {app.command}
        </span>
        <button type="button" onClick={() => setNonce((n) => n + 1)} className={ACTION_CLASS}>
          <RefreshCw size={12} /> Refresh
        </button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <pre className="min-h-[12rem] flex-1 overflow-auto whitespace-pre-wrap break-words rounded border border-neutral-800 bg-neutral-950 p-2 font-mono text-[11px] text-neutral-300">
        {text === null && !error ? "Loading…" : text || "(empty log)"}
      </pre>
      <p className="text-[11px] text-neutral-600">The last 64 KiB of the app's output.</p>
    </div>
  );
};

/** ⋯ → Apps: every app launched into this desktop, with Stop / Force quit / Relaunch / View log. */
export const DesktopAppsDialog: React.FC<{
  open: boolean;
  onClose: () => void;
  api: ApiClient | null;
  desktop: DesktopSummary;
}> = ({ open, onClose, api, desktop }) => {
  const [logAppId, setLogAppId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setLogAppId(null);
      setError(null);
    }
  }, [open]);

  const run = useCallback(async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }, []);

  const logApp = logAppId ? desktop.apps.find((a) => a.id === logAppId) : undefined;
  const apps = [...desktop.apps].sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  return (
    <Modal open={open} onClose={onClose} className="max-w-2xl flex-col">
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2">
        <h2 className="truncate text-sm font-medium text-neutral-200">Apps in {desktop.title}</h2>
        <ModalCloseButton onClose={onClose} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
        {error && <p className="text-xs text-danger">{error}</p>}
        {api && logApp ? (
          <AppLog api={api} desktopId={desktop.id} app={logApp} onBack={() => setLogAppId(null)} />
        ) : apps.length === 0 ? (
          <p className="text-sm text-neutral-500">No apps have been launched into this desktop.</p>
        ) : (
          apps.map((app) => {
            const live = app.status !== "exited";
            return (
              <div key={app.id} className="flex flex-col gap-1.5 rounded-md border border-neutral-800 p-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      "h-2 w-2 shrink-0 rounded-full",
                      app.status === "running" ? "bg-ok" : app.status === "starting" ? "bg-warn" : "bg-neutral-600"
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-200" title={app.command}>
                    {app.command}
                  </span>
                  <span className="shrink-0 text-[11px] text-neutral-500">
                    {live ? app.status : `exited${app.exitCode === null ? "" : ` (${app.exitCode})`}`}
                  </span>
                </div>
                <div className="truncate text-[11px] text-neutral-600" title={app.cwd}>
                  {app.cwd}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {live ? (
                    <>
                      <button
                        type="button"
                        disabled={!api || busy !== null}
                        onClick={() => void run(`stop:${app.id}`, () => api!.stopDesktopApp(desktop.id, app.id, false))}
                        className={ACTION_CLASS}
                      >
                        {busy === `stop:${app.id}` ? <Loader2 size={12} className="animate-spin" /> : <Power size={12} />}
                        Stop
                      </button>
                      <button
                        type="button"
                        disabled={!api || busy !== null}
                        onClick={() => void run(`kill:${app.id}`, () => api!.stopDesktopApp(desktop.id, app.id, true))}
                        className={ACTION_CLASS}
                      >
                        {busy === `kill:${app.id}` ? <Loader2 size={12} className="animate-spin" /> : <Skull size={12} />}
                        Force quit
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={!api || busy !== null || desktop.status !== "running"}
                      onClick={() =>
                        void run(`relaunch:${app.id}`, () =>
                          api!.launchDesktopApp(desktop.id, { command: app.command, cwd: app.cwd, env: app.env })
                        )
                      }
                      className={ACTION_CLASS}
                    >
                      {busy === `relaunch:${app.id}` ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
                      Relaunch
                    </button>
                  )}
                  <button type="button" disabled={!api} onClick={() => setLogAppId(app.id)} className={ACTION_CLASS}>
                    <FileText size={12} /> View log
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </Modal>
  );
};

export interface DesktopConnectionInfo {
  state: string;
  rttMs: number | null;
  qualityLevel: number;
  desktopName: string | null;
}

/** ⋯ → Info: display, size, connection, video quality and audio jitter-buffer stats. */
export const DesktopInfoDialog: React.FC<{
  open: boolean;
  onClose: () => void;
  desktop: DesktopSummary;
  prefs: DesktopPrefs;
  audio: DesktopAudioState;
  connection: DesktopConnectionInfo;
}> = ({ open, onClose, desktop, prefs, audio, connection }) => {
  const rows: [string, string][] = [
    ["Status", desktop.error ? `${desktop.status} — ${desktop.error}` : desktop.status],
    ["Display", desktop.display === null ? "—" : `:${desktop.display}`],
    ["Size", `${desktop.size.width} × ${desktop.size.height}`],
    [
      "View",
      prefs.view === "fit"
        ? "Fit to tab"
        : `Fixed ${prefs.fixedSize?.width ?? "?"} × ${prefs.fixedSize?.height ?? "?"}, ${prefs.fixedMode === "pan" ? "actual size" : "scaled"}`
    ],
    ["Render threads", String(desktop.renderThreads)],
    ["Connection", connection.state],
    ["Round trip", connection.rttMs === null ? "—" : `${Math.round(connection.rttMs)} ms`],
    ["Video quality", `${connection.qualityLevel} / 9`],
    ["Audio", desktop.audio],
    ["Audio stream", audio.serverState ? `${audio.serverState.audio}${audio.serverState.reason ? ` — ${audio.serverState.reason}` : ""}` : "not connected"],
    ["Decoder", audio.decoder],
    ["Sound", !audio.unlocked ? "not enabled" : prefs.muted ? "muted" : `${Math.round(prefs.volume * 100)} %`]
  ];
  if (connection.desktopName) rows.splice(2, 0, ["Name", connection.desktopName]);
  if (audio.stats) {
    rows.push(
      ["Jitter buffer", `${Math.round(audio.stats.depthMs)} ms (target ${Math.round(audio.stats.targetMs)} ms)`],
      ["Underruns / drops", `${audio.stats.underruns} / ${audio.stats.drops}`]
    );
  }
  if (audio.error) rows.push(["Audio error", audio.error]);

  return (
    <Modal open={open} onClose={onClose} className="max-w-md flex-col">
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2">
        <h2 className="truncate text-sm font-medium text-neutral-200">{desktop.title}</h2>
        <ModalCloseButton onClose={onClose} />
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 overflow-y-auto p-4 text-xs">
        {rows.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt className="text-neutral-500">{label}</dt>
            <dd className="min-w-0 break-words text-neutral-200">{value}</dd>
          </React.Fragment>
        ))}
      </dl>
    </Modal>
  );
};
