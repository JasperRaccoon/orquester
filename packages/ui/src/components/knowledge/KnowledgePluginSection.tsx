/**
 * Settings → Plugins → Knowledge Graph: while the plugin is on, the Activity
 * block (counts, linking state, the last run, tokens, the last error, worker
 * sessions, "Rebuild graph", "Open Knowledge"); always, the indexing
 * settings (account policy, model, concurrency), which the daemon answers whether or
 * not the plugin is on so they can be set before turning it on.
 *
 * Activity reads the knowledge store's status, which `knowledge.status` events
 * keep live; the settings are read here and saved with the settings PUT, whose
 * `{ code, message }` refusals are shown under the form. A server that predates
 * account policies (its settings carry none) gets its one-account picker
 * instead of the policy editor, so nothing is shown that it would not keep.
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AlertTriangle, Copy, Hammer, Loader2, RefreshCw, ScrollText, Waypoints } from "lucide-react";
import {
  KNOWLEDGE_CONCURRENCY_MAX,
  KNOWLEDGE_CONCURRENCY_MIN,
  type KnowledgeRebuildEstimate,
  type KnowledgeStatus,
  type KnowledgeWorkerView
} from "@orquester/api";
import type { ProviderModel } from "@orquester/api/agent-chat";

import { cn } from "../../lib/cn";
import { copyText } from "../../lib/clipboard";
import { shortAccountLabel } from "../../lib/account-label";
import { providerForRefId, providersStore, loadProviders } from "../../lib/agent-chat/providers";
import { loadKnowledgeStatus, useKnowledgeState } from "../../lib/knowledge/store";
import type { KnowledgeSettingsAnswer } from "../../lib/knowledge/validate";
import { relativeTime } from "../../lib/relative-time";
import { useAppStore } from "../../store/app";
import { Button, ConfirmDialog, Input } from "../ui";
import { InfoRow, Notice, SettingRow, SettingsSection } from "../settings/primitives";
import { conceptMergesText, knowledgeCountsText, knowledgeErrorText, linkingView } from "./knowledge.logic";
import {
  KNOWLEDGE_DEFAULT_MODEL,
  KNOWLEDGE_MODEL_INPUT_MAX,
  knowledgeAccountOptions,
  knowledgeRebuildMessage,
  knowledgeRunLine,
  knowledgeSettingsForm,
  knowledgeSettingsPatch,
  knowledgeSettingsProblem,
  knowledgeTokensText,
  knowledgeWorkersShown,
  knowledgeWorkerText,
  readKnowledgeSettings,
  type KnowledgeSettingsForm
} from "./knowledge-plugin.logic";
import { WorkerTranscriptDialog } from "./WorkerTranscriptDialog";
import { AccountPolicyEditor } from "../workflows/inspector/AccountPolicyEditor";
import { ReadOnlyFieldset } from "../workflows/ui/controls";

const SELECT_CLASS =
  "h-8 min-w-0 max-w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 text-base text-neutral-100 disabled:opacity-50 sm:text-sm";

export const KnowledgePluginSection: React.FC<{ enabled: boolean }> = ({ enabled }) => (
  <>
    {enabled && <KnowledgeActivity />}
    <KnowledgeIndexingSettings />
  </>
);

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

const KnowledgeActivity: React.FC = () => {
  const api = useAppStore((s) => s.api);
  const status = useKnowledgeState((s) => s.status);
  const statusError = useKnowledgeState((s) => s.statusError);

  // The store loads when the plugin turns on and on every connect; read again
  // on open so the block never shows a status from before a missed event.
  useEffect(() => {
    if (api) void loadKnowledgeStatus(api).catch(() => undefined);
  }, [api]);

  const openView = () => {
    const state = useAppStore.getState();
    // Settings is a modal over the view it opens.
    state.setSettingsOpen(false);
    state.openKnowledge();
  };

  return (
    <SettingsSection title="Activity">
      {status === null ? (
        statusError ? (
          <div className="px-4 py-3">
            <Notice
              tone="danger"
              title="Could not read the knowledge status"
              action={
                <Button size="sm" variant="outline" onClick={() => api && void loadKnowledgeStatus(api).catch(() => undefined)}>
                  <RefreshCw size={13} /> Retry
                </Button>
              }
            >
              {knowledgeErrorText(statusError)}
            </Notice>
          </div>
        ) : (
          <div className="flex items-center gap-2 px-4 py-3 text-sm text-neutral-500">
            <Loader2 size={13} className="animate-spin" /> Loading…
          </div>
        )
      ) : (
        <KnowledgeStatusRows status={status} />
      )}
      <div className="flex flex-wrap gap-2 px-4 py-3">
        <RebuildButton disabled={status === null || !status.installed} />
        <Button size="sm" variant="outline" onClick={openView}>
          <Waypoints size={13} /> Open Knowledge
        </Button>
      </div>
    </SettingsSection>
  );
};

const KnowledgeStatusRows: React.FC<{ status: KnowledgeStatus }> = ({ status }) => {
  const runs = status.lastRun ? [status.lastRun, ...status.recentRuns] : status.recentRuns;
  const linking = linkingView(status.linking, runs, Date.now(), status.failedEntries);
  const last = status.lastRun ? knowledgeRunLine(status.lastRun, relativeTime) : null;
  const workers = knowledgeWorkersShown(status.workers);
  const mergesText = conceptMergesText(status.conceptMerges);
  const [transcript, setTranscript] = useState<string | null>(null);
  return (
    <>
      {!status.installed && (
        <div className="px-4 py-3">
          <Notice tone="info" title="Not installed yet">
            The server downloads myKG when the plugin turns on; linking starts once it is installed.
          </Notice>
        </div>
      )}
      <InfoRow label="Knowledge" value={knowledgeCountsText(status)} />
      {mergesText !== null && <InfoRow label="Concept merges" value={<span className="tabular-nums">{mergesText}</span>} />}
      <DetailRow
        label="Linking"
        value={<span className={cn((linking.tone === "paused" || linking.tone === "failed") && "text-warn")}>{linking.label}</span>}
        detail={linking.detail}
      />
      <DetailRow
        label="Last run"
        value={
          last ? (
            <span className={cn(last.failed && "text-warn")}>
              {last.title}
              {last.when && <span className="text-neutral-500"> · {last.when}</span>}
              {last.took && <span className="text-neutral-500"> · took {last.took}</span>}
            </span>
          ) : (
            "Never"
          )
        }
        detail={last?.detail ?? null}
      />
      <InfoRow label="Tokens this week" value={<span className="tabular-nums">{knowledgeTokensText(status.tokens.week)}</span>} />
      <InfoRow label="Tokens in total" value={<span className="tabular-nums">{knowledgeTokensText(status.tokens.total)}</span>} />
      {status.lastError && (
        <div className="px-4 py-3">
          <Notice tone="warn" title={`The last error ${relativeTime(status.lastError.at)}`.trim()}>
            <span className="break-words">{status.lastError.message}</span>
          </Notice>
        </div>
      )}
      {workers.length > 0 && (
        <div className="px-4 py-2.5">
          <p className="text-sm text-neutral-400">Worker sessions</p>
          <ul aria-label="Worker sessions" className="mt-1.5 space-y-1">
            {workers.map((worker) => (
              <WorkerRow key={worker.sessionId} worker={worker} onOpenTranscript={setTranscript} />
            ))}
          </ul>
        </div>
      )}
      <WorkerTranscriptDialog sessionId={transcript} onClose={() => setTranscript(null)} />
    </>
  );
};

/** A read-only row whose value may carry a second, quieter line. */
const DetailRow: React.FC<{ label: string; value: React.ReactNode; detail: string | null }> = ({ label, value, detail }) => (
  <div className="flex items-start justify-between gap-4 px-4 py-2.5">
    <span className="shrink-0 text-sm text-neutral-400">{label}</span>
    <div className="min-w-0 text-right">
      <p className="text-sm text-neutral-200">{value}</p>
      {detail && <p className="mt-0.5 text-xs leading-relaxed tabular-nums text-neutral-500">{detail}</p>}
    </div>
  </div>
);

/**
 * One worker: its state and tasks, its account, and its transcript. A worker chat is no project's
 * tab (its "project" is the plugin's workers folder), so it is never navigated to: while its chat
 * is open its transcript opens read-only over Settings; once the daemon has closed it, only its id
 * is left, with a way to copy it (the chat's usage stays under Usage).
 */
const WorkerRow: React.FC<{ worker: KnowledgeWorkerView; onOpenTranscript: (sessionId: string) => void }> = ({ worker, onOpenTranscript }) => {
  const live = useAppStore((s) => s.sessions.some((session) => session.id === worker.sessionId));
  const account = useAppStore((s) => s.agentAccounts?.accounts.find((a) => a.id === worker.accountId)?.label);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void copyText(worker.sessionId).then(setCopied);
  };
  return (
    <li data-knowledge-worker={worker.sessionId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-neutral-400">
      <span className={cn(worker.state === "failed" ? "text-warn" : worker.state === "running" ? "text-neutral-200" : null)}>
        {knowledgeWorkerText(worker)}
      </span>
      <span className="text-neutral-600">·</span>
      <span>{shortAccountLabel(account) || worker.accountId}</span>
      {relativeTime(worker.startedAt) && <span className="text-neutral-500">· {relativeTime(worker.startedAt)}</span>}
      <span className="flex-1" />
      {live ? (
        <button
          type="button"
          onClick={() => onOpenTranscript(worker.sessionId)}
          aria-label={`Open the transcript of worker ${worker.sessionId}`}
          className="inline-flex items-center gap-1 text-info-300 underline-offset-2 hover:underline"
        >
          <ScrollText size={11} /> Transcript
        </button>
      ) : (
        <span className="inline-flex items-center gap-1.5">
          <code title="This worker chat has closed" className="select-all font-mono text-[11px] text-neutral-500">
            {worker.sessionId}
          </code>
          <button
            type="button"
            onClick={copy}
            aria-label={`Copy the session id of worker ${worker.sessionId}`}
            title={copied ? "Copied" : "Copy session id"}
            className="inline-flex items-center text-neutral-500 hover:text-neutral-200"
          >
            <Copy size={11} />
          </button>
        </span>
      )}
    </li>
  );
};

/** "Rebuild graph": the estimate in a confirmation (information only), then the POST. */
const RebuildButton: React.FC<{ disabled: boolean }> = ({ disabled }) => {
  const api = useAppStore((s) => s.api);
  const [confirming, setConfirming] = useState(false);
  const [estimate, setEstimate] = useState<KnowledgeRebuildEstimate | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumped per confirmation: an estimate an earlier one asked for is dropped. */
  const asked = useRef(0);

  const ask = () => {
    if (!api) return;
    const mine = ++asked.current;
    setConfirming(true);
    setEstimate(null);
    setEstimateError(null);
    setError(null);
    api.getKnowledgeRebuildEstimate().then(
      (answer) => {
        if (asked.current === mine) setEstimate(answer);
      },
      (err: unknown) => {
        if (asked.current === mine) setEstimateError(knowledgeErrorText(err));
      }
    );
  };

  const rebuild = async () => {
    setConfirming(false);
    if (!api) return;
    setBusy(true);
    try {
      await api.rebuildKnowledge();
    } catch (err) {
      setError(knowledgeErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button size="sm" variant="outline" disabled={disabled || busy || !api} onClick={ask}>
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Hammer size={13} />} Rebuild graph
      </Button>
      {error && (
        <p role="alert" className="flex w-full items-start gap-1.5 text-xs text-danger">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {error}
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        title="Rebuild the knowledge graph?"
        message={knowledgeRebuildMessage(estimate, estimateError)}
        confirmLabel="Rebuild"
        danger={false}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void rebuild()}
      />
    </>
  );
};

// ---------------------------------------------------------------------------
// Indexing settings
// ---------------------------------------------------------------------------

/** Claude's current models, when this client has read the provider catalogue (suggestions and scoped limits only). */
function useClaudeModels(): ProviderModel[] {
  const api = useAppStore((s) => s.api);
  useEffect(() => {
    const transport = api?.agentChat;
    if (transport) void loadProviders(transport);
  }, [api]);
  const providers = useSyncExternalStore(
    providersStore.subscribe,
    () => providersStore.getState().providers,
    () => providersStore.getState().providers
  );
  return useMemo(
    () => (providerForRefId(providers, "claude")?.models ?? []).filter((m) => m.isLegacy !== true),
    [providers]
  );
}

const KnowledgeIndexingSettings: React.FC = () => {
  const ids = useId();
  const api = useAppStore((s) => s.api);
  const models = useClaudeModels();
  const accounts = useAppStore((s) => s.agentAccounts?.accounts);

  const [saved, setSaved] = useState<KnowledgeSettingsAnswer | null>(null);
  const [form, setForm] = useState<KnowledgeSettingsForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const load = useCallback(() => {
    if (!api) return;
    setLoadError(null);
    api.getKnowledgeSettings().then(
      (answer) => {
        if (useAppStore.getState().api !== api) return;
        const settings = readKnowledgeSettings(answer);
        setSaved(settings);
        setForm(knowledgeSettingsForm(settings));
      },
      (err: unknown) => {
        if (useAppStore.getState().api === api) setLoadError(knowledgeErrorText(err));
      }
    );
  }, [api]);

  useEffect(load, [load]);

  const options = useMemo(() => knowledgeAccountOptions(accounts, form?.accountId ?? null), [accounts, form?.accountId]);

  if (form === null || saved === null) {
    return (
      <SettingsSection title="Indexing">
        {loadError ? (
          <div className="px-4 py-3">
            <Notice
              tone="danger"
              title="Could not read the indexing settings"
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

  const change = (patch: Partial<KnowledgeSettingsForm>) => {
    setForm({ ...form, ...patch });
    setSaveError(null);
    setJustSaved(false);
  };
  const { accountPolicy } = form;
  const problem = knowledgeSettingsProblem(form);
  const result = knowledgeSettingsPatch(saved, form);
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
      const answer = readKnowledgeSettings(await api.updateKnowledgeSettings(result.patch));
      if (useAppStore.getState().api !== api) return;
      setSaved(answer);
      setForm(knowledgeSettingsForm(answer));
      setJustSaved(true);
    } catch (err) {
      if (useAppStore.getState().api === api) setSaveError(knowledgeErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title="Indexing">
      <form aria-label="Knowledge indexing settings" className="divide-y divide-neutral-800/80" onSubmit={(event) => void save(event)}>
        {accountPolicy === null ? (
          <SettingRow
            label="Indexing account"
            htmlFor={`${ids}-account`}
            description="The Claude account whose sessions link new entries into the graph. Automatic uses the first one that can run, and moves on when one reaches its usage limit. This server only supports choosing the one account it tries first; update the server to choose accounts by policy."
          >
            <select
              id={`${ids}-account`}
              className={SELECT_CLASS}
              disabled={saving}
              value={form.accountId ?? ""}
              onChange={(event) => change({ accountId: event.target.value === "" ? null : event.target.value })}
            >
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </SettingRow>
        ) : (
          <SettingRow
            stacked
            label="Indexing accounts"
            description="Which Claude accounts the indexing sessions use, chosen like a workflow Agent block: the one with the most quota left, the one whose quota resets soonest, or a fixed order. When one can't run, the next one takes over; when none can, indexing pauses until the earliest reset."
          >
            <ReadOnlyFieldset readOnly={saving} className="min-w-0 max-w-2xl">
              <AccountPolicyEditor
                family="claude"
                agentLabel="Claude"
                policy={accountPolicy}
                onChange={(next) => change({ accountPolicy: next })}
                model={form.model.trim() || KNOWLEDGE_DEFAULT_MODEL}
                models={models}
                anchor="accountPolicy"
              />
            </ReadOnlyFieldset>
          </SettingRow>
        )}
        <SettingRow label="Indexing model" htmlFor={`${ids}-model`} description="The model the indexing sessions use. Leave it empty for the default.">
          <Input
            id={`${ids}-model`}
            value={form.model}
            maxLength={KNOWLEDGE_MODEL_INPUT_MAX}
            placeholder="Default (Sonnet)"
            list={models.length > 0 ? `${ids}-models` : undefined}
            disabled={saving}
            onChange={(event) => change({ model: event.target.value })}
            className="w-48"
          />
          {models.length > 0 && (
            <datalist id={`${ids}-models`}>
              {models.map((m) => (
                <option key={m.slug} value={m.slug} />
              ))}
            </datalist>
          )}
        </SettingRow>
        <SettingRow
          label="Concurrency"
          htmlFor={`${ids}-concurrency`}
          description={`Indexing sessions at once, ${KNOWLEDGE_CONCURRENCY_MIN} to ${KNOWLEDGE_CONCURRENCY_MAX}. More finishes a run sooner and uses the account's limits faster.`}
        >
          <Input
            id={`${ids}-concurrency`}
            type="number"
            inputMode="numeric"
            min={KNOWLEDGE_CONCURRENCY_MIN}
            max={KNOWLEDGE_CONCURRENCY_MAX}
            step={1}
            value={form.concurrency}
            disabled={saving}
            aria-invalid={problem !== null || undefined}
            onChange={(event) => change({ concurrency: event.target.value })}
            className="w-20"
          />
        </SettingRow>
        <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3">
          {(saveError ?? problem) && (
            <p role="alert" className="mr-auto text-xs text-danger">
              {saveError ?? problem}
            </p>
          )}
          {justSaved && !dirty && (
            <span role="status" className="text-xs text-neutral-500">
              Saved
            </span>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!dirty || saving}
            onClick={() => {
              setForm(knowledgeSettingsForm(saved));
              setSaveError(null);
            }}
          >
            Reset
          </Button>
          <Button type="submit" size="sm" disabled={!dirty || saving || problem !== null}>
            {saving && <Loader2 size={13} className="animate-spin" />} Save
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
};
