import React, { useCallback, useEffect, useState } from "react";
import { Check, ExternalLink, Link2, RefreshCw, Unlink, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../ui";
import { useAppStore } from "../../store/app";

const formatStamp = (iso: string | null): string => {
  if (!iso) return "unknown";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString();
};

/**
 * The xAI (Grok) account card — the CONNECT surface, so it lives in Settings →
 * Accounts beside the Claude/Codex imports (the Model proxy section only
 * reflects the link). Unlike every other account this one has no importable
 * credential file: it is linked by an RFC 8628 device-code prompt the daemon
 * drives against the proxy's management API, and the proxy — not Orquester —
 * owns and refreshes the tokens. Nothing here is a secret: the verification URL
 * and user code are meant to be read out loud. State advances through the
 * normal `cliproxy.changed` broadcast, so the card just fires the mutation and
 * lets the status stream do the rest.
 *
 * Self-contained (own busy state, cliproxy status from the store) so both the
 * Accounts section and any future surface can render it with zero props.
 */
export const XaiAccountCard: React.FC = () => {
  const api = useAppStore((s) => s.api);
  const status = useAppStore((s) => s.cliproxy);
  const loadCliProxy = useAppStore((s) => s.loadCliProxy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The card can mount before the Model proxy panel ever loaded a status.
  useEffect(() => {
    void loadCliProxy();
  }, [loadCliProxy]);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // A daemon/bundle pairing that predates the field serves no `xai` at all.
  const xai = status?.xai;
  const state = xai?.state ?? "none";
  const link = xai?.link ?? null;
  // degraded still has a reachable management API — the daemon accepts links there too.
  const proxyRunning = status?.state === "healthy" || status?.state === "degraded";

  // Unlink is session-gated like the router mutations (409 → affectedSessions),
  // but nothing restarts — the proxy hot-discovers the auth-dir change — so the
  // confirm copy talks about losing Grok access, not about a proxy restart.
  // Returns false when the user declines the forced retry.
  const confirmedUnlink = async (): Promise<boolean> => {
    if (!api) throw new Error("not connected");
    const res = await api.unlinkCliProxyXai();
    if ("ok" in res && res.ok === false) {
      const n = res.affectedSessions ?? 0;
      if (
        !window.confirm(
          `${n} running session${n === 1 ? "" : "s"} use Grok models and will lose ` +
            `access when the account is unlinked. Continue?`
        )
      ) {
        return false;
      }
      await api.unlinkCliProxyXai(true);
    }
    return true;
  };

  const startLink = () =>
    run(async () => {
      if (!api) throw new Error("not connected");
      await api.linkCliProxyXai();
      await loadCliProxy();
    });

  const dropLink = () =>
    run(async () => {
      await confirmedUnlink();
      await loadCliProxy();
    });

  // Expired means the refresh token is dead: unlink first so the new device flow
  // is not refused as "already linked".
  const relink = () =>
    run(async () => {
      if (!api) throw new Error("not connected");
      if (!(await confirmedUnlink())) return;
      await api.linkCliProxyXai();
      await loadCliProxy();
    });

  const ok = state === "linked";

  return (
    <div className="rounded-lg border border-neutral-800 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
            ok ? "bg-emerald-900/50 text-emerald-300" : "bg-neutral-800 text-neutral-500"
          )}
        >
          {ok ? <Check size={12} /> : <X size={12} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-neutral-100">Grok account</p>
          {state === "linked" && (
            <p className="truncate text-xs text-emerald-400/80">
              {xai?.email ?? "linked"} · token valid until {formatStamp(xai?.expiredAt ?? null)}
            </p>
          )}
          {state === "expired" && (
            <p className="truncate text-xs text-amber-400/80">
              token expired {formatStamp(xai?.expiredAt ?? null)} — the proxy retries the refresh on
              next use; link again if Grok launches fail
            </p>
          )}
          {state === "linking" && (
            <p className="truncate text-xs text-sky-300">waiting for you to approve the device code…</p>
          )}
          {state === "none" && <p className="truncate text-xs text-neutral-500">not linked</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {state === "none" && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !proxyRunning}
              title={proxyRunning ? undefined : "Start the model proxy first"}
              onClick={startLink}
            >
              <Link2 size={12} /> Link Grok account
            </Button>
          )}
          {state === "expired" && (
            <Button size="sm" variant="outline" disabled={busy || !proxyRunning} onClick={relink}>
              <RefreshCw size={12} /> Link again
            </Button>
          )}
          {state === "linking" && (
            <Button size="sm" variant="outline" disabled={busy} onClick={dropLink}>
              Cancel
            </Button>
          )}
          {(state === "linked" || state === "expired") && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={dropLink} title="Unlink Grok account">
              <Unlink size={12} />
            </Button>
          )}
        </div>
      </div>

      {state === "linking" && link && (
        <div className="ml-8 mt-2 space-y-1 rounded-md border border-neutral-800 bg-neutral-950 p-2">
          <a
            href={link.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-sky-400 hover:underline"
          >
            <ExternalLink size={12} /> {link.url}
          </a>
          <p className="text-xs text-neutral-400">
            Code: <span className="font-mono text-sm text-neutral-100">{link.userCode}</span>
          </p>
          <p className="text-[11px] text-neutral-600">Expires {formatStamp(link.expiresAt)}.</p>
        </div>
      )}

      {error && <p className="ml-8 mt-2 text-[11px] text-red-400/80">{error}</p>}

      {state !== "linking" && xai?.lastLinkError && (
        <p className="ml-8 mt-2 text-[11px] text-red-400/80">
          Last link attempt failed: {xai.lastLinkError}
        </p>
      )}

      {xai?.lastQuotaError && (
        <p className="ml-8 mt-2 text-[11px] text-amber-400/80">
          Last quota error: {xai.lastQuotaError} — xAI cools the account for 24 h after this.
        </p>
      )}

      <p className="ml-8 mt-2 text-[11px] text-neutral-600">
        Runs your SuperGrok subscription through a reverse-engineered first-party-client contract:
        it can break or be rate-limited without notice, and no quota readout is possible. Needs the
        model proxy running to link.
      </p>
    </div>
  );
};
