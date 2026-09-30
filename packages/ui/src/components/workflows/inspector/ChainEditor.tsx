/**
 * An agent block's choices (workflows spec §5.1): the agents it may run, in
 * the order the engine falls back across them on usage limits. Each choice is
 * a collapsible card — one line when closed ("Claude · Opus · High effort —
 * Most quota left · skip at 85% weekly"), the first open, any with a problem
 * opening itself — that picks an agent (registry agents with a chat adapter),
 * a model and its options (effort…) from the live provider catalogue (the
 * composer's pure helpers), and the account policy. Cards reorder by dragging
 * the grip or with the arrows. "Who would run now?" asks the daemon to run the
 * selection against live usage and says who it picked and why every other
 * account was passed over — in words, and marked out of date once the choices
 * change.
 *
 * Model matching is exact, as validation and the engine match it: a stored
 * slug the catalogue doesn't list stays selected as "(unavailable)" with the
 * reason under it; options no visible control shows are listed, not dropped.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CheckCircle2, ChevronDown, ChevronRight, CircleSlash, GripVertical, Loader2, Plus, Trash2, UserSearch } from "lucide-react";

import {
  WORKFLOW_LIMITS,
  type AccountPolicy,
  type AccountSelectionDecision,
  type AgentChainEntry,
  type WorkflowProblem
} from "@orquester/api";
import type { ProviderModel, ProviderOptionDescriptor, ProviderSnapshot } from "@orquester/api/agent-chat";

import { useApi } from "../../../context/orquester-context";
import { cn } from "../../../lib/cn";
import { useProviderSnapshots } from "../../../lib/agent-chat/hooks";
import { providerForRefId } from "../../../lib/agent-chat/providers";
import { accountName, choiceLine, decisionReasonText, policySummary, skipLine, type DecisionNames } from "../../../lib/workflows/agent-policy-text";
import { defaultAgentLabel, defaultModelLabel } from "../../../lib/workflows/catalog-ui";
import { accountFamily } from "../../../lib/workflows/inspector-usage";
import { useAppStore } from "../../../store/app";
import { currentOptionValue, findReasoningDescriptor, optionDescriptors, resolveSelectedModel } from "../../agent-chat/composer/composer-model";
import { Field, IconButton, ProblemBadge, SelectInput, SmallButton, TextInput, ToggleRow, ViewButton } from "../ui/controls";
import { AccountPolicyEditor, allowedCounts, useManagedAccounts } from "./AccountPolicyEditor";
import { countProblems, FieldAnchor, problemsAt, useInspector, useRevealOpen } from "./inspector-context";

const DEFAULT_POLICY: AccountPolicy = {
  strategy: "least-used",
  includeSystem: false,
  soonestResetWindow: "weekly",
  leastUsedMetric: "max",
  unknownUsage: "last"
};

interface AgentChoice {
  id: string;
  label: string;
  installed: boolean;
}

/** Registry agents that can run in a chat (the only kind a workflow can drive). */
function useChatAgents(): AgentChoice[] {
  const agents = useAppStore((state) => state.registry.agents);
  return useMemo(
    () =>
      agents
        .filter((agent) => agent.chat !== undefined)
        .map((agent) => ({ id: agent.id, label: agent.name || defaultAgentLabel(agent.id), installed: agent.enabled })),
    [agents]
  );
}

/** The models an entry can pick: the provider's catalogue. */
function modelsFor(agent: string, providers: readonly ProviderSnapshot[]): ProviderModel[] {
  return providerForRefId(providers, agent)?.models ?? [];
}

/** Whether the provider's models are its own (probed), not the fallback list a pending snapshot carries. */
function modelsLoaded(agent: string, providers: readonly ProviderSnapshot[]): boolean {
  const provider = providerForRefId(providers, agent);
  return provider !== null && provider.status !== "unknown" && provider.models.length > 0;
}

const stripName = (message: string): string => message.replace(/^[A-Za-z][A-Za-z0-9_]*: /, "");

/** The problems on exactly `field` (not under it). */
function problemsOn(problems: readonly WorkflowProblem[], field: string): WorkflowProblem[] {
  return problems.filter((problem) => problem.field === field);
}

/** A model's name for a select or a summary: its short name, else its name. */
const modelName = (model: ProviderModel): string => model.shortName ?? model.name;

/** "High effort", "Fast mode" — the options set on an entry, as words (defaults are not repeated). */
function optionsText(entry: AgentChainEntry, descriptors: readonly ProviderOptionDescriptor[]): string {
  const parts: string[] = [];
  for (const option of entry.options ?? []) {
    const descriptor = descriptors.find((candidate) => candidate.id === option.id);
    if (!descriptor) continue;
    if (descriptor.type === "boolean") {
      if (option.value === true) parts.push(descriptor.label);
      continue;
    }
    const choice = descriptor.options.find((candidate) => candidate.id === option.value);
    if (choice) parts.push(`${choice.label} ${descriptor.label.toLowerCase()}`);
  }
  return parts.join(" · ");
}

/**
 * The stored options no control on the card shows, and whether the engine
 * refuses the entry for them (then it passes the whole choice over). The
 * engine's rule (daemon `resolveModelSelection`): a listed model without
 * option descriptors takes none; with descriptors, every option must be one
 * of them, a select's value one of its choices (by id or label), a boolean a
 * boolean — `effort` standing for the model's reasoning option when it has no
 * `effort`. A model the catalogue doesn't list, or no catalogue: unchecked.
 */
function strayOptions(
  entry: AgentChainEntry,
  model: ProviderModel | null,
  shown: readonly ProviderOptionDescriptor[]
): { options: { id: string; label: string; value: string }[]; refused: boolean } {
  const all = optionDescriptors(model);
  const out: { id: string; label: string; value: string }[] = [];
  let refused = false;
  for (const option of entry.options ?? []) {
    const descriptor =
      all.find((candidate) => candidate.id === option.id) ??
      (option.id === "effort" && !all.some((candidate) => candidate.id === "effort") ? (findReasoningDescriptor(model) ?? undefined) : undefined);
    const accepted =
      descriptor !== undefined &&
      (descriptor.type === "boolean"
        ? typeof option.value === "boolean"
        : descriptor.options.some((choice) => choice.id === option.value || choice.label.toLowerCase() === String(option.value).toLowerCase()));
    const visible = accepted && shown.some((candidate) => candidate.id === option.id) && (descriptor!.type === "boolean" || descriptor!.options.some((choice) => choice.id === option.value));
    if (visible) continue;
    if (model !== null && !accepted) refused = true;
    const value = typeof option.value === "boolean" ? (option.value ? "on" : "off") : option.value;
    out.push({ id: option.id, label: descriptor?.label ?? option.id, value });
  }
  return { options: out, refused };
}

/** Card ids fitted to `length` entries: kept by position, new ones minted. */
function fitCardIds(ids: readonly number[], length: number, mint: () => number): number[] {
  return ids.length === length ? [...ids] : Array.from({ length }, (_, i) => ids[i] ?? mint());
}

/** `ids` with the one at `from` moved to `to` — the same splice the entries get. */
function movedCardIds(ids: readonly number[], from: number, to: number): number[] {
  const next = [...ids];
  const [id] = next.splice(from, 1);
  next.splice(to, 0, id!);
  return next;
}

const ChainCard: React.FC<{
  /** The card's client id (stable across reorders; `data-chain-card`). */
  cardId: number;
  entry: AgentChainEntry;
  index: number;
  count: number;
  agents: AgentChoice[];
  providers: readonly ProviderSnapshot[];
  onChange: (entry: AgentChainEntry) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
  dragProps: React.HTMLAttributes<HTMLDivElement>;
  onGripDragStart: (event: React.DragEvent) => void;
  dropTarget: boolean;
}> = ({ cardId, entry, index, count, agents, providers, onChange, onMove, onRemove, dragProps, onGripDragStart, dropTarget }) => {
  const { problems } = useInspector();
  const base = `config.chain.${index}`;
  const [open, setOpen] = useRevealOpen([base], index === 0);
  const [accountsOpen, setAccountsOpen] = useRevealOpen([`${base}.accounts`], true);
  const counts = countProblems(problems, [base]);

  const models = modelsFor(entry.agent, providers);
  const loaded = modelsLoaded(entry.agent, providers);
  const exactModel = models.find((model) => model.slug === entry.model) ?? null;
  const descriptors = optionDescriptors(exactModel).filter(
    // OpenCode's `agent` option is never set by a workflow (spec §5.1 step 3).
    (descriptor) => !(entry.agent === "opencode" && descriptor.id === "agent")
  );
  const stray = strayOptions(entry, exactModel, descriptors);
  const family = accountFamily(entry.agent);
  const agentKnown = agents.some((agent) => agent.id === entry.agent);
  const agentLabel = agents.find((agent) => agent.id === entry.agent)?.label ?? defaultAgentLabel(entry.agent);
  const modelLabel = exactModel ? modelName(exactModel) : defaultModelLabel(entry.model);
  const selection = { model: entry.model, ...(entry.options ? { options: entry.options } : {}) };
  const policy = entry.accounts ?? DEFAULT_POLICY;
  const { accounts: managed, loaded: accountsLoaded } = useManagedAccounts(family ?? "");

  const setOption = (id: string, value: string | boolean): void => {
    const options = (entry.options ?? []).filter((option) => option.id !== id);
    onChange({ ...entry, options: [...options, { id, value }] });
  };
  const clearStray = (): void => {
    const strays = new Set(stray.options.map((option) => option.id));
    const keep = (entry.options ?? []).filter((option) => !strays.has(option.id));
    onChange({ ...entry, options: keep.length > 0 ? keep : undefined });
  };

  // The model's messages, in words: the catalogue ones this card can say better.
  const modelProblems = problemsOn(problems, `${base}.model`);
  const unknownModel = modelProblems.find((problem) => problem.code === "unknown_model");
  const unavailable = loaded && exactModel === null;
  const unavailableText = `${agentLabel} on this machine doesn't offer “${entry.model}”. Runs skip this choice until you pick a listed model.`;
  const notCheckedText = `${agentLabel}'s models haven't loaded yet, so “${entry.model}” can't be checked.`;
  let modelError: string | null = null;
  let modelWarning: string | null = null;
  for (const problem of modelProblems) {
    const text = problem.code === "unknown_model" ? (problem.severity === "error" ? unavailableText : notCheckedText) : stripName(problem.message);
    if (problem.severity === "error") modelError ??= text;
    else if (problem.severity === "warning") modelWarning ??= text;
  }
  // The agent's messages, in words.
  const agentMessages: { error: string | null; warning: string | null } = { error: null, warning: null };
  for (const problem of problemsOn(problems, `${base}.agent`)) {
    const text =
      problem.code === "unknown_agent"
        ? problem.severity === "error"
          ? `“${entry.agent}” isn't a chat agent on this machine. Runs skip this choice until you pick one that is.`
          : `${agentLabel} isn't available on this machine right now, so runs skip this choice.`
        : stripName(problem.message);
    if (problem.severity === "error") agentMessages.error ??= text;
    else if (problem.severity === "warning") agentMessages.warning ??= text;
  }
  // No catalogue in the editor's validation yet: say it here anyway.
  if (unknownModel === undefined && unavailable && models.length > 0) modelWarning ??= unavailableText;

  const summary = [
    [agentLabel, modelLabel + (unavailable ? " (unavailable)" : ""), optionsText(entry, descriptors)].filter(Boolean).join(" · "),
    family
      ? policySummary(policy, { model: entry.model, ...(accountsLoaded ? { accounts: allowedCounts(policy, managed) } : {}) })
      : "runs on the daemon's own sign-in"
  ].join(" — ");

  // Other problems on the entry (its options, a schema issue), each once.
  const cardProblems = problemsAt(problems, base).filter(
    (problem) =>
      !problem.field!.startsWith(`${base}.agent`) && !problem.field!.startsWith(`${base}.model`) && !problem.field!.startsWith(`${base}.accounts`)
  );
  const title = index === 0 ? "First choice" : `Fallback ${index}`;

  return (
    <div
      {...dragProps}
      data-chain-card={cardId}
      className={cn(
        "rounded-xl border bg-neutral-900/70 transition-colors",
        dropTarget ? "border-neutral-400" : counts.errors > 0 ? "border-danger/50" : "border-neutral-800"
      )}
    >
      <div className={cn("flex items-start gap-1.5 py-1.5 pl-1.5 pr-1", open && "border-b border-neutral-800/80")}>
        <span
          draggable
          onDragStart={onGripDragStart}
          className="mt-[3px] cursor-grab rounded text-neutral-600 hover:text-neutral-300 active:cursor-grabbing [.wf-touch_&]:hidden"
          title="Drag to reorder"
          aria-hidden
        >
          <GripVertical size={14} />
        </span>
        <ViewButton
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-start gap-1.5 rounded text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 [.wf-touch_&]:min-h-9"
        >
          <span className="mt-[1px] flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md bg-neutral-800 px-1 text-[10.5px] font-semibold tabular-nums text-neutral-300">
            {index + 1}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-h-5 items-center gap-1 text-xs font-medium text-neutral-200">
              {open ? <ChevronDown size={13} className="shrink-0 text-neutral-500" /> : <ChevronRight size={13} className="shrink-0 text-neutral-500" />}
              {title}
            </span>
            {!open ? <span className="block pb-0.5 pl-[17px] text-[11.5px] leading-4 text-neutral-500">{summary}</span> : null}
          </span>
        </ViewButton>
        <ProblemBadge problems={counts} className="mt-[3px]" />
        <span className="flex shrink-0 items-center">
          <IconButton size="sm" label={`Move ${title.toLowerCase()} up`} data-chain-move="up" disabled={index === 0} onClick={() => onMove(-1)} className="[.wf-touch_&]:h-9 [.wf-touch_&]:w-9">
            <ArrowUp size={12} />
          </IconButton>
          <IconButton size="sm" label={`Move ${title.toLowerCase()} down`} data-chain-move="down" disabled={index === count - 1} onClick={() => onMove(1)} className="[.wf-touch_&]:h-9 [.wf-touch_&]:w-9">
            <ArrowDown size={12} />
          </IconButton>
          <IconButton
            size="sm"
            label={count === 1 ? "An agent block needs at least one choice" : `Remove ${title.toLowerCase()}`}
            tone="danger"
            disabled={count === 1}
            onClick={onRemove}
            className="[.wf-touch_&]:h-9 [.wf-touch_&]:w-9"
          >
            <Trash2 size={12} />
          </IconButton>
        </span>
      </div>
      {open ? (
        <div className="space-y-3 p-3">
          <FieldAnchor field={`${base}.agent`}>
            <Field label="Agent" error={agentMessages.error} warning={agentMessages.warning}>
              <SelectInput
                value={entry.agent}
                onValue={(agent) => {
                  const nextModels = modelsFor(agent, providers).filter((model) => model.isLegacy !== true);
                  const model = resolveSelectedModel(nextModels, null)?.slug ?? entry.model;
                  // Another family's account ids mean nothing here: the allow-list starts over.
                  const sameFamily = accountFamily(agent) === accountFamily(entry.agent);
                  // Options belong to the model; anything else on the entry is kept.
                  const { options: _options, ...rest } = entry;
                  onChange({ ...rest, agent, model, accounts: sameFamily ? policy : { ...policy, accounts: undefined } });
                }}
              >
                {!agentKnown ? <option value={entry.agent}>{defaultAgentLabel(entry.agent)} (not on this machine)</option> : null}
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.label}
                    {agent.installed ? "" : " (not installed)"}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </FieldAnchor>

          <FieldAnchor field={`${base}.model`}>
            <Field
              label="Model"
              error={modelError}
              warning={modelWarning}
              hint={
                exactModel ? (
                  <>
                    {exactModel.name !== modelName(exactModel) ? `${exactModel.name} · ` : null}
                    <code className="text-neutral-400">{exactModel.slug}</code>
                    {exactModel.subProvider ? ` · via ${exactModel.subProvider}` : null}
                  </>
                ) : models.length === 0 ? (
                  `${agentLabel}'s models haven't loaded. Type the model's id exactly as the agent knows it.`
                ) : null
              }
            >
              {models.length > 0 ? (
                <SelectInput
                  value={entry.model}
                  onValue={(model) => {
                    const picked = models.find((candidate) => candidate.slug === model);
                    const keep = (entry.options ?? []).filter((option) =>
                      optionDescriptors(picked ?? null).some((descriptor) => descriptor.id === option.id)
                    );
                    onChange({ ...entry, model, ...(keep.length > 0 ? { options: keep } : { options: undefined }) });
                  }}
                >
                  {!exactModel ? (
                    <option value={entry.model}>
                      {entry.model} ({loaded ? "unavailable" : "not checked yet"})
                    </option>
                  ) : null}
                  {models.map((model) => (
                    <option key={model.slug} value={model.slug}>
                      {modelName(model)}
                      {model.isDefault ? " (default)" : ""}
                      {model.isLegacy ? " (older)" : ""}
                    </option>
                  ))}
                </SelectInput>
              ) : (
                <TextInput value={entry.model} onValue={(model) => onChange({ ...entry, model })} placeholder="Model id" invalid={modelError !== null} />
              )}
            </Field>
          </FieldAnchor>

          {descriptors.length > 0 ? (
            <FieldAnchor field={`${base}.options`} className="grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-x-2 gap-y-3">
              {descriptors.map((descriptor) => {
                if (descriptor.type !== "select") {
                  return (
                    <div key={descriptor.id} className="col-span-full">
                      <ToggleRow
                        checked={currentOptionValue(selection, descriptor) === true}
                        onChange={(value) => setOption(descriptor.id, value)}
                        label={descriptor.label}
                        {...(descriptor.description ? { description: descriptor.description } : {})}
                      />
                    </div>
                  );
                }
                const current = String(currentOptionValue(selection, descriptor) ?? "");
                const choice = descriptor.options.find((candidate) => candidate.id === current);
                return (
                  <Field key={descriptor.id} label={descriptor.label} help={descriptor.description} hint={choice?.description}>
                    <SelectInput value={current} onValue={(value) => setOption(descriptor.id, value)}>
                      {choice ? null : <option value={current}>{current || "Default"}</option>}
                      {descriptor.options.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                          {option.isDefault ? " (default)" : ""}
                        </option>
                      ))}
                    </SelectInput>
                  </Field>
                );
              })}
            </FieldAnchor>
          ) : null}

          {stray.options.length > 0 ? (
            <div className="space-y-1.5 rounded-lg border border-neutral-800 px-2.5 py-2" data-chain-stray-options="">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-neutral-400">{descriptors.length > 0 ? "Other options set" : "Options set"}</span>
                <SmallButton variant="ghost" className="h-6 px-1.5 [.wf-touch_&]:h-9" onClick={clearStray}>
                  Clear
                </SmallButton>
              </div>
              <ul className="space-y-0.5 text-[11.5px] leading-4 text-neutral-300">
                {stray.options.map((option) => (
                  <li key={option.id}>
                    {option.label}: <code className="text-neutral-400">{option.value}</code>
                  </li>
                ))}
              </ul>
              <p className={cn("text-[11px] leading-4", stray.refused ? "text-warn" : "text-neutral-500")}>
                {stray.refused
                  ? `${modelLabel} doesn't take ${stray.options.length === 1 ? "this option" : "these options"}: runs skip this choice until you clear ${stray.options.length === 1 ? "it" : "them"}.`
                  : exactModel
                    ? "Sent as they are; this form has no control for them."
                    : models.length === 0
                      ? "Sent as they are: there is nothing to check them against until the models load."
                      : "Kept with the model above. Pick a listed model to set its options here."}
              </p>
            </div>
          ) : null}

          {cardProblems.map((problem, at) => (
            <p key={at} className={cn("text-[11px] leading-4", problem.severity === "error" ? "text-danger" : "text-warn")}>
              {stripName(problem.message)}
            </p>
          ))}

          {family ? (
            <FieldAnchor field={`${base}.accounts`} className="rounded-lg border border-neutral-800/80 bg-neutral-950/40">
              <ViewButton
                aria-expanded={accountsOpen}
                onClick={() => setAccountsOpen(!accountsOpen)}
                className="flex w-full items-start gap-1.5 rounded-lg px-2.5 py-2 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 [.wf-touch_&]:min-h-10"
              >
                {accountsOpen ? <ChevronDown size={13} className="mt-px shrink-0 text-neutral-500" /> : <ChevronRight size={13} className="mt-px shrink-0 text-neutral-500" />}
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-neutral-300">Accounts</span>
                  {!accountsOpen ? (
                    <span className="block text-[11px] leading-4 text-neutral-500">
                      {policySummary(policy, { model: entry.model, ...(accountsLoaded ? { accounts: allowedCounts(policy, managed) } : {}) })}
                    </span>
                  ) : null}
                </span>
                <ProblemBadge problems={countProblems(problems, [`${base}.accounts`])} className="ml-auto" />
              </ViewButton>
              {accountsOpen ? (
                <div className="border-t border-neutral-800/80 p-2.5">
                  <AccountPolicyEditor
                    family={family}
                    agentLabel={agentLabel}
                    model={entry.model}
                    models={models}
                    anchor={`${base}.accounts`}
                    policy={policy}
                    onChange={(accounts) => onChange({ ...entry, accounts })}
                  />
                </div>
              ) : null}
            </FieldAnchor>
          ) : (
            <p className="text-[11px] leading-4 text-neutral-500">{agentLabel} has no accounts to pick: it always runs on the daemon's own sign-in.</p>
          )}
        </div>
      ) : null}
    </div>
  );
};

type Preview =
  | { state: "idle" }
  | { state: "loading"; key: string }
  | { state: "done"; key: string; decision: AccountSelectionDecision; at: number }
  | { state: "error"; key: string; message: string };

/** The names the decision texts use: registry, catalogue and account labels. */
function useDecisionNames(agents: readonly AgentChoice[], providers: readonly ProviderSnapshot[]): DecisionNames {
  const agentAccounts = useAppStore((state) => state.agentAccounts);
  return useMemo(
    () => ({
      agent: (id) => agents.find((agent) => agent.id === id)?.label ?? defaultAgentLabel(id),
      account: (_agent, id, label) => {
        const account = agentAccounts?.accounts.find((candidate) => candidate.id === id);
        return accountName(id, label, account ? account.label || account.email || undefined : undefined);
      },
      model: (agent, slug) => {
        const model = modelsFor(agent, providers).find((candidate) => candidate.slug === slug);
        return model ? modelName(model) : defaultModelLabel(slug);
      }
    }),
    [agents, providers, agentAccounts]
  );
}

const DecisionView: React.FC<{
  decision: AccountSelectionDecision;
  names: DecisionNames;
  now: number;
  stale: boolean;
  onRefresh: () => void;
}> = ({ decision, names, now, stale, onRefresh }) => (
  <div className={cn("space-y-2 rounded-lg border border-neutral-800 bg-neutral-950/50 p-2.5 text-[12px]", stale && "opacity-70")} data-chain-decision="">
    {stale ? (
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-warn">
        <span>Out of date: the choices changed since this check.</span>
        <SmallButton variant="ghost" className="h-6 px-1.5 [.wf-touch_&]:h-9" onClick={onRefresh}>
          Check again
        </SmallButton>
      </div>
    ) : null}
    {decision.chosen ? (
      <div className="flex items-start gap-2">
        <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-ok" />
        <div className="min-w-0">
          <div className="font-medium text-neutral-100">{choiceLine(decision.chosen, names)}</div>
          <div className="text-[11px] leading-4 text-neutral-500" title={decision.reason}>
            {decisionReasonText(decision, names, now)}
          </div>
        </div>
      </div>
    ) : (
      <div className="flex items-start gap-2">
        <CircleSlash size={14} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0">
          <div className="font-medium text-danger">Nobody could run it right now</div>
          <div className="text-[11px] leading-4 text-neutral-500" title={decision.reason}>
            {decisionReasonText(decision, names, now)}
          </div>
        </div>
      </div>
    )}
    {decision.skipped.length > 0 ? (
      <div className="space-y-1 border-t border-neutral-800 pt-2">
        <div className="text-[11px] font-medium text-neutral-400">Passed over</div>
        <ul className="space-y-1">
          {decision.skipped.map((skip, index) => {
            const line = skipLine(skip, names);
            return (
              <li key={`${skip.agent}:${skip.accountId}:${index}`} className="text-[11px] leading-4 text-neutral-500" title={skip.detail}>
                <span className="text-neutral-300">{line.who}</span>: {line.text}
              </li>
            );
          })}
        </ul>
      </div>
    ) : null}
  </div>
);

export const ChainEditor: React.FC<{
  chain: readonly AgentChainEntry[];
  onChange: (chain: AgentChainEntry[]) => void;
  projectPath: string;
}> = ({ chain, onChange, projectPath }) => {
  const api = useApi();
  const { problems, readOnly } = useInspector();
  const agents = useChatAgents();
  const providers = useProviderSnapshots();
  const names = useDecisionNames(agents, providers);
  // A client id per entry, moved with it, so a card's open state and focus follow the entry rather
  // than its slot. A change from elsewhere (undo, another editor) that alters the length re-fits the
  // list by position.
  const nextId = useRef(0);
  const ids = useRef<number[]>([]);
  if (ids.current.length !== chain.length) ids.current = fitCardIds(ids.current, chain.length, () => ++nextId.current);
  const listRef = useRef<HTMLDivElement | null>(null);
  const focusAfterMove = useRef<{ id: number; delta: number } | null>(null);
  useEffect(() => {
    const request = focusAfterMove.current;
    if (!request) return;
    focusAfterMove.current = null;
    // Reordering moves the card's element, which drops focus: put it back on the arrow used, or the
    // other one when that one is now disabled (the card reached an end).
    const card = listRef.current?.querySelector(`[data-chain-card="${request.id}"]`);
    const used = card?.querySelector<HTMLButtonElement>(`[data-chain-move="${request.delta < 0 ? "up" : "down"}"]`);
    const other = card?.querySelector<HTMLButtonElement>(`[data-chain-move="${request.delta < 0 ? "down" : "up"}"]`);
    (used && !used.disabled ? used : other)?.focus();
  }, [chain]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [preview, setPreview] = useState<Preview>({ state: "idle" });
  const chainKey = JSON.stringify(chain);

  const move = (from: number, to: number): void => {
    if (readOnly || to < 0 || to >= chain.length || from === to) return;
    const next = [...chain];
    const [entry] = next.splice(from, 1);
    next.splice(to, 0, entry!);
    ids.current = movedCardIds(ids.current, from, to);
    onChange(next);
  };

  const remove = (index: number): void => {
    if (readOnly) return;
    ids.current.splice(index, 1);
    onChange(chain.filter((_, i) => i !== index));
  };

  const add = (): void => {
    const used = new Set(chain.map((entry) => entry.agent));
    const agent = agents.find((candidate) => !used.has(candidate.id) && candidate.installed) ?? agents[0];
    const id = agent?.id ?? "codex";
    const current = modelsFor(id, providers).filter((model) => model.isLegacy !== true);
    const model = resolveSelectedModel(current, null)?.slug ?? "default";
    if (readOnly) return;
    ids.current.push(++nextId.current);
    onChange([...chain, { agent: id, model, accounts: { ...DEFAULT_POLICY } }]);
  };

  const whoRuns = async (): Promise<void> => {
    const key = chainKey;
    setPreview({ state: "loading", key });
    try {
      const answer = await api.previewWorkflowAccount({ chain: [...chain], ...(projectPath ? { projectPath } : {}) });
      setPreview({ state: "done", key, decision: answer.decision, at: Date.now() });
    } catch (error) {
      setPreview({ state: "error", key, message: error instanceof Error ? error.message : "The daemon did not answer." });
    }
  };

  const listProblems = problemsOn(problems, "config.chain");
  const full = chain.length >= WORKFLOW_LIMITS.maxAgentChain;

  return (
    <div ref={listRef} className="space-y-2">
      {chain.map((entry, index) => (
        <ChainCard
          key={ids.current[index]}
          cardId={ids.current[index]!}
          entry={entry}
          index={index}
          count={chain.length}
          agents={agents}
          providers={providers}
          onChange={(next) => onChange(chain.map((current, i) => (i === index ? next : current)))}
          onMove={(delta) => {
            focusAfterMove.current = { id: ids.current[index]!, delta };
            move(index, index + delta);
          }}
          onRemove={() => remove(index)}
          dropTarget={overIndex === index && dragIndex !== null && dragIndex !== index}
          onGripDragStart={(event) => {
            setDragIndex(index);
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", String(index));
          }}
          dragProps={{
            onDragOver: (event) => {
              if (dragIndex === null) return;
              event.preventDefault();
              setOverIndex(index);
            },
            onDrop: (event) => {
              event.preventDefault();
              if (dragIndex !== null) move(dragIndex, index);
              setDragIndex(null);
              setOverIndex(null);
            },
            onDragEnd: () => {
              setDragIndex(null);
              setOverIndex(null);
            }
          }}
        />
      ))}
      {listProblems.map((problem, at) => (
        <p key={at} className={cn("text-[11px] leading-4", problem.severity === "error" ? "text-danger" : "text-warn")}>
          {problem.code === "chain_too_long"
            ? `At most ${WORKFLOW_LIMITS.maxAgentChain} choices: remove ${chain.length - WORKFLOW_LIMITS.maxAgentChain} before the workflow can be turned on.`
            : stripName(problem.message)}
        </p>
      ))}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <SmallButton icon={<Plus size={13} />} onClick={add} disabled={full} title={full ? `At most ${WORKFLOW_LIMITS.maxAgentChain} choices` : undefined}>
          Add a fallback
        </SmallButton>
        <SmallButton
          icon={preview.state === "loading" ? <Loader2 size={13} className="motion-safe:animate-spin" /> : <UserSearch size={13} />}
          onClick={() => void whoRuns()}
          disabled={preview.state === "loading"}
        >
          Who would run now?
        </SmallButton>
        {full ? <span className="text-[11px] text-neutral-500">At most {WORKFLOW_LIMITS.maxAgentChain} choices.</span> : null}
      </div>
      {preview.state === "done" ? (
        <DecisionView decision={preview.decision} names={names} now={preview.at} stale={preview.key !== chainKey} onRefresh={() => void whoRuns()} />
      ) : null}
      {preview.state === "error" ? <p className="text-[11px] text-danger">Couldn't check: {preview.message}</p> : null}
    </div>
  );
};
