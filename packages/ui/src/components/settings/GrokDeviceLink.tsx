import React, { useCallback, useEffect, useState } from "react";
import { Check, Copy, Download, ExternalLink, Link2, Loader2 } from "lucide-react";
import { Button } from "../ui";
import { useAppStore } from "../../store/app";
import { ApiError } from "../../lib/api-client";
import { copyText } from "../../lib/clipboard";
import { Notice, SettingRow } from "./primitives";

const formatStamp = (iso: string | null): string => {
  if (!iso) return "unknown";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString();
};

/**
 * The grok-specific account acquisition path: unlike Claude/Codex there is a
 * device-code login as an alternative to importing `~/.grok/auth.json`. The
 * daemon drives the RFC 8628 flow directly against auth.x.ai; on approval the
 * tokens become a managed grok account (it appears in the list above via
 * `agent-accounts.changed`). Nothing shown here is a secret — the verification
 * URL and user code are meant to be read out loud.
 *
 * Renders as one row of the Grok accounts card: the two secondary ways to add
 * an account while idle, the URL + user code while a link is pending.
 */
export const GrokDeviceLink: React.FC = () => {
  const api = useAppStore((s) => s.api);
  const status = useAppStore((s) => s.grokDeviceLink);
  const loadGrokDeviceLink = useAppStore((s) => s.loadGrokDeviceLink);
  const loadAgentAccounts = useAppStore((s) => s.loadAgentAccounts);
  // Which action is in flight, so only its button spins; any one disables all.
  const [pending, setPending] = useState<"link" | "import" | "cancel" | null>(null);
  const busy = pending !== null;
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // A link started elsewhere (another client, before a reload) is still
  // pending on the daemon; `grok-link.changed` keeps it current from here.
  useEffect(() => {
    void loadGrokDeviceLink();
  }, [loadGrokDeviceLink]);

  const run = useCallback(
    async (action: "link" | "import" | "cancel", fn: () => Promise<unknown>) => {
      setPending(action);
      setError(null);
      try {
        await fn();
      } catch (e) {
        // A 409 (a link already pending) or 502 (auth.x.ai failed) carries
        // the daemon's own reason.
        const message =
          e instanceof ApiError ? (e.serverMessage ?? e.message) : e instanceof Error ? e.message : String(e);
        setError(message);
      } finally {
        setPending(null);
        await loadGrokDeviceLink();
      }
    },
    [loadGrokDeviceLink]
  );

  const linking = status?.state === "linking";
  const link = status?.link ?? null;

  // The "Copied" tick is transient feedback only.
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);

  const feedback = (
    <>
      {error && <Notice tone="danger">{error}</Notice>}
      {!linking && status?.lastError && (
        <Notice tone="warn" title="Last link attempt failed">
          {status.lastError}
        </Notice>
      )}
    </>
  );

  if (!linking) {
    return (
      <div>
        <SettingRow
          icon={<Link2 size={14} />}
          label="Sign in with Grok"
          description={
            <>
              Link an account with a one-time code on accounts.x.ai, or adopt the login a terminal{" "}
              <code className="text-neutral-400">grok login</code> left on the server.
            </>
          }
        >
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            title="Sign in on accounts.x.ai with a one-time code"
            onClick={() => {
              void run("link", async () => {
                if (!api) throw new Error("not connected");
                await api.startGrokDeviceLink();
              });
            }}
          >
            {pending === "link" ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />} Link with code
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            title="Adopt the login a terminal grok login wrote to ~/.grok/auth.json on the server"
            onClick={() => {
              void run("import", async () => {
                if (!api) throw new Error("not connected");
                await api.importAgentAccount({ fromSystem: "grok" });
                await loadAgentAccounts();
              });
            }}
          >
            {pending === "import" ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Import server login
          </Button>
        </SettingRow>
        {(error || status?.lastError) && <div className="space-y-2 px-4 pb-3.5">{feedback}</div>}
      </div>
    );
  }

  return (
    <div className="space-y-3 px-4 py-4">
      <div className="flex items-center gap-2 text-sm text-neutral-200">
        <Loader2 size={14} className="animate-spin text-info" />
        Waiting for you to approve the sign-in…
      </div>

      {link && (
        <ol className="grid gap-3 sm:grid-cols-2">
          <li className="space-y-2 rounded-lg border border-neutral-800 bg-neutral-950/60 p-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">1 · Open</p>
            <a
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-full items-center gap-1.5 text-sm text-info hover:underline"
            >
              <ExternalLink size={13} className="shrink-0" />
              <span className="truncate">{link.url}</span>
            </a>
          </li>
          <li className="space-y-2 rounded-lg border border-neutral-800 bg-neutral-950/60 p-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">2 · Enter this code</p>
            <div className="flex items-center gap-2">
              <span className="select-all font-mono text-xl font-semibold tracking-[0.2em] text-neutral-100">
                {link.userCode}
              </span>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Copy code"
                title="Copy code"
                onClick={() => {
                  void copyText(link.userCode).then((ok) => ok && setCopied(true));
                }}
              >
                {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
              </Button>
            </div>
          </li>
        </ol>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-neutral-500">
          {link ? `Code expires ${formatStamp(link.expiresAt)}. ` : ""}The account appears above once approved.
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            void run("cancel", async () => {
              if (!api) throw new Error("not connected");
              await api.cancelGrokDeviceLink();
            });
          }}
        >
          Cancel
        </Button>
      </div>

      {feedback}
    </div>
  );
};
