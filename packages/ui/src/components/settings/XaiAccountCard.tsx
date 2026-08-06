import React, { useCallback, useEffect, useState } from "react";
import { Download, ExternalLink, Link2 } from "lucide-react";
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
 * daemon drives the RFC 8628 flow directly against auth.x.ai (no model proxy
 * involved); on approval the tokens become a managed grok account (it appears
 * in the list above via `agent-accounts.changed`) — seeding it to the proxy
 * stays an explicit step in Settings → Model proxy, like Claude/Codex. Nothing
 * shown here is a secret — the verification URL and user code are meant to be
 * read out loud.
 */
export const GrokDeviceLink: React.FC = () => {
  const api = useAppStore((s) => s.api);
  const status = useAppStore((s) => s.cliproxy);
  const loadCliProxy = useAppStore((s) => s.loadCliProxy);
  const loadAgentAccounts = useAppStore((s) => s.loadAgentAccounts);
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

  return (
    <div className="space-y-2">
      {!linking && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            title="Sign in on accounts.x.ai with a one-time code — works without the model proxy"
            onClick={() => {
              void run(async () => {
                if (!api) throw new Error("not connected");
                await api.linkCliProxyXai();
              });
            }}
          >
            <Link2 size={13} /> Link with device code…
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            title="Adopt the login a terminal `grok login` wrote to ~/.grok/auth.json on the server"
            onClick={() => {
              void run(async () => {
                if (!api) throw new Error("not connected");
                await api.importAgentAccount({ fromSystem: "grok" });
                await loadAgentAccounts();
              });
            }}
          >
            <Download size={13} /> Import the server's grok login
          </Button>
          <p className="text-[11px] text-neutral-600">or upload an auth.json below.</p>
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
