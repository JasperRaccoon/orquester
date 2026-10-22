import React, { useCallback, useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import type { TailscaleServeStatus } from "@orquester/api";
import { ApiError } from "../../lib/api-client";
import { copyText } from "../../lib/clipboard";
import { useApi } from "../../context/orquester-context";
import { Switch } from "../ui";
import { Badge, Notice, SettingRow } from "./primitives";

const serverMessage = (err: unknown): string | null => {
  const message = (err as { serverMessage?: unknown } | null)?.serverMessage;
  return typeof message === "string" && message ? message : null;
};

/** This page itself was loaded through the Tailscale address: turning it off cuts this device off. */
const viaTailscale = (status: TailscaleServeStatus | null): boolean =>
  typeof window !== "undefined" && status?.dnsName != null && window.location.hostname === status.dnsName;

/**
 * Remote access → "Tailscale HTTPS": serve the daemon to the tailnet at its
 * `https://<machine>.<tailnet>.ts.net` address with `tailscale serve`, which
 * gives phones a trusted certificate (the installed web app needs HTTPS) and
 * keeps the sign-in off plain HTTP. Toggled on the daemon, which runs the CLI
 * and reports any fix needed. Usable from any signed-in client.
 */
export const TailscaleServeSetting: React.FC<{
  /** External HTTP access as saved; Tailscale HTTPS forwards to it. */
  httpEnabled: boolean;
}> = ({ httpEnabled }) => {
  const api = useApi();
  const [status, setStatus] = useState<TailscaleServeStatus | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(
    (signal?: AbortSignal) =>
      api
        .getTailscaleServe(signal)
        .then((next) => {
          setStatus(next);
          setLoadError(null);
        })
        .catch((err: unknown) => {
          if (signal?.aborted) return;
          // An older daemon has no such route: nothing to offer.
          if (err instanceof ApiError && err.status === 404) setMissing(true);
          else setLoadError(serverMessage(err) ?? "Could not read Tailscale's status.");
        }),
    [api]
  );

  // Re-read when the HTTP transport is switched (its state is part of the answer).
  useEffect(() => {
    const controller = new AbortController();
    setStatus(null);
    setMissing(false);
    setError(null);
    void load(controller.signal);
    return () => controller.abort();
  }, [load, httpEnabled]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  if (missing) {
    return null;
  }

  const toggle = async (enabled: boolean) => {
    if (
      !enabled &&
      viaTailscale(status) &&
      !window.confirm("This device is connected through the Tailscale address. Turning it off disconnects it. Continue?")
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.setTailscaleServe(enabled));
    } catch (err) {
      setError(serverMessage(err) ?? "Could not change Tailscale HTTPS.");
      // The refusal may come with a changed picture (e.g. the CLI went away).
      void load();
    } finally {
      setBusy(false);
    }
  };

  const problem = status?.problem ?? null;
  // Turning off is always allowed; turning on only when nothing stands in the way.
  const canToggle = status !== null && !busy && (status.enabled || problem === null);
  const stale = status?.enabled === true && !status.active && problem === null;

  return (
    <>
      <SettingRow
        label={
          <span className="inline-flex items-center gap-2">
            Tailscale HTTPS
            {status?.active && <Badge tone="ok">Serving</Badge>}
          </span>
        }
        description={
          <>
            Serve this daemon to your tailnet at its <code className="text-neutral-400">ts.net</code> address with a
            trusted certificate (<code className="text-neutral-400">tailscale serve</code>). Phones can then install the
            web app, and the sign-in never travels over plain HTTP.
          </>
        }
      >
        <span className="inline-flex items-center gap-2">
          {(status === null && !loadError) || busy ? <Loader2 size={13} className="animate-spin text-neutral-500" /> : null}
          <Switch
            label="Tailscale HTTPS"
            checked={status?.enabled ?? false}
            disabled={!canToggle}
            onChange={(enabled) => void toggle(enabled)}
          />
        </span>
      </SettingRow>

      {(status?.active || stale || problem || error || loadError) && (
        <div className="space-y-2 px-4 pb-3.5">
          {status?.active && status.url && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-950/40 px-3 py-2 text-xs">
              <a
                href={status.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-w-0 items-center gap-1.5 font-mono text-neutral-200 hover:underline"
              >
                <span className="truncate">{status.url}</span>
                <ExternalLink size={12} className="shrink-0 text-neutral-500" />
              </a>
              <button
                type="button"
                onClick={() => void copyText(status.url!).then(setCopied)}
                className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
              >
                {copied ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
                {copied ? "Copied" : "Copy"}
              </button>
              <p className="w-full text-neutral-500">
                Open it on any device signed in to your tailnet. The first visit can take a few seconds while Tailscale
                issues the certificate.
              </p>
            </div>
          )}
          {stale && (
            <Notice tone="warn">
              Saved on, but Tailscale is not serving this daemon right now. Turn it off and on again to re-apply.
            </Notice>
          )}
          {problem && !error && (
            <Notice tone={problem.code === "http-disabled" ? "info" : "warn"}>{problem.message}</Notice>
          )}
          {error && <Notice tone="danger">{error}</Notice>}
          {loadError && <Notice tone="danger">{loadError}</Notice>}
        </div>
      )}
    </>
  );
};
