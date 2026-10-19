import React, { useCallback, useEffect, useState } from "react";
import { Check, Copy, Download, Link2, Loader2 } from "lucide-react";
import type { DeviceLinkAgent } from "@orquester/api";
import { Button } from "../ui";
import { useAppStore } from "../../store/app";
import { copyText } from "../../lib/clipboard";
import { Notice, SettingRow } from "./primitives";
import { formatStamp, linkErrorMessage, LinkOpenUrl, LinkStep } from "./account-link-parts";

const COPY: Record<DeviceLinkAgent, { label: string; description: React.ReactNode; linkTitle: string }> = {
  grok: {
    label: "Sign in with Grok",
    description: (
      <>
        Link an account with a one-time code on accounts.x.ai, or adopt the login a terminal{" "}
        <code className="text-neutral-400">grok login</code> left on the server.
      </>
    ),
    linkTitle: "Sign in on accounts.x.ai with a one-time code"
  },
  codex: {
    label: "Sign in with ChatGPT",
    description: (
      <>
        Link an account with a one-time code on auth.openai.com. If ChatGPT refuses the code, turn on device code
        sign-in in its security settings.
      </>
    ),
    linkTitle: "Sign in on auth.openai.com with a one-time code"
  }
};

/**
 * A device-code account link — Grok and Codex both offer one as an alternative
 * to importing the CLI's `auth.json`. The daemon drives the provider's device
 * flow directly; on approval the tokens become a managed account (it appears
 * in the list above via `agent-accounts.changed`). Nothing shown here is a
 * secret — the verification URL and user code are meant to be read out loud.
 *
 * Renders as one row of the agent's accounts card: the ways to add an account
 * while idle (Grok also adopts a server-side `grok login`), the URL + user code
 * while a link is pending.
 */
export const DeviceCodeLink: React.FC<{ agent: DeviceLinkAgent }> = ({ agent }) => {
  const api = useAppStore((s) => s.api);
  const status = useAppStore((s) => s.deviceLinks[agent]);
  const loadDeviceLink = useAppStore((s) => s.loadDeviceLink);
  const loadAgentAccounts = useAppStore((s) => s.loadAgentAccounts);
  // Which action is in flight, so only its button spins; any one disables all.
  const [pending, setPending] = useState<"link" | "import" | "cancel" | null>(null);
  const busy = pending !== null;
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copy = COPY[agent];

  // A link started elsewhere (another client, before a reload) is still
  // pending on the daemon; `<agent>-link.changed` keeps it current from here.
  useEffect(() => {
    void loadDeviceLink(agent);
  }, [agent, loadDeviceLink]);

  const run = useCallback(
    async (action: "link" | "import" | "cancel", fn: () => Promise<unknown>) => {
      setPending(action);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(linkErrorMessage(e));
      } finally {
        setPending(null);
        await loadDeviceLink(agent);
      }
    },
    [agent, loadDeviceLink]
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
        <SettingRow icon={<Link2 size={14} />} label={copy.label} description={copy.description}>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            title={copy.linkTitle}
            onClick={() => {
              void run("link", async () => {
                if (!api) throw new Error("not connected");
                await api.startDeviceLink(agent);
              });
            }}
          >
            {pending === "link" ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />} Link with code
          </Button>
          {agent === "grok" && (
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
              {pending === "import" ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}{" "}
              Import server login
            </Button>
          )}
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
          <LinkStep title="1 · Open">
            <LinkOpenUrl url={link.url} />
          </LinkStep>
          <LinkStep title="2 · Enter this code">
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
          </LinkStep>
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
              await api.cancelDeviceLink(agent);
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
