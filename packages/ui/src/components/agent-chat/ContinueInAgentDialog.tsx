import React from "react";
import { ArrowRightLeft, GitFork, LoaderCircle } from "lucide-react";
import { SYSTEM_ACCOUNT_ID, type ForkSessionRequest } from "@orquester/api";
import type { ForkHandoffSummary, ModelSelection, ProviderModel } from "@orquester/api/agent-chat";

import { cn } from "../../lib/cn";
import { getRegistryIcon } from "../../icons";
import { useAppStore } from "../../store/app";
import { shortAccountLabel } from "../../lib/account-label";
import { buildChatAccountOptions } from "../../lib/agent-chat/account-switch";
import { useProviderSnapshots } from "../../lib/agent-chat/hooks";
import { providerForRefId } from "../../lib/agent-chat/providers";
import { launchModelList, resolveLaunchModel } from "../../lib/launch-models";
import {
  continueActionLabel,
  continueAgentOptions,
  continueMode,
  continueRequestFields,
  continueSummaryText,
  sourceAccountChip,
  type ContinueSource
} from "../../lib/agent-chat/continue-in.logic";
import { Button, Modal, ModalCloseButton } from "../ui";
import {
  applyModelSelection,
  applyOptionSelection,
  currentOptionValue,
  optionDescriptors,
  resolveSelectedModel
} from "./composer/composer-model";

/** Stable while a provider has published no catalogue. */
const NO_MODELS: readonly ProviderModel[] = [];

/** One choice chip: the new-chat menu's chip, as a radio. */
function ChoiceChip({
  selected,
  onSelect,
  title,
  tone = "neutral",
  children
}: {
  selected: boolean;
  onSelect: () => void;
  title?: string;
  tone?: "neutral" | "warn" | "info";
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      title={title}
      className={cn(
        "max-w-full truncate rounded px-1.5 py-0.5 text-[11px] transition-colors",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
        selected
          ? tone === "warn"
            ? "bg-warn-500/15 text-warn-300 ring-1 ring-warn-500/40"
            : tone === "info"
              ? "bg-info-500/15 text-info-300 ring-1 ring-info-500/40"
              : "bg-neutral-700 text-neutral-100 ring-1 ring-neutral-500"
          : "bg-neutral-800 text-neutral-400 ring-1 ring-transparent hover:bg-neutral-700 hover:text-neutral-200"
      )}
    >
      {children}
    </button>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  const id = React.useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1.5">
      <h3 id={id} className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </h3>
      <div role="radiogroup" aria-labelledby={id} className="flex flex-wrap gap-1">
        {children}
      </div>
    </section>
  );
}

export interface ContinueInAgentDialogProps {
  open: boolean;
  onClose: () => void;
  /** The chat being continued, as its tab and head know it. */
  source: ContinueSource & { title: string };
  /** Where the fork is cut, in words: "from this reply", "through the latest finished turn". */
  pointLabel: string;
  /** What a transcript handoff would carry, counted over this client's window; null: unknown. */
  preview: ForkHandoffSummary | null;
  /** The client's window does not hold the oldest turns. */
  moreOlder: boolean;
  /** Fork with these target fields; rejects with the daemon's refusal (said in the dialog). */
  onSubmit: (fields: Pick<ForkSessionRequest, "refId" | "accountId" | "modelSelection">) => Promise<void>;
  /** A refusal's words, as the view says them elsewhere. */
  errorText: (error: unknown) => string;
}

/**
 * "Continue in another agent…" (thread lineage, spec 2026-10-14 §6): pick the agent, model,
 * effort and account a fork runs on. The source's own agent comes first as the native fork; any
 * other agent — or another account — is a continuation, handed a budgeted transcript of this
 * chat with its first message. The summary line says what will be carried over before anything
 * is created.
 *
 * Inline chips, as the new-chat menu has them (no nested popovers inside the dialog), and the
 * composer's model maths, so a model switch drops options the new model does not take.
 */
export function ContinueInAgentDialog(props: ContinueInAgentDialogProps): React.ReactElement | null {
  if (!props.open) return null;
  return <ContinueInAgentPanel {...props} />;
}

function ContinueInAgentPanel({
  onClose,
  source,
  pointLabel,
  preview,
  moreOlder,
  onSubmit,
  errorText
}: ContinueInAgentDialogProps): React.ReactElement {
  const registry = useAppStore((state) => state.registry);
  const agentAccounts = useAppStore((state) => state.agentAccounts);
  const preferredAccountByAgent = useAppStore((state) => state.preferredAccountByAgent);
  const preferredModelByAgent = useAppStore((state) => state.preferredModelByAgent);
  const launchSelectionFor = useAppStore((state) => state.launchSelectionFor);
  const providers = useProviderSnapshots();

  const agents = React.useMemo(() => continueAgentOptions(registry.agents, source.refId), [registry.agents, source.refId]);
  const [refId, setRefId] = React.useState(source.refId);
  // Each agent keeps what was picked for it, so switching back and forth loses nothing.
  const [selections, setSelections] = React.useState<Record<string, ModelSelection>>({});
  const [accounts, setAccounts] = React.useState<Record<string, string>>({});
  const [modelQuery, setModelQuery] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const agent = agents.find((option) => option.refId === refId) ?? null;
  const sameAgent = refId === source.refId;
  const provider = providerForRefId(providers, refId);
  const catalogue = provider?.models ?? NO_MODELS;
  const defaultSelection = React.useMemo<ModelSelection | null>(() => {
    if (sameAgent && source.modelSelection) return source.modelSelection;
    const current = catalogue.filter((model) => !model.isLegacy);
    const slug = resolveLaunchModel({
      snapshot: current.length > 0 ? { models: current } : null,
      preferred: preferredModelByAgent[refId]
    });
    return slug ? launchSelectionFor(refId, slug) : null;
  }, [sameAgent, source.modelSelection, catalogue, preferredModelByAgent, refId, launchSelectionFor]);
  const selection = selections[refId] ?? defaultSelection;
  // The legacy models stay out of the chips, except the one the chat already runs on.
  const models = React.useMemo<ProviderModel[]>(
    () => catalogue.filter((model) => !model.isLegacy || model.slug === selection?.model),
    [catalogue, selection?.model]
  );
  const selectedModel = resolveSelectedModel(models, selection);
  const modelList = React.useMemo(
    () => launchModelList({ models, selected: selectedModel?.slug ?? null, query: modelQuery }),
    [models, selectedModel?.slug, modelQuery]
  );
  const descriptors = optionDescriptors(selectedModel);

  const accountOptions = React.useMemo(
    () =>
      agent?.adapter === "opencode"
        ? []
        : buildChatAccountOptions({ refId, accounts: agentAccounts?.accounts, shortLabel: shortAccountLabel }),
    [agent?.adapter, refId, agentAccounts?.accounts]
  );
  const defaultAccount = (() => {
    if (sameAgent) return sourceAccountChip(source);
    const familyDefault = (agentAccounts?.defaults as Partial<Record<string, string | null>> | undefined)?.[refId];
    const wanted = preferredAccountByAgent[refId] ?? familyDefault ?? SYSTEM_ACCOUNT_ID;
    return accountOptions.some((option) => option.id === wanted) ? wanted : SYSTEM_ACCOUNT_ID;
  })();
  const accountId = accounts[refId] ?? defaultAccount;

  const pick = { refId, modelSelection: selection, accountId };
  const mode = continueMode(source, pick, agent?.adapter ?? null);
  const targetName = agent?.name ?? refId;
  const loadingModels = mode === "handoff" && selection === null;
  const summary = continueSummaryText({ mode, targetName, preview, moreOlder });

  const setSelection = (next: ModelSelection): void => setSelections((current) => ({ ...current, [refId]: next }));

  const submit = (): void => {
    if (busy || loadingModels || agent === null) return;
    setBusy(true);
    setError(null);
    onSubmit(continueRequestFields(source, pick))
      .then(() => onClose())
      .catch((failure: unknown) => setError(errorText(failure)))
      .finally(() => setBusy(false));
  };

  return (
    <Modal open onClose={busy ? () => undefined : onClose} className="max-w-lg flex-col">
      <div
        className="flex min-h-0 w-full flex-col"
        data-continue-in-agent=""
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      >
        <header className="flex items-start justify-between gap-3 border-b border-neutral-800 px-4 py-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-1.5 text-sm font-medium text-neutral-100">
              <ArrowRightLeft size={14} strokeWidth={1.8} aria-hidden className="shrink-0 text-neutral-400" />
              Continue in another agent
            </h2>
            <p className="mt-0.5 truncate text-xs text-neutral-500" title={source.title}>
              “{source.title}”, {pointLabel}
            </p>
          </div>
          <ModalCloseButton onClose={onClose} />
        </header>

        <div className="ac-scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
          <Section label="Agent">
            {agents.length === 0 ? (
              <p className="text-xs text-neutral-500">No agent with a chat is installed.</p>
            ) : null}
            {agents.map((option) => (
              <button
                key={option.refId}
                type="button"
                role="radio"
                aria-checked={option.refId === refId}
                autoFocus={option.refId === refId}
                onClick={() => {
                  setRefId(option.refId);
                  setModelQuery("");
                  setError(null);
                }}
                className={cn(
                  "inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
                  option.refId === refId
                    ? "bg-neutral-700 text-neutral-100 ring-1 ring-neutral-500"
                    : "bg-neutral-800 text-neutral-300 ring-1 ring-transparent hover:bg-neutral-700 hover:text-neutral-100"
                )}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {getRegistryIcon("agent", option.refId, 13)}
                </span>
                <span className="truncate">{option.name}</span>
                {option.same ? (
                  <span className="shrink-0 text-[10px] text-neutral-500">
                    same agent{option.adapter === "grok" ? "" : " · native fork"}
                  </span>
                ) : null}
              </button>
            ))}
          </Section>

          <section className="flex flex-col gap-1.5" aria-label="Model">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">Model</h3>
            {models.length === 0 ? (
              <p className="flex items-center gap-1.5 text-xs text-neutral-500">
                <LoaderCircle size={12} className="animate-spin" aria-hidden />
                Loading {targetName}'s models…
              </p>
            ) : (
              <>
                {modelList.searchable ? (
                  <input
                    type="search"
                    value={modelQuery}
                    onChange={(event) => setModelQuery(event.target.value)}
                    placeholder="Search models…"
                    aria-label={`Search ${targetName} models`}
                    className="h-7 w-full rounded bg-neutral-900 px-2 text-xs text-neutral-200 outline-none ring-1 ring-neutral-700 placeholder:text-neutral-600 focus:ring-neutral-500"
                  />
                ) : null}
                <div role="radiogroup" aria-label="Model" className="flex flex-wrap gap-1">
                  {modelList.shown.map((choice) => {
                    const model = models.find((candidate) => candidate.slug === choice.slug);
                    return (
                      <ChoiceChip
                        key={choice.slug}
                        tone="warn"
                        selected={choice.slug === selectedModel?.slug}
                        title={choice.provider ? `${choice.slug} · ${choice.provider}` : choice.slug}
                        onSelect={() => model && setSelection(applyModelSelection(selection, model))}
                      >
                        {choice.label}
                      </ChoiceChip>
                    );
                  })}
                  {modelList.hidden > 0 ? (
                    <span className="px-1 py-0.5 text-[11px] text-neutral-600">…and {modelList.hidden} more</span>
                  ) : null}
                </div>
              </>
            )}
          </section>

          {descriptors.map((descriptor) =>
            descriptor.type === "select" ? (
              <Section key={descriptor.id} label={descriptor.label}>
                {descriptor.options.map((choice) => (
                  <ChoiceChip
                    key={choice.id}
                    selected={currentOptionValue(selection, descriptor) === choice.id}
                    title={choice.description}
                    onSelect={() =>
                      setSelection(applyOptionSelection(selection ?? { model: selectedModel?.slug ?? "" }, descriptor.id, choice.id))
                    }
                  >
                    {choice.label}
                  </ChoiceChip>
                ))}
              </Section>
            ) : (
              <Section key={descriptor.id} label={descriptor.label}>
                {[true, false].map((value) => (
                  <ChoiceChip
                    key={String(value)}
                    selected={(currentOptionValue(selection, descriptor) === true) === value}
                    title={descriptor.description}
                    onSelect={() =>
                      setSelection(applyOptionSelection(selection ?? { model: selectedModel?.slug ?? "" }, descriptor.id, value))
                    }
                  >
                    {value ? "On" : "Off"}
                  </ChoiceChip>
                ))}
              </Section>
            )
          )}

          {accountOptions.length > 1 ? (
            <Section label="Account">
              {accountOptions.map((option) => (
                <ChoiceChip
                  key={option.id}
                  tone="info"
                  selected={option.id === accountId}
                  title={option.needsReauth ? `${option.label} — needs to sign in again` : option.label}
                  onSelect={() => setAccounts((current) => ({ ...current, [refId]: option.id }))}
                >
                  {option.label}
                  {option.needsReauth ? " ⚠" : ""}
                </ChoiceChip>
              ))}
            </Section>
          ) : null}

          <div
            role="status"
            data-continue-summary={mode}
            className="flex items-start gap-2 rounded-md border border-neutral-800 bg-neutral-950/60 px-2.5 py-2 text-xs leading-snug text-neutral-300"
          >
            {mode === "handoff" ? (
              <ArrowRightLeft size={13} strokeWidth={1.8} aria-hidden className="mt-px shrink-0 text-neutral-500" />
            ) : (
              <GitFork size={13} strokeWidth={1.8} aria-hidden className="mt-px shrink-0 text-neutral-500" />
            )}
            <span>{summary}</span>
          </div>
          {error !== null ? (
            <p role="alert" className="text-xs text-danger-300">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-neutral-800 px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={busy || loadingModels || agent === null} aria-busy={busy || undefined}>
            {busy ? <LoaderCircle size={12} className="animate-spin" aria-hidden /> : null}
            {continueActionLabel(mode, targetName)}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}
