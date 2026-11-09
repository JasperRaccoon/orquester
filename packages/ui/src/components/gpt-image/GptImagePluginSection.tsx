/**
 * Settings → Plugins → GPT Image (spec §8): which Codex account makes the images, where they are
 * saved besides the chat, and the active account's Codex quota. The settings are read and saved
 * with `gptImageRoutes.settings` whether or not the plugin is on, so they can be set before turning
 * it on; the quota is the usage the app already holds (the `usage` snapshot the daemon pushes on its
 * `usage` channel), joined by account id like the workflow account picker, never a poll of its own.
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ImagePlus, Loader2, RefreshCw, Users } from "lucide-react";
import type { GptImageSettingsResponse } from "@orquester/api";

import { cn } from "../../lib/cn";
import { useNow } from "../../lib/boxes/hooks";
import { accountUsageRows, formatResetIn, usageTone, type UsageBar } from "../../lib/workflows/inspector-usage";
import { useAppStore } from "../../store/app";
import { Button, Input } from "../ui";
import { Badge, EmptyState, InfoRow, Notice, SegmentedControl, SettingRow, SettingsSection } from "../settings/primitives";
import {
  GPT_IMAGE_AUTO_ACCOUNT,
  gptImageAccountOptions,
  gptImageErrorText,
  gptImageFolderProblem,
  gptImageQuotaAccountId,
  gptImageSettingsForm,
  gptImageSettingsPatch,
  type GptImageAccountOption,
  type GptImageSettingsForm
} from "./gpt-image-settings.logic";

const BLOCK_TEXT: Record<NonNullable<GptImageAccountOption["blocked"]>, string> = {
  "needs-reauth": "Needs sign-in",
  "free-plan": "Free plan — can't make images"
};

const SAVE_OPTIONS = [
  { value: "chat" as const, label: "This chat only" },
  { value: "project" as const, label: "Project folder" }
];

export const GptImagePluginSection: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const ids = useId();
  const api = useAppStore((s) => s.api);
  const connected = useAppStore((s) => s.connectionStatus === "connected");
  // The Codex accounts as the app knows them: a login added, removed or renewed in Accounts reads the settings again.
  const codexAccounts = useAppStore(
    (s) =>
      s.agentAccounts?.accounts
        .filter((account) => account.agent === "codex")
        .map((account) => `${account.id}:${account.needsReauth ? 1 : 0}:${account.plan ?? ""}`)
        .join(",") ?? ""
  );

  const [saved, setSaved] = useState<GptImageSettingsResponse | null>(null);
  const [form, setForm] = useState<GptImageSettingsForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  /** The form has edits a re-read must not throw away. */
  const edited = useRef(false);

  const load = useCallback(() => {
    if (!api) return;
    setLoadError(null);
    api.getGptImageSettings().then(
      (answer) => {
        if (useAppStore.getState().api !== api) return;
        setSaved(answer);
        if (!edited.current) setForm(gptImageSettingsForm(answer.settings));
      },
      (err: unknown) => {
        if (useAppStore.getState().api === api) setLoadError(gptImageErrorText(err, "Could not read the settings."));
      }
    );
  }, [api]);

  // On open, on a connection switch, after every reconnect, and when the Codex accounts change.
  useEffect(() => {
    if (connected) load();
  }, [connected, load, codexAccounts]);

  if (saved === null || form === null) {
    return (
      <SettingsSection title="Images">
        {loadError ? (
          <div className="px-4 py-3">
            <Notice
              tone="danger"
              title="Could not read the GPT Image settings"
              action={
                <Button size="sm" variant="outline" onClick={load}>
                  <RefreshCw size={13} /> Retry
                </Button>
              }
            >
              {loadError}
            </Notice>
          </div>
        ) : (
          <div className="flex items-center gap-2 px-4 py-3 text-sm text-neutral-500">
            <Loader2 size={13} className="animate-spin" /> Loading…
          </div>
        )}
      </SettingsSection>
    );
  }

  const change = (patch: Partial<GptImageSettingsForm>) => {
    edited.current = true;
    setForm({ ...form, ...patch });
    setSaveError(null);
    setJustSaved(false);
  };
  const reset = () => {
    edited.current = false;
    setForm(gptImageSettingsForm(saved.settings));
    setSaveError(null);
  };
  const folderProblem = form.saveKind === "project" ? gptImageFolderProblem(form.folder) : null;
  const result = gptImageSettingsPatch(saved.settings, form);
  const dirty = "patch" in result ? Object.keys(result.patch).length > 0 : true;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!api || saving) return;
    if ("error" in result) {
      setSaveError(result.error);
      return;
    }
    if (Object.keys(result.patch).length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const answer = await api.updateGptImageSettings(result.patch);
      if (useAppStore.getState().api !== api) return;
      edited.current = false;
      setSaved(answer);
      setForm(gptImageSettingsForm(answer.settings));
      setJustSaved(true);
    } catch (err) {
      if (useAppStore.getState().api === api) setSaveError(gptImageErrorText(err, "Could not save the settings."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SettingsSection title="Images">
        <form aria-label="GPT Image settings" className="divide-y divide-neutral-800/80" onSubmit={(event) => void save(event)}>
          {!enabled && (
            <div className="px-4 py-3">
              <Notice tone="info" title="GPT Image is off">
                You can choose these now; agents get the image tool once the plugin is turned on below.
              </Notice>
            </div>
          )}
          <SettingRow
            stacked
            label="Account"
            description="The Codex account whose ChatGPT plan makes the images. Auto uses the first one, in Settings → Accounts order, that can."
          >
            {saved.accounts.length === 0 ? (
              <NoAccounts />
            ) : (
              <AccountPicker
                options={gptImageAccountOptions(saved)}
                value={form.account}
                activeLabel={saved.accounts.find((account) => account.id === saved.activeAccountId)?.label ?? null}
                disabled={saving}
                onChange={(account) => change({ account })}
              />
            )}
          </SettingRow>
          <SettingRow
            stacked
            label="Save images to"
            description="Every image is kept with the chat that made it. Agents can still save a single image anywhere in the project."
          >
            <div className="space-y-2.5">
              <SegmentedControl
                ariaLabel="Save images to"
                value={form.saveKind}
                options={SAVE_OPTIONS}
                onChange={(saveKind) => {
                  if (!saving) change({ saveKind });
                }}
              />
              {form.saveKind === "project" && (
                <div className="space-y-1">
                  <label htmlFor={`${ids}-folder`} className="block text-xs text-neutral-400">
                    Folder in the project
                  </label>
                  <Input
                    id={`${ids}-folder`}
                    value={form.folder}
                    placeholder="assets/generated"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    disabled={saving}
                    aria-invalid={folderProblem !== null || undefined}
                    onChange={(event) => change({ folder: event.target.value })}
                    className="w-full max-w-sm font-mono"
                  />
                </div>
              )}
            </div>
          </SettingRow>
          <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3">
            {(saveError ?? folderProblem) && (
              <p role="alert" className="mr-auto text-xs text-danger">
                {saveError ?? folderProblem}
              </p>
            )}
            {justSaved && !dirty && (
              <span role="status" className="text-xs text-neutral-500">
                Saved
              </span>
            )}
            <Button type="button" size="sm" variant="ghost" disabled={!dirty || saving} onClick={reset}>
              Reset
            </Button>
            <Button type="submit" size="sm" disabled={!dirty || saving || folderProblem !== null}>
              {saving && <Loader2 size={13} className="animate-spin" />} Save
            </Button>
          </div>
        </form>
      </SettingsSection>

      {saved.accounts.length > 0 && <QuotaSection settings={saved} />}
    </>
  );
};

/** No Codex account: what GPT Image needs, and the way to Settings → Accounts. */
const NoAccounts: React.FC = () => {
  const openSettings = useAppStore((s) => s.openSettings);
  return (
    <EmptyState
      icon={<ImagePlus size={18} />}
      title="No ChatGPT account connected"
      description="GPT Image makes images on the ChatGPT plan behind a Codex account. Any paid ChatGPT plan works (Plus or higher); Free can't make images."
      action={
        <Button type="button" size="sm" variant="outline" onClick={() => openSettings("accounts")}>
          <Users size={13} /> Connect a ChatGPT account
        </Button>
      }
    />
  );
};

const AccountPicker: React.FC<{
  options: GptImageAccountOption[];
  value: string;
  /** The account `generate_image` would use now, or null when none can. */
  activeLabel: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
}> = ({ options, value, activeLabel, disabled, onChange }) => (
  <div role="radiogroup" aria-label="Account" className="grid max-w-xl gap-1.5">
    {options.map((option) => {
      const selected = option.value === value;
      const auto = option.value === GPT_IMAGE_AUTO_ACCOUNT;
      return (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={selected}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            "flex min-w-0 items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 disabled:cursor-not-allowed",
            selected ? "border-info/60 bg-info-soft/20" : "border-neutral-800 bg-neutral-900 enabled:hover:border-neutral-600"
          )}
        >
          <span
            aria-hidden
            className={cn(
              "mt-1 flex h-3 w-3 shrink-0 items-center justify-center rounded-full border",
              selected ? "border-info" : "border-neutral-600"
            )}
          >
            {selected && <span className="h-1.5 w-1.5 rounded-full bg-info" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-sm text-neutral-100">{option.label}</span>
              {option.plan && <Badge>{option.plan}</Badge>}
              {option.blocked && <Badge tone="warn">{BLOCK_TEXT[option.blocked]}</Badge>}
              {option.missing && <Badge tone="warn">Not connected</Badge>}
              {option.active && <Badge tone="ok">In use</Badge>}
            </span>
            {option.email && <span className="block truncate text-xs text-neutral-500">{option.email}</span>}
            {auto && (
              <span className={cn("block text-xs", activeLabel ? "text-neutral-500" : "text-warn")}>
                {activeLabel ? `Now: ${activeLabel}` : "No connected account can make images right now."}
              </span>
            )}
          </span>
        </button>
      );
    })}
  </div>
);

const TONE_VAR: Record<ReturnType<typeof usageTone>, string> = {
  ok: "var(--usage-ok)",
  med: "var(--usage-med)",
  high: "var(--usage-high)",
  crit: "var(--usage-crit)"
};

/** The account's Codex 5-hour and weekly usage, from the usage the app already holds. */
const QuotaSection: React.FC<{ settings: GptImageSettingsResponse }> = ({ settings }) => {
  const usage = useAppStore((s) => s.usage);
  const agentAccounts = useAppStore((s) => s.agentAccounts);
  const now = useNow(30_000);
  const accountId = gptImageQuotaAccountId(settings);
  const row = useMemo(
    () =>
      accountId === null
        ? null
        : accountUsageRows({ family: "codex", accounts: agentAccounts?.accounts, usage, includeSystem: false, now }).find(
            (candidate) => candidate.id === accountId
          ) ?? null,
    [accountId, agentAccounts, usage, now]
  );
  const label = settings.accounts.find((account) => account.id === accountId)?.label ?? null;

  return (
    <SettingsSection
      title="Quota"
      description="Images use your Codex limits about 3–5× faster than messages."
    >
      {label === null ? (
        <div className="px-4 py-3 text-sm text-neutral-500">No account can make images right now, so there is no quota to show.</div>
      ) : (
        <>
          <InfoRow label="Account" value={label} />
          {row === null || row.unknown ? (
            <div className="px-4 py-3 text-sm text-neutral-500">No current usage reading for this account yet.</div>
          ) : (
            <>
              <QuotaRow name="5-hour" bar={row.session} now={now} />
              <QuotaRow name="Weekly" bar={row.weekly} now={now} />
            </>
          )}
        </>
      )}
    </SettingsSection>
  );
};

const QuotaRow: React.FC<{ name: string; bar: UsageBar | null; now: number }> = ({ name, bar, now }) => {
  if (!bar) return <InfoRow label={name} value={<span className="text-neutral-500">No reading</span>} />;
  const percent = Math.max(0, Math.min(100, bar.percent));
  const reset = formatResetIn(bar.resetsAt, now);
  return (
    <div className="flex items-center gap-4 px-4 py-2.5">
      <span className="w-16 shrink-0 text-sm text-neutral-400">{name}</span>
      <span
        role="meter"
        aria-label={`${name} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-neutral-800"
      >
        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${percent}%`, background: TONE_VAR[usageTone(bar.percent)] }} />
      </span>
      <span className="shrink-0 text-right text-sm tabular-nums text-neutral-200">
        {Math.round(bar.percent)}% used
        {reset && <span className="text-neutral-500"> · resets in {reset}</span>}
      </span>
    </div>
  );
};
