import React, { useCallback, useEffect, useId, useState } from "react";
import { Link2, Loader2 } from "lucide-react";
import { Button, Input } from "../ui";
import { useAppStore } from "../../store/app";
import { Notice, SettingRow } from "./primitives";
import { formatStamp, linkErrorMessage, LinkOpenUrl, LinkStep } from "./account-link-parts";

/**
 * The Claude account's sign-in, as an alternative to importing
 * `.credentials.json`. Claude.ai has no device-code login, so this is the
 * CLI's manual-redirect login: the daemon hands out the authorize URL, the
 * user signs in and copies the code Anthropic's callback page shows, and the
 * pasted code completes it — the PKCE verifier never leaves the daemon. The
 * new account appears in the list above via `agent-accounts.changed`.
 */
export const ClaudeOAuthLink: React.FC = () => {
  const api = useAppStore((s) => s.api);
  const status = useAppStore((s) => s.claudeOAuthLink);
  const loadClaudeOAuthLink = useAppStore((s) => s.loadClaudeOAuthLink);
  const loadAgentAccounts = useAppStore((s) => s.loadAgentAccounts);
  const [pending, setPending] = useState<"start" | "submit" | "cancel" | null>(null);
  const busy = pending !== null;
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const codeId = useId();

  // A sign-in started elsewhere is still pending on the daemon;
  // `claude-link.changed` keeps it current from here.
  useEffect(() => {
    void loadClaudeOAuthLink();
  }, [loadClaudeOAuthLink]);

  const run = useCallback(
    async (action: "start" | "submit" | "cancel", fn: () => Promise<unknown>) => {
      setPending(action);
      setError(null);
      try {
        await fn();
        setCode("");
      } catch (e) {
        setError(linkErrorMessage(e));
      } finally {
        setPending(null);
        await loadClaudeOAuthLink();
      }
    },
    [loadClaudeOAuthLink]
  );

  const linking = status?.state === "linking";
  const link = status?.link ?? null;

  const feedback = (
    <>
      {error && <Notice tone="danger">{error}</Notice>}
      {!linking && status?.lastError && (
        <Notice tone="warn" title="Last sign-in failed">
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
          label="Sign in with Claude"
          description="Sign in on claude.ai, then paste the code the page shows back here."
        >
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            title="Sign in on claude.ai and paste back its code"
            onClick={() => {
              void run("start", async () => {
                if (!api) throw new Error("not connected");
                await api.startClaudeOAuthLink();
              });
            }}
          >
            {pending === "start" ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />} Sign in
          </Button>
        </SettingRow>
        {(error || status?.lastError) && <div className="space-y-2 px-4 pb-3.5">{feedback}</div>}
      </div>
    );
  }

  const submit = () => {
    if (!code.trim()) return;
    void run("submit", async () => {
      if (!api) throw new Error("not connected");
      await api.submitClaudeOAuthCode({ code: code.trim() });
      await loadAgentAccounts();
    });
  };

  return (
    <div className="space-y-3 px-4 py-4">
      {link && (
        <ol className="grid gap-3 sm:grid-cols-2">
          <LinkStep title="1 · Open and sign in">
            <LinkOpenUrl url={link.url} />
          </LinkStep>
          <LinkStep title="2 · Paste the code it shows">
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <label htmlFor={codeId} className="sr-only">
                Sign-in code
              </label>
              <Input
                id={codeId}
                className="min-w-0 flex-1 font-mono"
                placeholder="Paste code"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={busy}
              />
              <Button type="submit" size="sm" disabled={busy || !code.trim()}>
                {pending === "submit" ? <Loader2 size={13} className="animate-spin" /> : null} Add
              </Button>
            </form>
          </LinkStep>
        </ol>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-neutral-500">
          {link ? `Link expires ${formatStamp(link.expiresAt)}. ` : ""}The account appears above once the code is
          accepted.
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            void run("cancel", async () => {
              if (!api) throw new Error("not connected");
              await api.cancelClaudeOAuthLink();
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
