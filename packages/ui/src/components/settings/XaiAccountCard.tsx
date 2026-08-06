import React, { useCallback, useEffect, useState } from "react";
import { ExternalLink, Link2 } from "lucide-react";
import { Button } from "../ui";
import { useAppStore } from "../../store/app";

const formatStamp = (iso: string | null): string => {
  if (!iso) return "unknown";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString();
};

/**
 * The grok-specific account acquisition path: unlike Claude/Codex there is a
 * device-code login as an alternative to importing `~/.grok/auth.json`. The
 * daemon drives the RFC 8628 flow through the model proxy's management API; on
 * approval the credential is adopted as a managed grok account (it appears in
 * the list above via `agent-accounts.changed`) AND seeded into the proxy.
 * Nothing shown here is a secret — the verification URL and user code are meant
 * to be read out loud.
 */
export const GrokDeviceLink: React.FC = () => {
  const api = useAppStore((s) => s.api);
  const status = useAppStore((s) => s.cliproxy);
  const loadCliProxy = useAppStore((s) => s.loadCliProxy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The Accounts section can open before the Model proxy panel ever loaded a status.
  useEffect(() => {
    void loadCliProxy();
  }, [loadCliProxy]);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await loadCliProxy();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [loadCliProxy]
  );

  const xai = status?.xai;
  const linking = xai?.state === "linking";
  const link = xai?.link ?? null;
  // degraded still has a reachable management API — the daemon accepts links there too.
  const proxyRunning = status?.state === "healthy" || status?.state === "degraded";
  // The proxy holds one xai credential slot: while a seeded grok credential
  // exists (linked/expired), a second device flow is refused by the daemon.
  const alreadyLinked = xai?.state === "linked" || xai?.state === "expired";

  const disabledReason = !proxyRunning
    ? "Start the model proxy first — the device-code login runs through it"
    : alreadyLinked
      ? "A Grok credential is already seeded in the model proxy"
      : undefined;

  return (
    <div className="space-y-2">
      {!linking && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !proxyRunning || alreadyLinked}
            title={disabledReason}
            onClick={() => {
              void run(async () => {
                if (!api) throw new Error("not connected");
                await api.linkCliProxyXai();
              });
            }}
          >
            <Link2 size={13} /> Link with device code…
          </Button>
          <p className="text-[11px] text-neutral-600">or import ~/.grok/auth.json below.</p>
        </div>
      )}

      {linking && (
        <div className="space-y-1 rounded-md border border-neutral-800 bg-neutral-950 p-2">
          {link && (
            <>
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
            </>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              void run(async () => {
                if (!api) throw new Error("not connected");
                await api.unlinkCliProxyXai();
              });
            }}
          >
            Cancel
          </Button>
        </div>
      )}

      {error && <p className="text-[11px] text-red-400/80">{error}</p>}
      {!linking && xai?.lastLinkError && (
        <p className="text-[11px] text-red-400/80">Last link attempt failed: {xai.lastLinkError}</p>
      )}
      <p className="text-[11px] text-neutral-600">
        Grok runs through a reverse-engineered first-party-client contract: it can break or be
        rate-limited without notice, and no quota readout is possible.
      </p>
    </div>
  );
};
