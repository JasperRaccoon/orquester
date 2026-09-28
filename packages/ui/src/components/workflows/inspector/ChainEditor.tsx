/**
 * An agent block's fallback chain (workflows spec §5.1): the agents it may
 * run, in the order the engine falls back across them on usage limits. Each
 * row picks an agent (registry agents with a chat adapter), a model and its
 * options (effort…) from the live provider catalogue — the composer's pure
 * helpers — and an account policy. Rows reorder by dragging the grip or with
 * the arrows. "Who would run now?" asks the daemon to run the selection
 * against live usage and shows the pick and every skip with its reason.
 */

import React, { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  GripVertical,
  Loader2,
  Plus,
  Trash2,
  UserSearch
} from "lucide-react";

import {
  WORKFLOW_LIMITS,
  type AccountPolicy,
  type AccountSelectionDecision,
  type AgentChainEntry
} from "@orquester/api";
import type { ProviderModel, ProviderSnapshot } from "@orquester/api/agent-chat";

import { useApi } from "../../../context/orquester-context";
import { cn } from "../../../lib/cn";
import { useProviderSnapshots } from "../../../lib/agent-chat/hooks";
import { providerForRefId } from "../../../lib/agent-chat/providers";
import { defaultAgentLabel } from "../../../lib/workflows/catalog-ui";
import { accountFamily } from "../../../lib/workflows/inspector-usage";
import { useAppStore } from "../../../store/app";
import { currentOptionValue, optionDescriptors, resolveSelectedModel } from "../../agent-chat/composer/composer-model";
import { Field, IconButton, SelectInput, SmallButton, TextInput, ToggleRow } from "../ui/controls";
import { AccountPolicyEditor } from "./AccountPolicyEditor";

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

/** The models an entry can pick: the proxy's list for claudex/claudemix, else the provider's catalogue. */
function modelsFor(agent: string, providers: readonly ProviderSnapshot[], proxyModels: readonly string[] | null): ProviderModel[] {
  if ((agent === "claudex" || agent === "claudemix") && proxyModels && proxyModels.length > 0) {
    return proxyModels.map((slug) => ({ slug, name: slug, capabilities: null }));
  }
  return providerForRefId(providers, agent)?.models ?? [];
}

const ChainRow: React.FC<{
  entry: AgentChainEntry;
  index: number;
  count: number;
  agents: AgentChoice[];
  providers: readonly ProviderSnapshot[];
  proxyModels: readonly string[] | null;
  error: string | null;
  onChange: (entry: AgentChainEntry) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
  dragProps: React.HTMLAttributes<HTMLDivElement>;
  onGripDragStart: (event: React.DragEvent) => void;
  dropTarget: boolean;
}> = ({ entry, index, count, agents, providers, proxyModels, error, onChange, onMove, onRemove, dragProps, onGripDragStart, dropTarget }) => {
  const [accountsOpen, setAccountsOpen] = useState(index === 0);
  const models = modelsFor(entry.agent, providers, proxyModels);
  const selected = resolveSelectedModel(models, { model: entry.model });
  const exact = models.some((model) => model.slug === entry.model);
  const descriptors = optionDescriptors(exact ? selected : null).filter(
    // OpenCode's `agent` option is never set by a workflow (spec §5.1 step 3).
    (descriptor) => !(entry.agent === "opencode" && descriptor.id === "agent")
  );
  const family = accountFamily(entry.agent);
  const agentKnown = agents.some((agent) => agent.id === entry.agent);
  const selection = { model: entry.model, ...(entry.options ? { options: entry.options } : {}) };

  const setOption = (id: string, value: string | boolean): void => {
    const options = (entry.options ?? []).filter((option) => option.id !== id);
    onChange({ ...entry, options: [...options, { id, value }] });
  };

  return (
    <div
      {...dragProps}
      className={cn(
        "rounded-xl border bg-neutral-900/70 transition-colors",
        dropTarget ? "border-neutral-400" : "border-neutral-800",
        error && "border-danger/50"
      )}
    >
      <div className="flex items-center gap-1.5 border-b border-neutral-800/80 py-1.5 pl-1.5 pr-1">
        <span
          draggable
          onDragStart={onGripDragStart}
          className="cursor-grab rounded text-neutral-600 hover:text-neutral-300 active:cursor-grabbing"
          title="Drag to reorder"
          aria-hidden
        >
          <GripVertical size={14} />
        </span>
        <span className="flex h-5 min-w-5 items-center justify-center rounded-md bg-neutral-800 px-1 text-[10.5px] font-semibold tabular-nums text-neutral-300">
          {index + 1}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-200">
          {index === 0 ? "First choice" : `Fallback ${index}`}
        </span>
        <IconButton size="sm" label="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
          <ArrowUp size={12} />
        </IconButton>
        <IconButton size="sm" label="Move down" disabled={index === count - 1} onClick={() => onMove(1)}>
          <ArrowDown size={12} />
        </IconButton>
        <IconButton size="sm" label="Remove from the chain" tone="danger" disabled={count === 1} onClick={onRemove}>
          <Trash2 size={12} />
        </IconButton>
      </div>
      <div className="space-y-3 p-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Agent">
            <SelectInput
              value={entry.agent}
              aria-label="Agent"
              onValue={(agent) => {
                const nextModels = modelsFor(agent, providers, proxyModels);
                const model = resolveSelectedModel(nextModels, null)?.slug ?? entry.model;
                const policy = entry.accounts ?? DEFAULT_POLICY;
                // Another family's account ids mean nothing here: the allow-list starts over.
                const sameFamily = accountFamily(agent) === accountFamily(entry.agent);
                onChange({ agent, model, accounts: sameFamily ? policy : { ...policy, accounts: undefined } });
              }}
            >
              {!agentKnown ? <option value={entry.agent}>{defaultAgentLabel(entry.agent)} (not installed)</option> : null}
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.label}
                  {agent.installed ? "" : " (not installed)"}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field label="Model">
            {models.length > 0 ? (
              <SelectInput
                value={entry.model}
                aria-label="Model"
                onValue={(model) => {
                  const picked = models.find((candidate) => candidate.slug === model);
                  const keep = (entry.options ?? []).filter((option) =>
                    optionDescriptors(picked ?? null).some((descriptor) => descriptor.id === option.id)
                  );
                  onChange({ ...entry, model, ...(keep.length > 0 ? { options: keep } : { options: undefined }) });
                }}
              >
                {!exact ? <option value={entry.model}>{entry.model} (not in the catalogue)</option> : null}
                {models.map((model) => (
                  <option key={model.slug} value={model.slug}>
                    {model.shortName ?? model.name}
                  </option>
                ))}
              </SelectInput>
            ) : (
              <TextInput value={entry.model} aria-label="Model" onValue={(model) => onChange({ ...entry, model })} placeholder="Model id" />
            )}
          </Field>
        </div>
        {error ? <p className="text-[11px] leading-4 text-danger">{error}</p> : null}
        {descriptors.length > 0 ? (
          <div className="grid grid-cols-2 gap-2">
            {descriptors.map((descriptor) =>
              descriptor.type === "select" ? (
                <Field key={descriptor.id} label={descriptor.label}>
                  <SelectInput
                    value={String(currentOptionValue(selection, descriptor) ?? "")}
                    aria-label={descriptor.label}
                    onValue={(value) => setOption(descriptor.id, value)}
                  >
                    {descriptor.options.map((choice) => (
                      <option key={choice.id} value={choice.id}>
                        {choice.label}
                        {choice.isDefault ? " (default)" : ""}
                      </option>
                    ))}
                  </SelectInput>
                </Field>
              ) : (
                <div key={descriptor.id} className="col-span-2">
                  <ToggleRow
                    checked={currentOptionValue(selection, descriptor) === true}
                    onChange={(value) => setOption(descriptor.id, value)}
                    label={descriptor.label}
                    {...(descriptor.description ? { description: descriptor.description } : {})}
                  />
                </div>
              )
            )}
          </div>
        ) : null}
        {family ? (
          <div className="rounded-lg border border-neutral-800/80 bg-neutral-950/40">
            <button
              type="button"
              aria-expanded={accountsOpen}
              onClick={() => setAccountsOpen(!accountsOpen)}
              className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left text-xs font-medium text-neutral-300 hover:text-neutral-100"
            >
              {accountsOpen ? <ChevronDown size={13} className="text-neutral-500" /> : <ChevronRight size={13} className="text-neutral-500" />}
              Accounts
              <span className="ml-auto truncate font-normal text-neutral-500">{policySummary(entry.accounts ?? DEFAULT_POLICY)}</span>
            </button>
            {accountsOpen ? (
              <div className="border-t border-neutral-800/80 p-2.5">
                <AccountPolicyEditor
                  family={family}
                  model={entry.model}
                  policy={entry.accounts ?? DEFAULT_POLICY}
                  onChange={(accounts) => onChange({ ...entry, accounts })}
                />
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-[11px] leading-4 text-neutral-500">
            {defaultAgentLabel(entry.agent)} runs under the daemon's own login — there is no account to pick.
          </p>
        )}
      </div>
    </div>
  );
};

function policySummary(policy: AccountPolicy): string {
  const strategy = policy.strategy === "least-used" ? "Least used" : policy.strategy === "soonest-reset" ? "Soonest reset" : "Fixed order";
  const caps: string[] = [];
  if (policy.maxSessionPct !== undefined) caps.push(`5h < ${policy.maxSessionPct}%`);
  if (policy.maxWeeklyPct !== undefined) caps.push(`week < ${policy.maxWeeklyPct}%`);
  for (const scoped of policy.scoped ?? []) caps.push(`${scoped.label} < ${scoped.maxPct}%`);
  return [strategy, ...caps].join(" · ");
}

const DecisionView: React.FC<{ decision: AccountSelectionDecision }> = ({ decision }) => (
  <div className="space-y-2 rounded-lg border border-neutral-800 bg-neutral-950/50 p-2.5 text-[12px]">
    {decision.chosen ? (
      <div className="flex items-start gap-2">
        <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-ok" />
        <div className="min-w-0">
          <div className="font-medium text-neutral-100">
            {defaultAgentLabel(decision.chosen.agent)} · {decision.chosen.model} ·{" "}
            {decision.chosen.accountLabel ?? decision.chosen.accountId}
          </div>
          <div className="text-[11px] leading-4 text-neutral-500">{decision.reason}</div>
        </div>
      </div>
    ) : (
      <div className="flex items-start gap-2">
        <CircleSlash size={14} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0">
          <div className="font-medium text-danger">Nobody could run it right now</div>
          <div className="text-[11px] leading-4 text-neutral-500">{decision.reason}</div>
        </div>
      </div>
    )}
    {decision.skipped.length > 0 ? (
      <ul className="space-y-1 border-t border-neutral-800 pt-2">
        {decision.skipped.map((skip, index) => (
          <li key={`${skip.agent}:${skip.accountId}:${index}`} className="flex gap-2 text-[11px] leading-4">
            <span className="shrink-0 text-neutral-400">
              {defaultAgentLabel(skip.agent)} · {skip.label ?? skip.accountId}
            </span>
            <span className="min-w-0 text-neutral-500">— {skip.detail}</span>
          </li>
        ))}
      </ul>
    ) : null}
  </div>
);

export const ChainEditor: React.FC<{
  chain: readonly AgentChainEntry[];
  onChange: (chain: AgentChainEntry[]) => void;
  projectPath: string;
  /** Validation errors by chain index. */
  errorAt: (index: number) => string | null;
}> = ({ chain, onChange, projectPath, errorAt }) => {
  const api = useApi();
  const agents = useChatAgents();
  const providers = useProviderSnapshots();
  const proxyModels = useAppStore((state) => state.cliproxyModels?.models ?? null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [preview, setPreview] = useState<
    { state: "idle" } | { state: "loading" } | { state: "done"; decision: AccountSelectionDecision } | { state: "error"; message: string }
  >({ state: "idle" });

  const move = (from: number, to: number): void => {
    if (to < 0 || to >= chain.length || from === to) return;
    const next = [...chain];
    const [entry] = next.splice(from, 1);
    next.splice(to, 0, entry!);
    onChange(next);
  };

  const add = (): void => {
    const used = new Set(chain.map((entry) => entry.agent));
    const agent = agents.find((candidate) => !used.has(candidate.id) && candidate.installed) ?? agents[0];
    const id = agent?.id ?? "codex";
    const model = resolveSelectedModel(modelsFor(id, providers, proxyModels), null)?.slug ?? "default";
    onChange([...chain, { agent: id, model, accounts: { ...DEFAULT_POLICY } }]);
  };

  const whoRuns = async (): Promise<void> => {
    setPreview({ state: "loading" });
    try {
      const answer = await api.previewWorkflowAccount({ chain: [...chain], ...(projectPath ? { projectPath } : {}) });
      setPreview({ state: "done", decision: answer.decision });
    } catch (error) {
      setPreview({ state: "error", message: error instanceof Error ? error.message : "The daemon did not answer." });
    }
  };

  return (
    <div className="space-y-2">
      {chain.map((entry, index) => (
        <ChainRow
          key={index}
          entry={entry}
          index={index}
          count={chain.length}
          agents={agents}
          providers={providers}
          proxyModels={proxyModels}
          error={errorAt(index)}
          onChange={(next) => onChange(chain.map((current, i) => (i === index ? next : current)))}
          onMove={(delta) => move(index, index + delta)}
          onRemove={() => onChange(chain.filter((_, i) => i !== index))}
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
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <SmallButton icon={<Plus size={13} />} onClick={add} disabled={chain.length >= WORKFLOW_LIMITS.maxAgentChain}>
          Add a fallback
        </SmallButton>
        <SmallButton
          icon={preview.state === "loading" ? <Loader2 size={13} className="motion-safe:animate-spin" /> : <UserSearch size={13} />}
          onClick={() => void whoRuns()}
          disabled={preview.state === "loading"}
        >
          Who would run now?
        </SmallButton>
      </div>
      {preview.state === "done" ? <DecisionView decision={preview.decision} /> : null}
      {preview.state === "error" ? <p className="text-[11px] text-danger">{preview.message}</p> : null}
    </div>
  );
};
