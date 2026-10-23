import React, { useState } from "react";
import { ExternalLink, KeyRound, Loader2, MonitorCog, Trash2 } from "lucide-react";
import type { BoxProviderId, BoxProviderInfo } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { useAppStore } from "../../../store/app";
import { boxesErrorText } from "../../../lib/boxes/errors";
import {
  prepareBoxWindowsImage,
  removeBoxProviderCredentials,
  saveBoxProviderCredentials,
  useBoxesTotals,
  useBoxProviders
} from "../../../lib/boxes/store";
import { Button, ConfirmDialog } from "../../ui";
import { Badge, EmptyState, FormField, Notice, SettingsSection } from "../../settings/primitives";
import { BlacksmithRow } from "./BlacksmithSetup";
import { ProviderTile } from "./ProviderTile";
import {
  BLACKSMITH_PROVIDER_ID,
  credentialFieldMultiline,
  credentialProblems,
  credentialsPayload,
  keyProviders,
  providerConfigured,
  providerStatusView,
  providerSubline,
  totalsLine,
  windowsImageView,
  type CredentialValues
} from "./providers.logic";

/**
 * The Providers card: the totals line, one row per provider (clicking opens
 * its credentials form), and the Blacksmith macOS checklist.
 */
export const ProvidersCard: React.FC = () => {
  const providers = useBoxProviders();
  const totals = useBoxesTotals();
  const [openId, setOpenId] = useState<BoxProviderId | null>(null);
  const line = totalsLine(totals);
  const rows = keyProviders(providers);
  const blacksmith = providers?.find((provider) => provider.id === BLACKSMITH_PROVIDER_ID) ?? null;

  return (
    <SettingsSection
      title="Providers"
      actions={line ? <span className="text-xs text-neutral-500">{line}</span> : undefined}
    >
      {providers === null ? (
        <div className="flex items-center gap-2 px-4 py-6 text-sm text-neutral-500">
          <Loader2 size={14} className="animate-spin" /> Loading providers…
        </div>
      ) : rows.length === 0 && !blacksmith ? (
        <EmptyState icon={<KeyRound size={18} />} title="No providers" description="This server offers no box providers." />
      ) : (
        <>
          {rows.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              open={openId === provider.id}
              onToggle={() => setOpenId((current) => (current === provider.id ? null : provider.id))}
              onClose={() => setOpenId(null)}
            />
          ))}
          {blacksmith && <BlacksmithRow provider={blacksmith} />}
        </>
      )}
    </SettingsSection>
  );
};

const ProviderRow: React.FC<{
  provider: BoxProviderInfo;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}> = ({ provider, open, onToggle, onClose }) => {
  const api = useAppStore((s) => s.api);
  const status = providerStatusView(provider);
  const subline = providerSubline(provider);
  const windows = windowsImageView(provider);
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);

  const prepare = async () => {
    if (!api) return;
    setPreparing(true);
    setPrepareError(null);
    try {
      await prepareBoxWindowsImage(api, provider.id);
    } catch (err) {
      setPrepareError(boxesErrorText(err, "Could not start preparing the image."));
    } finally {
      setPreparing(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${provider.label} credentials`}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
        >
          <ProviderTile provider={provider} />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-neutral-100">{provider.label}</span>
            {subline && <span className="block truncate text-xs text-neutral-500" title={subline}>{subline}</span>}
            {provider.status === "error" && provider.error && (
              <span className="block truncate text-xs text-danger" title={provider.error}>
                {provider.error}
              </span>
            )}
          </span>
        </button>
        {status.kind === "pill" ? (
          <Badge tone={status.tone} title={status.title ?? undefined}>
            {status.label}
          </Badge>
        ) : (
          <Button size="sm" variant="outline" onClick={onToggle}>
            <KeyRound size={12} /> Add API key
          </Button>
        )}
      </div>

      {windows && (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-3 pl-16 text-xs text-neutral-400">
          <MonitorCog size={12} aria-hidden className="text-neutral-500" />
          Windows image
          <Badge tone={windows.tone} title={windows.message ?? undefined}>
            {windows.label}
          </Badge>
          {windows.message && <span className="min-w-0 truncate text-neutral-500">{windows.message}</span>}
          {windows.canPrepare && (
            <Button size="sm" variant="outline" className="ml-auto" disabled={preparing} onClick={() => void prepare()}>
              {preparing && <Loader2 size={12} className="animate-spin" />} Prepare Windows image
            </Button>
          )}
          {prepareError && <p className="basis-full text-danger">{prepareError}</p>}
        </div>
      )}

      {open && <ProviderForm provider={provider} onDone={onClose} />}
    </div>
  );
};

const inputClass =
  "w-full rounded-md border border-neutral-700 bg-neutral-900 px-2.5 text-sm text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500";

/**
 * A provider's credentials form. Fields start empty and secrets are masked:
 * the daemon never sends a stored value back, so changing a key means
 * entering every required field again. Save validates on the daemon (a cheap
 * read call at the provider) before anything is stored.
 */
const ProviderForm: React.FC<{ provider: BoxProviderInfo; onDone: () => void }> = ({ provider, onDone }) => {
  const api = useAppStore((s) => s.api);
  const [values, setValues] = useState<CredentialValues>({});
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const problems = credentialProblems(provider.credentialFields, values);
  const configured = providerConfigured(provider);

  const save = async () => {
    setAttempted(true);
    const credentials = credentialsPayload(provider.credentialFields, values);
    if (!api || !credentials) return;
    setBusy("save");
    setError(null);
    try {
      await saveBoxProviderCredentials(api, provider.id, credentials);
      // Write-only: nothing typed stays in memory once the daemon has it.
      setValues({});
      onDone();
    } catch (err) {
      setError(boxesErrorText(err, "The provider refused these credentials."));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!api) return;
    setBusy("remove");
    setError(null);
    try {
      await removeBoxProviderCredentials(api, provider.id);
      setValues({});
      onDone();
    } catch (err) {
      setError(boxesErrorText(err, "Could not remove the credentials."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <form
        aria-label={`${provider.label} credentials`}
        className="space-y-3 border-t border-neutral-800/80 bg-neutral-950/40 px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {provider.credentialFields.length === 0 && (
          <p className="text-xs text-neutral-500">This provider needs no credentials here.</p>
        )}
        {provider.credentialFields.map((field) => {
          const id = `box-provider-${provider.id}-${field.id}`;
          const problem = attempted ? problems[field.id] : undefined;
          const common = {
            id,
            name: field.id,
            value: values[field.id] ?? "",
            placeholder: field.placeholder ?? (configured && field.secret ? "Enter a new value" : undefined),
            disabled: busy !== null,
            autoComplete: "off",
            spellCheck: false,
            "aria-invalid": problem ? true : undefined,
            onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
              setValues((current) => ({ ...current, [field.id]: e.target.value }))
          } as const;
          return (
            <FormField
              key={field.id}
              htmlFor={id}
              label={
                <>
                  {field.label}
                  {field.optional && <span className="font-normal text-neutral-500"> (optional)</span>}
                </>
              }
              hint={problem ? <span className="text-danger">{problem}</span> : field.help}
            >
              {credentialFieldMultiline(field) ? (
                <textarea
                  {...common}
                  rows={4}
                  className={cn(inputClass, "py-1.5 font-mono text-xs", field.secret && "[-webkit-text-security:disc]")}
                />
              ) : (
                <input
                  {...common}
                  type={field.secret ? "password" : "text"}
                  // Chrome ignores "off" on a password field and would fill a saved
                  // login's username into the plugin search above.
                  autoComplete={field.secret ? "new-password" : "off"}
                  // Keeps password managers from offering to save a provider key as a login.
                  data-1p-ignore
                  data-lpignore="true"
                  className={cn(inputClass, "h-8")}
                />
              )}
            </FormField>
          );
        })}

        {error && (
          <Notice tone="danger" title="Not saved">
            {error}
          </Notice>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {provider.credentialFields.length > 0 && (
            <Button size="sm" type="submit" disabled={busy !== null}>
              {busy === "save" && <Loader2 size={12} className="animate-spin" />}
              {busy === "save" ? "Checking…" : "Save"}
            </Button>
          )}
          {configured && (
            <Button size="sm" variant="outline" type="button" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>
              {busy === "remove" ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Remove
            </Button>
          )}
          {provider.credentialsUrl && (
            <a
              href={provider.credentialsUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1 text-xs text-neutral-400 underline underline-offset-2 hover:text-neutral-200"
            >
              Get a key <ExternalLink size={11} />
            </a>
          )}
        </div>
      </form>

      <ConfirmDialog
        open={confirmRemove}
        title={`Remove the ${provider.label} credentials?`}
        message={`Orquester forgets them. New ${provider.label} boxes can't be created until you add them again.`}
        confirmLabel="Remove"
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false);
          void remove();
        }}
      />
    </>
  );
};
