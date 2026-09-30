import React, { useEffect, useState } from "react";
import { Loader2, ShieldOff, X } from "lucide-react";
import { DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT, type DaemonConfig } from "@orquester/config";
import { cn } from "../../lib/cn";
import { Button, Input, Modal, PasswordVerify, Switch } from "../ui";
import { useApi } from "../../context/orquester-context";
import { useAppStore } from "../../store/app";
import { Badge, FormField, Notice, SettingRow, SettingsPage, SettingsSection } from "./primitives";

/** The editable slice of daemon.json, as the form holds it. */
interface Draft {
  workspacesDir: string;
  httpEnabled: boolean;
  host: string;
  port: string;
}

const EMPTY_DRAFT: Draft = { workspacesDir: "", httpEnabled: false, host: "", port: "" };

const draftFrom = (config: DaemonConfig): Draft => ({
  workspacesDir: config.workspacesDir,
  httpEnabled: config.transports.http.enabled,
  host: config.transports.http.host,
  port: String(config.transports.http.port)
});

/**
 * The daemon masks the hash as a sentinel when one is set (never the hash
 * itself), so its presence is all this page can — and needs to — know.
 */
const passwordSetIn = (config: DaemonConfig): boolean => Boolean(config.transports.http.passwordHash);

const validPort = (value: string): boolean => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
};

const serverMessage = (err: unknown): string | null => {
  const message = (err as { serverMessage?: unknown } | null)?.serverMessage;
  return typeof message === "string" && message ? message : null;
};

type SaveResult = { tone: "ok" | "danger"; title: string; detail?: string };

export const ServerSettings: React.FC = () => {
  const api = useApi();
  const connections = useAppStore((s) => s.connections);
  const activeId = useAppStore((s) => s.activeConnectionId);
  const isLocal = connections.find((c) => c.id === activeId)?.kind === "local";
  const protectArchived = useAppStore((s) => s.protectArchived);
  const setProtectArchived = useAppStore((s) => s.setProtectArchived);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [protectError, setProtectError] = useState<string | null>(null);

  // `saved` is the config as last read from / written to the daemon; `draft` is
  // the form. The save bar appears only while they differ.
  const [saved, setSaved] = useState<Draft | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [passwordSet, setPasswordSet] = useState(false);
  const [password, setPassword] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SaveResult | null>(null);

  useEffect(() => {
    let active = true;
    // A new connection starts from nothing: a failed read must not leave the
    // previous daemon's values in an editable form.
    setSaved(null);
    setDraft(EMPTY_DRAFT);
    setLoadFailed(false);
    api
      .getDaemonConfig()
      .then((config: DaemonConfig) => {
        if (!active) return;
        const loaded = draftFrom(config);
        setSaved(loaded);
        setDraft(loaded);
        setPasswordSet(passwordSetIn(config));
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [api]);

  const loaded = saved !== null;
  const editable = isLocal && loaded && !busy;

  const edit = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setResult(null);
  };

  const transportDirty =
    saved !== null &&
    (draft.httpEnabled !== saved.httpEnabled ||
      draft.host !== saved.host ||
      draft.port !== saved.port ||
      password !== "");
  const dirty = saved !== null && (transportDirty || draft.workspacesDir !== saved.workspacesDir);

  // Client-side mirrors of what the daemon would reject, so the save bar can
  // say why instead of round-tripping for a 400.
  const portError = draft.httpEnabled && draft.port.trim() !== "" && !validPort(draft.port.trim());
  const passwordTooShort = password !== "" && password.length < 8;
  const passwordMissing = draft.httpEnabled && !passwordSet && password === "";
  const hostMissing = draft.httpEnabled && !draft.host.trim();
  const blocker = !draft.workspacesDir.trim()
    ? "Set a workspaces directory."
    : hostMissing
      ? "Enter a host for remote access."
      : portError
        ? "Enter a port between 1 and 65535."
        : passwordTooShort
          ? "The password needs at least 8 characters."
          : passwordMissing
            ? "Set a password to turn on remote access."
            : null;

  const discard = () => {
    if (saved) setDraft(saved);
    setPassword("");
    setResult(null);
  };

  const save = async () => {
    setBusy(true);
    setResult(null);
    try {
      const next = await api.updateDaemonConfig({
        workspacesDir: draft.workspacesDir,
        // Partial patch: the daemon merges onto its existing http config, so
        // unmanaged fields (username, fsRoot, passwordHash) are preserved.
        transports: {
          http: {
            enabled: draft.httpEnabled,
            host: draft.host,
            port: Number(draft.port) || DEFAULT_HTTP_PORT,
            ...(password ? { password } : {})
          } as DaemonConfig["transports"]["http"]
        }
      });
      // Adopt what the daemon actually stored (normalised port, etc.) so the
      // form is clean against it.
      const stored = next?.transports?.http ? draftFrom(next) : draft;
      setSaved(stored);
      setDraft(stored);
      if (next?.transports?.http) setPasswordSet(passwordSetIn(next));
      else if (password) setPasswordSet(true);
      setPassword("");
      setResult({
        tone: "ok",
        title: "Saved",
        // The daemon hot-restarts its HTTP listener on every save.
        detail: transportDirty ? "Remote access restarted with the new settings." : undefined
      });
    } catch (err) {
      setResult({
        tone: "danger",
        title: "Could not save",
        detail: serverMessage(err) ?? "Daemon config is editable only over the local socket."
      });
    } finally {
      setBusy(false);
    }
  };

  const changeProtect = (enabled: boolean) => {
    setProtectError(null);
    setProtectArchived(enabled).catch(() => setProtectError("Could not change archived-data protection."));
  };

  const placeholder = loaded ? undefined : "Loading…";

  return (
    <SettingsPage title="Server" description="Where the daemon keeps workspaces and how remote clients reach it.">
      {(!isLocal || loadFailed) && (
        <div className="space-y-2">
          {!isLocal && (
            <Notice tone="info" title="Read-only on this connection">
              Server settings can only be changed from the local app (unix socket). Connected over HTTP they are
              read-only — except “Protect archived data”, which has its own endpoint and can be changed from any
              client.
            </Notice>
          )}
          {loadFailed && <Notice tone="danger">Could not load daemon config.</Notice>}
        </div>
      )}

      <SettingsSection title="Storage">
        <SettingRow
          stacked
          label="Workspaces directory"
          htmlFor="server-workspaces-dir"
          description={
            <>
              The root folder every workspace lives in. Supports <code className="text-neutral-400">$userhome</code>{" "}
              and <code className="text-neutral-400">$appdir</code>; existing workspaces are not moved.
            </>
          }
        >
          <Input
            id="server-workspaces-dir"
            className="font-mono text-xs"
            spellCheck={false}
            autoComplete="off"
            value={draft.workspacesDir}
            placeholder={placeholder}
            disabled={!editable}
            onChange={(e) => edit({ workspacesDir: e.target.value })}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title="Remote access"
        description="Expose the daemon over HTTP to the web app and other clients. Every request is token-gated."
        actions={
          saved &&
          (saved.httpEnabled ? (
            <Badge tone="ok">
              Listening on {saved.host}:{saved.port}
            </Badge>
          ) : (
            <Badge>Off</Badge>
          ))
        }
      >
        <SettingRow label="External HTTP access" description="Serve remote clients in addition to the local socket.">
          <Switch
            label="External HTTP access"
            checked={draft.httpEnabled}
            disabled={!editable}
            onChange={(httpEnabled) => {
              edit({ httpEnabled });
              // The password field hides with the rest; don't send what can't be seen.
              if (!httpEnabled) setPassword("");
            }}
          />
        </SettingRow>

        {draft.httpEnabled && (
          <>
            <div className="grid gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_8rem]">
              <FormField
                label="Host"
                htmlFor="server-http-host"
                hint={
                  <>
                    <code>127.0.0.1</code> behind a reverse proxy; <code>0.0.0.0</code> for every interface.
                  </>
                }
              >
                <Input
                  id="server-http-host"
                  className="font-mono text-xs"
                  spellCheck={false}
                  autoComplete="off"
                  value={draft.host}
                  placeholder={DEFAULT_HTTP_HOST}
                  disabled={!editable}
                  onChange={(e) => edit({ host: e.target.value })}
                />
              </FormField>
              <FormField label="Port" htmlFor="server-http-port">
                <Input
                  id="server-http-port"
                  className={cn("font-mono text-xs tabular-nums", portError && "border-danger")}
                  inputMode="numeric"
                  autoComplete="off"
                  aria-invalid={portError || undefined}
                  value={draft.port}
                  placeholder={String(DEFAULT_HTTP_PORT)}
                  disabled={!editable}
                  onChange={(e) => edit({ port: e.target.value })}
                />
              </FormField>
            </div>

            <SettingRow
              stacked
              htmlFor="server-http-password"
              label={
                <span className="inline-flex items-center gap-2">
                  Password
                  {loaded && (passwordSet ? <Badge tone="ok">Set</Badge> : <Badge tone="warn">Not set</Badge>)}
                </span>
              }
              description={
                passwordSet
                  ? "Leave blank to keep the current password. At least 8 characters."
                  : "Required to turn on remote access. At least 8 characters."
              }
            >
              <Input
                id="server-http-password"
                type="password"
                // Never let the browser fill a saved login in here: that would
                // silently mark the form dirty with someone else's password.
                autoComplete="new-password"
                data-1p-ignore=""
                data-lpignore="true"
                className={cn(passwordTooShort && "border-danger")}
                aria-invalid={passwordTooShort || undefined}
                placeholder={passwordSet ? "••••••••" : "New password"}
                value={password}
                disabled={!editable}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setResult(null);
                }}
              />
            </SettingRow>
          </>
        )}

        {isLocal && transportDirty && (
          <div className="px-4 py-3">
            <Notice tone="warn">
              Saving restarts the HTTP listener: connected remote clients drop and reconnect with the new settings.
            </Notice>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="Security">
        <SettingRow
          label={
            <span className="inline-flex items-center gap-2">
              Protect archived data
              {!isLocal && <Badge tone="info">Editable from any client</Badge>}
            </span>
          }
          description="Ask for the password before showing archived workspaces and projects. Other open clients pick the change up on their next connect."
        >
          <Switch
            label="Protect archived data"
            checked={protectArchived}
            onChange={(next) => {
              if (next) {
                changeProtect(true);
              } else {
                // Retype-to-disable (spec decision #6): the curtain must not be
                // one-click removable on an unattended open session.
                setConfirmDisable(true);
              }
            }}
          />
        </SettingRow>
        {protectError && (
          <div className="px-4 py-3">
            <Notice tone="danger">{protectError}</Notice>
          </div>
        )}
      </SettingsSection>

      {isLocal && (dirty || result) && (
        <div className="sticky bottom-0 z-10 space-y-2 pt-2">
          {result && (
            <div className="rounded-lg bg-neutral-900">
              <Notice
                tone={result.tone}
                title={result.title}
                action={
                  <button
                    type="button"
                    aria-label="Dismiss"
                    onClick={() => setResult(null)}
                    className="rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
                  >
                    <X size={13} />
                  </button>
                }
              >
                {result.detail && <p>{result.detail}</p>}
              </Notice>
            </div>
          )}
          {dirty && (
            <div
              role="region"
              aria-label="Unsaved changes"
              className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-neutral-700 bg-neutral-900 px-4 py-2.5 shadow-lg"
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm text-neutral-200">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
                  Unsaved changes
                </p>
                {blocker && <p className="mt-0.5 text-xs text-warn">{blocker}</p>}
              </div>
              <div className="ml-auto flex items-center gap-2">
                <Button size="sm" variant="ghost" disabled={busy} onClick={discard}>
                  Discard
                </Button>
                <Button size="sm" disabled={busy || blocker !== null} onClick={() => void save()}>
                  {busy && <Loader2 size={13} className="animate-spin" />}
                  {busy ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <Modal open={confirmDisable} onClose={() => setConfirmDisable(false)} className="max-w-sm">
        <div className="w-full space-y-3 p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-warn-soft/40 text-warn">
              <ShieldOff size={15} />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-neutral-100">Turn off archived-data protection</p>
              <p className="mt-0.5 text-xs leading-relaxed text-neutral-500">
                Archived workspaces and projects will show without asking for the password.
              </p>
            </div>
          </div>
          <div className="-mx-2">
            <PasswordVerify
              autoFocus
              message="Retype your password to turn this off."
              onCancel={() => setConfirmDisable(false)}
              onVerified={() => {
                setConfirmDisable(false);
                changeProtect(false);
              }}
            />
          </div>
        </div>
      </Modal>
    </SettingsPage>
  );
};
