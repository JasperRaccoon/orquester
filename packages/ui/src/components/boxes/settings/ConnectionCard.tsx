import React, { useEffect, useState } from "react";
import { Check, Copy, Loader2, PlugZap, Trash2, Wand2 } from "lucide-react";
import type { BoxConnectionMode, BoxConnectionSettings } from "@orquester/api";

import { useAppStore } from "../../../store/app";
import { copyText } from "../../../lib/clipboard";
import { boxesErrorText } from "../../../lib/boxes/errors";
import { relativeTime } from "../../../lib/relative-time";
import { saveBoxConnection, setupBoxTailscaleServe, testBoxConnection, useBoxConnection } from "../../../lib/boxes/store";
import { cn } from "../../../lib/cn";
import { Button, ConfirmDialog, Input } from "../../ui";
import { Badge, FormField, Notice, SegmentedControl, SettingRow, SettingsSection } from "../../settings/primitives";
import {
  connectionDraft,
  connectionProblems,
  connectionRequest,
  reachabilityView,
  tailscaleLocalView,
  tailscaleSetupFailure,
  type ConnectionDraft,
  type TailscaleCredentialKind
} from "./connection.logic";

const MODES: { value: BoxConnectionMode; label: string }[] = [
  { value: "public-url", label: "Public URL" },
  { value: "tailscale", label: "Tailscale" }
];

const CREDENTIAL_KINDS: { value: TailscaleCredentialKind; label: string }[] = [
  { value: "api-token", label: "API token" },
  { value: "oauth", label: "OAuth client" }
];

/**
 * The Connection card: how boxes reach this daemon (its public HTTPS address,
 * or Tailscale), the tailnet policy snippet, and the reachability check.
 */
export const ConnectionCard: React.FC = () => {
  const api = useAppStore((s) => s.api);
  const settings = useBoxConnection();
  const [draft, setDraft] = useState<ConnectionDraft>(() => connectionDraft(settings));
  const [dirty, setDirty] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState<"save" | "check" | "clear" | "setup" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setupFailure, setSetupFailure] = useState<{ message: string; commands: string[] } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  // The daemon's settings replace the draft until the user edits it.
  useEffect(() => {
    if (!dirty) setDraft(connectionDraft(settings));
  }, [settings, dirty]);

  if (!settings) {
    return (
      <SettingsSection title="Connection">
        <div className="flex items-center gap-2 px-4 py-6 text-sm text-neutral-500">
          <Loader2 size={14} className="animate-spin" /> Loading connection settings…
        </div>
      </SettingsSection>
    );
  }

  const edit = (patch: Partial<ConnectionDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setDirty(true);
  };
  const problems = attempted ? connectionProblems(draft, settings) : {};
  const request = connectionRequest(draft, settings);
  const reachability = reachabilityView(settings);
  const local = tailscaleLocalView(settings, draft.daemonUrl);
  const checked = settings.checkedAt ? relativeTime(settings.checkedAt) : "";

  const run = async (kind: "save" | "check" | "clear", call: () => Promise<BoxConnectionSettings>) => {
    setBusy(kind);
    setError(null);
    try {
      const next = await call();
      if (kind !== "check") {
        // Saved: the typed secrets are dropped, the form shows the daemon's state.
        setDirty(false);
        setAttempted(false);
        setDraft(connectionDraft(next));
      }
    } catch (err) {
      setError(boxesErrorText(err));
    } finally {
      setBusy(null);
    }
  };

  // "Set up for me": the daemon serves itself on the tailnet, saves that URL (Tailscale mode) and checks it.
  const setUp = async () => {
    if (!api) return;
    setBusy("setup");
    setError(null);
    setSetupFailure(null);
    try {
      const next = await setupBoxTailscaleServe(api);
      if (draft.apiToken.trim() || draft.oauthClientId.trim() || draft.oauthClientSecret.trim()) {
        // Typed credentials are not saved yet: keep them, take the new address.
        setDraft((current) => ({ ...current, mode: next.mode, daemonUrl: next.tailscale.daemonUrl ?? current.daemonUrl }));
      } else {
        setDirty(false);
        setAttempted(false);
        setDraft(connectionDraft(next));
      }
    } catch (err) {
      setSetupFailure(tailscaleSetupFailure(err));
    } finally {
      setBusy(null);
    }
  };

  const save = () => {
    setAttempted(true);
    if (!api || !request) return;
    void run("save", () => saveBoxConnection(api, request));
  };

  // Both modes: in Tailscale mode macOS boxes still dial it (their runners are outside the tailnet).
  const publicUrlField = (
    <FormField
      label={draft.mode === "public-url" ? "Public URL" : "Public URL (also used by macOS boxes)"}
      htmlFor="box-public-url"
      hint={
        problems.publicUrl ? (
          <span className="text-danger">{problems.publicUrl}</span>
        ) : draft.mode === "public-url" ? (
          "This server's HTTPS address, e.g. https://orquester.example.com."
        ) : (
          "Optional. macOS boxes run on GitHub Actions runners outside your tailnet and dial this address."
        )
      }
    >
      <Input
        id="box-public-url"
        placeholder="https://"
        value={draft.publicUrl}
        disabled={busy !== null}
        aria-invalid={problems.publicUrl ? true : undefined}
        onChange={(e) => edit({ publicUrl: e.target.value })}
      />
    </FormField>
  );

  return (
    <SettingsSection
      title="Connection"
      description="How boxes reach this Orquester server. Each box connects out to it; nothing is opened on the box."
    >
      <SettingRow label="Boxes connect through" description="Use the public URL on a server; Tailscale on a desktop or a private network.">
        <SegmentedControl
          ariaLabel="Connection mode"
          value={draft.mode}
          options={MODES}
          onChange={(mode) => edit({ mode })}
        />
      </SettingRow>

      {draft.mode === "public-url" ? (
        <div className="px-4 py-3.5">{publicUrlField}</div>
      ) : (
        <div className="space-y-3 px-4 py-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SegmentedControl
              size="xs"
              ariaLabel="Tailscale credentials"
              value={draft.credentialKind}
              options={CREDENTIAL_KINDS}
              onChange={(credentialKind) => edit({ credentialKind })}
            />
            {settings.tailscale.configured && (
              <span className="flex items-center gap-2 text-xs text-neutral-500">
                <Badge tone="ok">Stored</Badge>
                {settings.tailscale.keyHint && <>…{settings.tailscale.keyHint}</>}
                {settings.tailscale.tailnet && <> · {settings.tailscale.tailnet}</>}
              </span>
            )}
          </div>
          {draft.credentialKind === "api-token" ? (
            <FormField
              label="API access token"
              htmlFor="box-ts-token"
              hint={
                problems.apiToken ? (
                  <span className="text-danger">{problems.apiToken}</span>
                ) : settings.tailscale.configured ? (
                  "Leave empty to keep the stored credentials."
                ) : (
                  "A tskey-api-… token from the Tailscale admin console (Settings → Keys)."
                )
              }
            >
              <Input
                id="box-ts-token"
                type="password"
                // Chrome ignores "off" on a password field and would fill a saved
                // login's username into the plugin search above.
                autoComplete="new-password"
                data-1p-ignore
                placeholder={settings.tailscale.configured ? "Enter a new token" : "tskey-api-…"}
                value={draft.apiToken}
                disabled={busy !== null}
                aria-invalid={problems.apiToken ? true : undefined}
                onChange={(e) => edit({ apiToken: e.target.value })}
              />
            </FormField>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                label="OAuth client ID"
                htmlFor="box-ts-client-id"
                hint={problems.oauthClientId ? <span className="text-danger">{problems.oauthClientId}</span> : "Needs the auth_keys write scope."}
              >
                <Input
                  id="box-ts-client-id"
                  autoComplete="off"
                  value={draft.oauthClientId}
                  disabled={busy !== null}
                  aria-invalid={problems.oauthClientId ? true : undefined}
                  onChange={(e) => edit({ oauthClientId: e.target.value })}
                />
              </FormField>
              <FormField
                label="OAuth client secret"
                htmlFor="box-ts-client-secret"
                hint={problems.oauthClientSecret ? <span className="text-danger">{problems.oauthClientSecret}</span> : undefined}
              >
                <Input
                  id="box-ts-client-secret"
                  type="password"
                  autoComplete="new-password"
                  data-1p-ignore
                  value={draft.oauthClientSecret}
                  disabled={busy !== null}
                  aria-invalid={problems.oauthClientSecret ? true : undefined}
                  onChange={(e) => edit({ oauthClientSecret: e.target.value })}
                />
              </FormField>
            </div>
          )}
          <FormField
            label="This server on the tailnet"
            htmlFor="box-ts-daemon-url"
            hint={
              problems.daemonUrl ? (
                <span className="text-danger">{problems.daemonUrl}</span>
              ) : (
                "The address boxes dial — Tailscale must serve Orquester there, e.g. https://my-pc.tail1234.ts.net:10000."
              )
            }
          >
            <Input
              id="box-ts-daemon-url"
              placeholder="https://"
              value={draft.daemonUrl}
              disabled={busy !== null}
              aria-invalid={problems.daemonUrl ? true : undefined}
              onChange={(e) => edit({ daemonUrl: e.target.value })}
            />
          </FormField>
          {local.status && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex min-w-0 items-center gap-2 text-xs text-neutral-400" data-testid="box-ts-local-status">
                <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", local.tone === "ok" ? "bg-ok" : "bg-warn")} />
                <span className="min-w-0 break-words">{local.status}</span>
              </span>
              {local.suggestion && (
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => edit({ daemonUrl: local.suggestion ?? "" })}>
                  Use {local.suggestion}
                </Button>
              )}
              {local.canSetUp && (
                <Button size="sm" variant="outline" className="ml-auto" disabled={busy !== null} onClick={() => void setUp()}>
                  {busy === "setup" ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                  {busy === "setup" ? "Setting up…" : "Set up for me"}
                </Button>
              )}
            </div>
          )}
          {setupFailure && !settings.tailscale.local?.serving && (
            <Notice tone="warn" title="Tailscale isn't serving Orquester yet">
              <p>{setupFailure.message}</p>
              {setupFailure.commands.length > 0 && <CopyBlock label="Commands" ariaLabel="Copy the commands" text={setupFailure.commands.join("\n")} />}
            </Notice>
          )}
          {publicUrlField}
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              label="Federated identity client ID (macOS boxes)"
              htmlFor="box-ts-workload-id"
              hint={
                problems.workloadClientId ? (
                  <span className="text-danger">{problems.workloadClientId}</span>
                ) : (
                  "Optional, instead of a public URL: macOS runners join the tailnet with it."
                )
              }
            >
              <Input
                id="box-ts-workload-id"
                autoComplete="off"
                value={draft.workloadClientId}
                disabled={busy !== null}
                aria-invalid={problems.workloadClientId ? true : undefined}
                onChange={(e) => edit({ workloadClientId: e.target.value })}
              />
            </FormField>
            <FormField
              label="Federated identity audience"
              htmlFor="box-ts-workload-audience"
              hint={problems.workloadAudience ? <span className="text-danger">{problems.workloadAudience}</span> : undefined}
            >
              <Input
                id="box-ts-workload-audience"
                autoComplete="off"
                value={draft.workloadAudience}
                disabled={busy !== null}
                aria-invalid={problems.workloadAudience ? true : undefined}
                onChange={(e) => edit({ workloadAudience: e.target.value })}
              />
            </FormField>
          </div>
          {settings.tailscale.policySnippet && (
            <div className="space-y-1.5">
              <CopyBlock label="Tailnet policy" ariaLabel="Copy the policy snippet" text={settings.tailscale.policySnippet} />
              <p className="text-[11px] leading-relaxed text-neutral-500">
                Paste it into your tailnet policy (Access controls). It lets boxes tagged tag:orq-box reach only this server's port.
              </p>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <Button size="sm" disabled={busy !== null || (!dirty && !request)} onClick={save}>
          {busy === "save" && <Loader2 size={12} className="animate-spin" />} Save
        </Button>
        <Button size="sm" variant="outline" disabled={busy !== null || dirty} title={dirty ? "Save first." : undefined} onClick={() => api && void run("check", () => testBoxConnection(api))}>
          {busy === "check" ? <Loader2 size={12} className="animate-spin" /> : <PlugZap size={12} />} Check
        </Button>
        <Badge tone={reachability.tone} title={reachability.title ?? undefined}>
          {reachability.label}
        </Badge>
        {checked && <span className="text-xs text-neutral-500">checked {checked}</span>}
        {draft.mode === "tailscale" && settings.tailscale.configured && (
          <Button size="sm" variant="ghost" className="ml-auto" disabled={busy !== null} onClick={() => setConfirmClear(true)}>
            <Trash2 size={12} /> Remove Tailscale credentials
          </Button>
        )}
      </div>
      {(settings.reachable === "failed" && settings.reachableMessage) || error ? (
        <div className="space-y-2 px-4 py-3">
          {error && (
            <Notice tone="danger" title="Not saved">
              {error}
            </Notice>
          )}
          {settings.reachable === "failed" && settings.reachableMessage && (
            <Notice tone="warn" title="Boxes can't reach this server">
              {settings.reachableMessage}
            </Notice>
          )}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmClear}
        title="Remove the Tailscale credentials?"
        message="Orquester forgets them. New boxes can't join the tailnet until you add them again."
        confirmLabel="Remove"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          setConfirmClear(false);
          if (api) void run("clear", () => saveBoxConnection(api, { clearTailscale: true }));
        }}
      />
    </SettingsSection>
  );
};

/** Text to copy: the tailnet policy snippet (Orquester never edits the policy itself), or shell commands. */
const CopyBlock: React.FC<{ label: string; ariaLabel: string; text: string }> = ({ label, ariaLabel, text }) => {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-neutral-300">{label}</span>
        <Button
          size="sm"
          variant="ghost"
          aria-label={ariaLabel}
          onClick={() => void copyText(text).then((ok) => setCopied(ok))}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="max-h-48 overflow-auto rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-[11px] leading-relaxed text-neutral-300">
        <code>{text}</code>
      </pre>
    </div>
  );
};
