import React, { useCallback, useEffect, useState } from "react";
import { Check, ExternalLink, Link2, RefreshCw, Trash2, X } from "lucide-react";
import type { CliProxyXaiStatus } from "@orquester/api";
import { cn } from "../../lib/cn";
import { Button } from "../ui";
import { useAppStore } from "../../store/app";

const formatStamp = (iso: string | null): string => {
  if (!iso) return "unknown";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString();
};

/**
 * The xAI (Grok) account renders in TWO places, mirroring how Claude/Codex
 * accounts appear twice: `XaiAccountsList` is the connect surface in Settings →
 * Accounts (styled like the Claude/Codex account row lists there), and
 * `XaiProviderRow` sits inside the Model proxy Accounts container (styled like
 * the Codex/Claude ProviderRow seed cards). Unlike every other account there is
 * no importable credential file: linking is an RFC 8628 device-code prompt the
 * daemon drives against the proxy's management API, and the proxy — not
 * Orquester — owns and refreshes the tokens. Nothing shown here is a secret:
 * the verification URL and user code are meant to be read out loud. State
 * advances through the normal `cliproxy.changed` broadcast, so both surfaces
 * just fire the mutation and let the status stream do the rest.
 */
function useXaiAccount() {
  const api = useAppStore((s) => s.api);
  const status = useAppStore((s) => s.cliproxy);
  const loadCliProxy = useAppStore((s) => s.loadCliProxy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Either surface can mount before the Model proxy panel ever loaded a status.
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

  return { xai, state, link: xai?.link ?? null, proxyRunning, busy, error, startLink, dropLink, relink };
}

const XaiDeviceCode: React.FC<{ link: NonNullable<CliProxyXaiStatus["link"]> }> = ({ link }) => (
  <div className="space-y-1 rounded-md border border-neutral-800 bg-neutral-950 p-2">
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
);

const XaiErrors: React.FC<{
  error: string | null;
  xai: CliProxyXaiStatus | undefined;
  linking: boolean;
  className?: string;
}> = ({ error, xai, linking, className }) => (
  <>
    {error && <p className={cn("text-[11px] text-red-400/80", className)}>{error}</p>}
    {!linking && xai?.lastLinkError && (
      <p className={cn("text-[11px] text-red-400/80", className)}>
        Last link attempt failed: {xai.lastLinkError}
      </p>
    )}
    {xai?.lastQuotaError && (
      <p className={cn("text-[11px] text-amber-400/80", className)}>
        Last quota error: {xai.lastQuotaError} — xAI cools the account for 24 h after this.
      </p>
    )}
  </>
);

/** Settings → Accounts presentation: the same row-list look as the managed
 *  Claude/Codex account sections beside it. */
export const XaiAccountsList: React.FC = () => {
  const g = useXaiAccount();

  return (
    <div className="space-y-2">
      <div className="divide-y divide-neutral-800 rounded-md border border-neutral-800">
        {g.state === "none" && (
          <div className="flex items-center gap-2 px-2 py-2">
            <p className="min-w-0 flex-1 text-xs text-neutral-600">
              No account. Grok links via a device code — no credentials file.
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={g.busy || !g.proxyRunning}
              title={g.proxyRunning ? undefined : "Start the model proxy first"}
              onClick={g.startLink}
            >
              <Link2 size={13} /> Link…
            </Button>
          </div>
        )}

        {g.state === "linking" && (
          <div className="space-y-2 px-2 py-2">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">Linking…</p>
                <p className="text-[11px] text-neutral-500">waiting for you to approve the device code</p>
              </div>
              <Button size="sm" variant="outline" disabled={g.busy} onClick={g.dropLink}>
                Cancel
              </Button>
            </div>
            {g.link && <XaiDeviceCode link={g.link} />}
          </div>
        )}

        {(g.state === "linked" || g.state === "expired") && (
          <div className="flex items-center gap-2 px-2 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">
                {g.xai?.email ?? "Grok account"}
                {g.state === "expired" ? " · needs re-link" : ""}
              </p>
              <p className="text-[11px] text-neutral-500">
                {g.state === "expired"
                  ? `token expired ${formatStamp(g.xai?.expiredAt ?? null)} — the proxy retries the refresh on next use`
                  : `token valid until ${formatStamp(g.xai?.expiredAt ?? null)}`}
              </p>
            </div>
            {g.state === "expired" && (
              <Button
                size="sm"
                variant="outline"
                disabled={g.busy || !g.proxyRunning}
                title="Link again"
                onClick={g.relink}
              >
                <RefreshCw size={13} />
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={g.busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Unlink the Grok account? Grok launches stop working until you link again."
                  )
                )
                  void g.dropLink();
              }}
            >
              <Trash2 size={13} />
            </Button>
          </div>
        )}
      </div>
      <XaiErrors error={g.error} xai={g.xai} linking={g.state === "linking"} />
      <p className="text-[11px] text-neutral-600">
        Runs your SuperGrok subscription through a reverse-engineered first-party-client contract —
        it can break or be rate-limited without notice, and no quota readout is possible.
      </p>
    </div>
  );
};

/** Model proxy → Accounts presentation: the same card anatomy as the
 *  Codex/Claude ProviderRow above it (status circle + name + inner account
 *  row), rendered inside the same divide-y container. */
export const XaiProviderRow: React.FC = () => {
  const g = useXaiAccount();
  const ok = g.state === "linked";

  const stateText = ok
    ? `token valid until ${formatStamp(g.xai?.expiredAt ?? null)}`
    : g.state === "expired"
      ? "expired — re-link to refresh"
      : g.state === "linking"
        ? "waiting for device-code approval…"
        : "not connected";

  return (
    <div className="px-3 py-2.5">
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
          <p className="truncate text-sm text-neutral-100">Grok</p>
          <p className={cn("truncate text-xs", ok ? "text-emerald-400/80" : "text-neutral-500")}>
            {stateText}
          </p>
        </div>
        {g.state === "none" && (
          <Button
            size="sm"
            variant="outline"
            disabled={g.busy || !g.proxyRunning}
            title={g.proxyRunning ? undefined : "Start the model proxy first"}
            onClick={g.startLink}
          >
            <Link2 size={12} /> Link account
          </Button>
        )}
        {g.state === "expired" && (
          <Button size="sm" variant="outline" disabled={g.busy || !g.proxyRunning} onClick={g.relink}>
            <RefreshCw size={12} /> Re-link
          </Button>
        )}
        {g.state === "linking" && (
          <Button size="sm" variant="outline" disabled={g.busy} onClick={g.dropLink}>
            Cancel
          </Button>
        )}
      </div>

      {g.state === "linking" && g.link && (
        <div className="ml-8 mt-2">
          <XaiDeviceCode link={g.link} />
        </div>
      )}

      {(g.state === "linked" || g.state === "expired") && (
        <div className="ml-8 mt-2 space-y-1 rounded-md border border-neutral-800 bg-neutral-950 p-2">
          <div className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-neutral-200">
            <span className="min-w-0 flex-1 truncate">{g.xai?.email ?? "Grok account"}</span>
            <button
              type="button"
              disabled={g.busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Unlink the Grok account? Unlike un-seeding, this removes the account — " +
                      "Grok launches stop working until you link again."
                  )
                )
                  void g.dropLink();
              }}
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-50"
            >
              <X size={12} /> Unlink
            </button>
          </div>
        </div>
      )}

      <XaiErrors error={g.error} xai={g.xai} linking={g.state === "linking"} className="ml-8 mt-2" />
    </div>
  );
};
