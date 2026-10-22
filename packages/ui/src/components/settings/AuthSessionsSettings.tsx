import React, { useCallback, useEffect, useState } from "react";
import { KeyRound, Laptop, Loader2, LogOut, Plus, X } from "lucide-react";
import { AUTH_SESSION_LABEL_MAX, type AuthIssuedTokenResponse, type AuthSessionSummary } from "@orquester/api";
import { Button, Input } from "../ui";
import { CopyButton } from "../agent-chat/primitives/CopyButton";
import { useApi } from "../../context/orquester-context";
import { relativeTime } from "../../lib/relative-time";
import { useAppStore } from "../../store/app";
import { Badge, EmptyState, Notice, SettingsSection } from "./primitives";

const errorText = (err: unknown, fallback: string): string => {
  const message = (err as { serverMessage?: unknown } | null)?.serverMessage;
  return typeof message === "string" && message ? message : fallback;
};

const dateOf = (iso: string): string => {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString() : "";
};

/**
 * Settings → Server: the remote transport's signed-in devices and API tokens. A device session
 * comes from a password sign-in and lapses after 30 idle days; an API token is minted here for an
 * external client (an MCP client) and lasts until revoked. Changing the password signs every device
 * out; API tokens stay. The daemon keeps only token digests, so a new token is shown once.
 */
export const AuthSessionsSettings: React.FC<{ remoteAccessOn: boolean }> = ({ remoteAccessOn }) => {
  const api = useApi();
  const isLocal = api.connection.kind === "local";
  const signOut = useAppStore((s) => s.signOut);
  const [sessions, setSessions] = useState<AuthSessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmOthers, setConfirmOthers] = useState(false);
  const [naming, setNaming] = useState(false);
  const [label, setLabel] = useState("");
  const [issued, setIssued] = useState<AuthIssuedTokenResponse | null>(null);

  const reload = useCallback(async () => {
    try {
      setSessions((await api.listAuthSessions()).sessions);
      setError(null);
    } catch (err) {
      setError(errorText(err, "Could not load signed-in devices."));
    }
  }, [api]);

  useEffect(() => {
    setSessions(null);
    setIssued(null);
    void reload();
  }, [reload]);

  const run = async (id: string, action: () => Promise<unknown>, failure: string) => {
    setBusyId(id);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err, failure));
    } finally {
      setBusyId(null);
      await reload();
    }
  };

  const revoke = (session: AuthSessionSummary) =>
    session.current
      ? void signOut()
      : void run(session.id, () => api.revokeAuthSession(session.id), "Could not revoke it.");

  const revokeOthers = () => {
    setConfirmOthers(false);
    void run("others", () => api.revokeOtherAuthSessions(), "Could not revoke the other sessions.");
  };

  const createToken = () => {
    const name = label.trim();
    if (!name) return;
    void run(
      "create",
      async () => {
        setIssued(await api.createApiToken(name));
        setNaming(false);
        setLabel("");
      },
      "Could not create the token."
    );
  };

  const others = (sessions ?? []).filter((session) => !session.current).length;
  // Where an MCP client reaches this daemon: this connection's origin when remote; over the
  // socket the public URL is not known here.
  const mcpUrl = `${isLocal ? "https://<your-domain>" : api.connection.endpoint.replace(/\/$/, "")}/mcp`;

  return (
    <SettingsSection
      title="Signed-in devices and API tokens"
      description="Each sign-in gets its own token, which lapses after 30 days without use. Revoke one to sign that device out. Changing the password signs every device out; API tokens stay until you revoke them."
      actions={
        <>
          {others > 0 &&
            (confirmOthers ? (
              <>
                <Button size="sm" variant="ghost" onClick={() => setConfirmOthers(false)}>
                  Keep
                </Button>
                <Button size="sm" variant="outline" className="text-danger-300" disabled={busyId !== null} onClick={revokeOthers}>
                  Revoke {others} {isLocal ? "" : "other "}
                  {others === 1 ? "session" : "sessions"}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" disabled={busyId !== null} onClick={() => setConfirmOthers(true)}>
                {isLocal ? "Revoke all" : "Revoke all others"}
              </Button>
            ))}
          {!naming && (
            <Button size="sm" variant="outline" onClick={() => setNaming(true)}>
              <Plus size={13} />
              API token
            </Button>
          )}
        </>
      }
    >
      {!remoteAccessOn && isLocal && (
        <div className="px-4 py-3">
          <Notice tone="info">Remote access is off: no token is accepted until it is turned back on.</Notice>
        </div>
      )}

      {naming && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <Input
            autoFocus
            aria-label="API token name"
            className="min-w-0 flex-1 basis-56"
            maxLength={AUTH_SESSION_LABEL_MAX}
            placeholder="Name, e.g. Claude Code on my laptop"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") createToken();
              if (e.key === "Escape") setNaming(false);
            }}
          />
          <Button size="sm" variant="ghost" onClick={() => setNaming(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!label.trim() || busyId !== null} onClick={createToken}>
            {busyId === "create" && <Loader2 size={13} className="animate-spin" />}
            Create
          </Button>
        </div>
      )}

      {issued && (
        <div className="space-y-2 px-4 py-3">
          <Notice
            tone="ok"
            title={`Token “${issued.session.label}” created`}
            action={
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => setIssued(null)}
                className="rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
              >
                <X size={13} />
              </button>
            }
          >
            <p>Copy it now: it is not shown again. It works until you revoke it.</p>
          </Notice>
          <div className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-950 px-2.5 py-1.5">
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-200" data-testid="issued-token">
              {issued.token}
            </code>
            <CopyButton value={issued.token} label="Copy token" />
          </div>
          <p className="text-xs leading-relaxed text-neutral-500">
            For an MCP client, send it as <code className="text-neutral-400">Authorization: Bearer &lt;token&gt;</code> to{" "}
            <code className="text-neutral-400">{mcpUrl}</code>, for example:
          </p>
          <pre className="overflow-x-auto rounded-md bg-neutral-950 px-2.5 py-1.5 font-mono text-[11px] text-neutral-300">
            claude mcp add --transport http --scope user orquester_remote {mcpUrl} --header "Authorization: Bearer &lt;token&gt;"
          </pre>
        </div>
      )}

      {error && (
        <div className="px-4 py-3">
          <Notice tone="danger">{error}</Notice>
        </div>
      )}

      {sessions === null ? (
        !error && <p className="px-4 py-3.5 text-xs text-neutral-500">Loading…</p>
      ) : sessions.length === 0 ? (
        <EmptyState
          icon={<Laptop size={16} />}
          title="No signed-in devices"
          description="Devices appear here after they sign in over remote access."
        />
      ) : (
        sessions.map((session) => (
          <div key={session.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
            <div className="flex min-w-0 flex-1 basis-60 gap-3">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-neutral-800/80 text-neutral-400">
                {session.kind === "api" ? <KeyRound size={14} /> : <Laptop size={14} />}
              </span>
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm text-neutral-200">
                  <span className="truncate">{session.label}</span>
                  {session.current && <Badge tone="ok">This device</Badge>}
                  {session.kind === "api" && <Badge tone="info">API token</Badge>}
                </p>
                <p className="mt-0.5 text-xs text-neutral-500">
                  Created {dateOf(session.createdAt)} · last used {relativeTime(session.lastUsedAt) || "never"}
                  {session.expiresAt && ` · lapses ${dateOf(session.expiresAt)} if unused`}
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={busyId !== null}
              onClick={() => revoke(session)}
              aria-label={session.current ? "Sign out" : `Revoke ${session.label}`}
            >
              {busyId === session.id ? <Loader2 size={13} className="animate-spin" /> : session.current && <LogOut size={13} />}
              {session.current ? "Sign out" : "Revoke"}
            </Button>
          </div>
        ))
      )}
    </SettingsSection>
  );
};
