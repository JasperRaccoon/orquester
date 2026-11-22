import React, { useEffect, useMemo, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, Square } from "lucide-react";
import { useStore } from "zustand";
import { encode } from "uqr";
import type { MachineProblem, TailnetHttpsStatus, TailnetPreviewShare } from "@orquester/api";
import { copyText } from "../../lib/clipboard";
import { loadTailnet, setTailnetHttps, setTailnetPreviews, tailnetStore } from "../../lib/tailnet/store";
import { confirmUsersOfError, problemOfError } from "../../lib/tailnet/validate";
import { useAppStore } from "../../store/app";
import { Button, ConfirmDialog, Input } from "../ui";
import { Badge, EmptyState, Notice, SettingRow, SettingsSection } from "./primitives";

/**
 * Settings → Server's tailnet part (tailnet machines spec 2026-11-22 §4.7): the daemon's
 * `https://<host>.ts.net:<port>` address with a copy button and a QR code, turning it on and off,
 * the one-time operator grant, problems with their fixes, and the dev-server previews shared on
 * the tailnet. Both transports: these are the owner's settings, not local-socket-only ones.
 */

/** `text` with its `backticked` parts as code (fixes name commands that way). */
const withCode = (text: string): React.ReactNode =>
  text.split(/(`[^`]+`)/).map((part, index) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
      <code key={index} className="rounded bg-neutral-800 px-1 py-px font-mono text-[11px] text-neutral-200">
        {part.slice(1, -1)}
      </code>
    ) : (
      <React.Fragment key={index}>{part}</React.Fragment>
    )
  );

const ProblemNotice: React.FC<{ problem: MachineProblem; tone?: "warn" | "danger"; action?: React.ReactNode }> = ({ problem, tone = "warn", action }) => (
  <Notice tone={tone} title={withCode(problem.message)} action={action}>
    {problem.fix && <p>{withCode(problem.fix)}</p>}
  </Notice>
);

/** A QR code of `value` as SVG modules (dark on a white quiet zone, so phones read it on any theme). */
const QrCode: React.FC<{ value: string; size?: number }> = ({ value, size = 136 }) => {
  const { path, modules } = useMemo(() => {
    const qr = encode(value, { ecc: "M", border: 2 });
    let d = "";
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      })
    );
    return { path: d, modules: qr.size };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={`QR code for ${value}`}
      width={size}
      height={size}
      viewBox={`0 0 ${modules} ${modules}`}
      shapeRendering="crispEdges"
      className="shrink-0 rounded-md"
    >
      <rect width={modules} height={modules} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
};

const CopyButton: React.FC<{ text: string; label: string }> = ({ text, label }) => {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      size="sm"
      variant="outline"
      aria-label={label}
      onClick={() => {
        void copyText(text).then(setCopied);
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
};

const STATE_BADGE: Record<TailnetHttpsStatus["serveState"], { tone: "ok" | "warn" | "danger" | "info" | "neutral"; label: string }> = {
  serving: { tone: "ok", label: "Serving" },
  repairing: { tone: "info", label: "Repairing" },
  taken: { tone: "warn", label: "Port taken" },
  failed: { tone: "danger", label: "Not working" },
  off: { tone: "neutral", label: "Off" }
};

type Busy = "enable" | "disable" | "operator" | "share" | `stop:${number}` | null;

export const TailnetSettings: React.FC = () => {
  const api = useAppStore((s) => s.api);
  const https = useStore(tailnetStore, (state) => state.https);
  const previews = useStore(tailnetStore, (state) => state.previews);
  const sessions = useAppStore((s) => s.sessions);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [actionProblem, setActionProblem] = useState<MachineProblem | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Which section the last failed action belongs to. */
  const [errorScope, setErrorScope] = useState<"https" | "previews">("https");
  const [sharePort, setSharePort] = useState("");
  /** What would disconnect if the address went off: the confirm dialog is open while set. */
  const [confirmUsers, setConfirmUsers] = useState<string[] | null>(null);

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    setLoadError(null);
    loadTailnet(api, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "Could not read Tailscale on the server.");
    });
    return () => controller.abort();
  }, [api]);

  const run = async (kind: Exclude<Busy, null>, task: (client: NonNullable<typeof api>) => Promise<void>): Promise<void> => {
    if (!api) return;
    setBusy(kind);
    setActionProblem(null);
    setActionError(null);
    setErrorScope(kind === "share" || kind.startsWith("stop:") ? "previews" : "https");
    try {
      await task(api);
    } catch (error) {
      const problem = problemOfError(error);
      if (problem) setActionProblem(problem);
      else setActionError((error as { serverMessage?: string | null }).serverMessage ?? (error instanceof Error ? error.message : "The request failed."));
    } finally {
      setBusy(null);
    }
  };

  const enable = () => run("enable", async (client) => setTailnetHttps(await client.enableTailnetHttps()));
  const disable = (confirm = false) =>
    run("disable", async (client) => {
      try {
        setTailnetHttps(await client.disableTailnetHttps({ confirm }));
      } catch (error) {
        const users = confirmUsersOfError(error);
        if (!users) throw error;
        setConfirmUsers(users);
      }
    });
  const grantOperator = () => run("operator", async (client) => setTailnetHttps(await client.setTailnetOperator()));
  const port = Number(sharePort.trim());
  const portValid = sharePort.trim() !== "" && Number.isInteger(port) && port >= 1024 && port <= 65535;
  const share = () =>
    run("share", async (client) => {
      const preview = await client.shareTailnetPreview(port);
      setTailnetPreviews([...previews.filter((entry) => entry.port !== preview.port), preview].sort((a, b) => a.port - b.port));
      setSharePort("");
    });
  const stop = (entry: TailnetPreviewShare) => run(`stop:${entry.port}`, async (client) => setTailnetPreviews(await client.stopTailnetPreview(entry.port)));

  const chatTitle = (threadId: string | null): string =>
    threadId === null ? "Shared from Settings" : `Shared by ${sessions.find((session) => session.id === threadId)?.title || "a chat"}`;

  const badge = https ? STATE_BADGE[https.serveState] : null;
  const httpsActionProblem = errorScope === "https" ? actionProblem : null;
  const httpsActionError = errorScope === "https" ? actionError : null;
  const problem = httpsActionProblem ?? https?.problem ?? null;
  const serving = https?.serveState === "serving" && https.url !== null;

  return (
    <>
      <SettingsSection
        title="Tailnet address"
        description="Reach this server at an https://….ts.net address from any device signed in to your tailnet. Tailscale serves it; Orquester checks it every 30 seconds and repairs it."
        actions={badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
      >
        {!https && !loadError && (
          <div className="flex items-center gap-2 px-4 py-3.5 text-xs text-neutral-500">
            <Loader2 size={13} className="animate-spin" /> Reading Tailscale on the server…
          </div>
        )}
        {loadError && (
          <div className="px-4 py-3">
            <Notice tone="danger">{loadError}</Notice>
          </div>
        )}
        {https && (
          <>
            <SettingRow
              label="Serve on the tailnet"
              description={
                serving
                  ? `Tailscale serves port ${https.port} of this server's tailnet name. Stopping removes only Orquester's own route.`
                  : https.available
                    ? `Tailscale will serve this server on port ${https.port} of its tailnet name, without touching routes other apps use.`
                    : "Needs Tailscale running and signed in on the server."
              }
            >
              {serving ? (
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void disable()}>
                  {busy === "disable" && <Loader2 size={13} className="animate-spin" />}
                  {busy === "disable" ? "Stopping…" : "Stop serving"}
                </Button>
              ) : (
                <Button size="sm" disabled={busy !== null || !https.available} onClick={() => void enable()}>
                  {busy === "enable" && <Loader2 size={13} className="animate-spin" />}
                  {busy === "enable" ? "Setting up…" : https.serveState === "off" ? "Set up" : "Set up again"}
                </Button>
              )}
            </SettingRow>

            {serving && https.url && (
              <div className="flex flex-wrap items-center gap-4 px-4 py-3.5">
                <QrCode value={https.url} />
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="break-all font-mono text-xs text-neutral-200">{https.url}</p>
                  <p className="text-xs leading-relaxed text-neutral-500">
                    Scan it with a phone on the same tailnet, or open it in a browser there. Signing in uses this server's password.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <CopyButton text={https.url} label="Copy the tailnet address" />
                    <Button size="sm" variant="ghost" onClick={() => window.open(https.url ?? "", "_blank", "noopener,noreferrer")}>
                      <ExternalLink size={13} /> Open
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {https.available && !https.operatorOk && (
              <SettingRow
                label="Serve changes need sudo"
                description={
                  <>
                    The server's user isn't Tailscale's operator, so each change runs through <code className="text-neutral-400">sudo -n</code>. Allow it
                    once and later changes (repairs, previews) need no sudo.
                  </>
                }
              >
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void grantOperator()}>
                  {busy === "operator" && <Loader2 size={13} className="animate-spin" />}
                  {busy === "operator" ? "Allowing…" : "Allow without sudo"}
                </Button>
              </SettingRow>
            )}

            {(problem || httpsActionError) && (
              <div className="px-4 py-3">
                {problem ? (
                  <ProblemNotice problem={problem} tone={https.serveState === "failed" || httpsActionProblem ? "danger" : "warn"} />
                ) : (
                  <Notice tone="danger">{httpsActionError}</Notice>
                )}
              </div>
            )}
          </>
        )}
      </SettingsSection>

      <ConfirmDialog
        open={confirmUsers !== null}
        title="Turn off the tailnet address?"
        message={`${(confirmUsers ?? []).join(" and ")} reach Orquester through this address and will disconnect. They reconnect only once it is served again or their Connection setting points elsewhere.`}
        confirmLabel="Turn off"
        danger
        onCancel={() => setConfirmUsers(null)}
        onConfirm={() => {
          setConfirmUsers(null);
          void disable(true);
        }}
      />

      <SettingsSection
        title="Shared previews"
        description="Dev servers shared on the tailnet as https://….ts.net:<port>. A chat's shares stop when the chat closes; any share stops when its port stops listening."
      >
        {previews.length === 0 ? (
          <EmptyState
            title="No dev servers are shared"
            description="Agents share one with share_preview. You can also share a port that a dev server listens on here."
          />
        ) : (
          previews.map((entry) => (
            <SettingRow
              key={entry.port}
              label={
                <a href={entry.url} target="_blank" rel="noopener noreferrer" className="break-all font-mono text-xs text-neutral-200 underline-offset-2 hover:underline">
                  {entry.url}
                </a>
              }
              description={`Port ${entry.port} · ${chatTitle(entry.threadId)}`}
            >
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void stop(entry)} aria-label={`Stop sharing port ${entry.port}`}>
                {busy === `stop:${entry.port}` ? <Loader2 size={13} className="animate-spin" /> : <Square size={12} />}
                Stop
              </Button>
            </SettingRow>
          ))
        )}
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <label htmlFor="tailnet-share-port" className="text-xs text-neutral-400">
            Share port
          </label>
          <Input
            id="tailnet-share-port"
            className="w-28 font-mono text-xs tabular-nums"
            inputMode="numeric"
            autoComplete="off"
            placeholder="5173"
            value={sharePort}
            onChange={(event) => setSharePort(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && portValid && busy === null) void share();
            }}
          />
          <Button size="sm" variant="outline" disabled={!portValid || busy !== null || !https?.available} onClick={() => void share()}>
            {busy === "share" && <Loader2 size={13} className="animate-spin" />}
            Share
          </Button>
        </div>
        {errorScope === "previews" && (actionProblem || actionError) && (
          <div className="px-4 pb-3">
            {actionProblem ? <ProblemNotice problem={actionProblem} tone="danger" /> : <Notice tone="danger">{actionError}</Notice>}
          </div>
        )}
      </SettingsSection>
    </>
  );
};
