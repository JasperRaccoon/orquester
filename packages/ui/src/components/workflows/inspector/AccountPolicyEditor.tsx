/**
 * The account policy of one chain entry (workflows spec §5.1, §5.2): which
 * account runs it — the one with the most quota left, the one whose quota
 * resets soonest, or a fixed order — the usage that rules an account out
 * (5-hour, weekly, and each scoped window the usage data knows, e.g. Fable,
 * optionally only for some models), which accounts it may use, each with its
 * live usage bars, and what to do with an account whose usage can't be read.
 *
 * Every sentence here is the engine's rule (daemon `workflows/agent/select.ts`,
 * restated in `lib/workflows/agent-policy-text.ts`); every allow-list edit is
 * written the way the engine reads it (`lib/workflows/inspector-usage.ts`).
 */

import React, { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, KeyRound } from "lucide-react";

import type { AccountPolicy } from "@orquester/api";
import type { ProviderModel } from "@orquester/api/agent-chat";

import { cn } from "../../../lib/cn";
import {
  accountsCountText,
  formatPercent,
  scopedRuleApplies,
  scopedWindowCovers
} from "../../../lib/workflows/agent-policy-text";
import {
  accountUsageRows,
  allowAllAccounts,
  allowListView,
  dropMissingAccounts,
  formatResetIn,
  moveAllowedAccount,
  scopedLimitRows,
  scopedWindowLabels,
  setSystemAllowed,
  SYSTEM_ACCOUNT_ID,
  toggleAllowedAccount,
  usageTone,
  withStrategy,
  type AccountUsageRow,
  type AllowListAccount,
  type AllowListPatch,
  type UsageBar
} from "../../../lib/workflows/inspector-usage";
import { useAppStore } from "../../../store/app";
import {
  Callout,
  ChipGroup,
  Disclosure,
  Field,
  HelpTip,
  IconButton,
  NumberInput,
  RadioCards,
  Segmented,
  SelectInput,
  SmallButton,
  ToggleRow
} from "../ui/controls";
import { FieldAnchor, useInspector, useRevealOpen } from "./inspector-context";

const TONE_VAR: Record<ReturnType<typeof usageTone>, string> = {
  ok: "var(--usage-ok)",
  med: "var(--usage-med)",
  high: "var(--usage-high)",
  crit: "var(--usage-crit)"
};

/** The threshold a fresh limit starts at. */
const DEFAULT_THRESHOLD = 85;

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** The family's managed accounts as the allow-list matches them (id, own label), in the family's order. */
export function useManagedAccounts(family: string): { accounts: AllowListAccount[]; loaded: boolean } {
  const agentAccounts = useAppStore((state) => state.agentAccounts);
  return useMemo(
    () => ({
      accounts: (agentAccounts?.accounts ?? []).filter((account) => account.agent === family).map((account) => ({ id: account.id, label: account.label })),
      loaded: agentAccounts !== null
    }),
    [agentAccounts, family]
  );
}

/** How many accounts a policy lets run, of how many it could (the System login counted when allowed). */
export function allowedCounts(policy: AccountPolicy, managed: readonly AllowListAccount[]): { allowed: number; total: number } {
  const view = allowListView(policy, managed);
  const system = view.candidates.includes(SYSTEM_ACCOUNT_ID) ? 1 : 0;
  return { allowed: view.candidates.length, total: managed.length + system };
}

const Bar: React.FC<{ bar: UsageBar; threshold?: number; now: number }> = ({ bar, threshold, now }) => {
  const percent = Math.max(0, Math.min(100, bar.percent));
  const over = threshold !== undefined && bar.percent >= threshold;
  const reset = formatResetIn(bar.resetsAt, now);
  const name = bar.label === "5h" ? "5-hour" : bar.label === "Week" ? "Weekly" : bar.label;
  return (
    <div
      className="grid grid-cols-[42px_1fr_auto] items-center gap-2 text-[10.5px] leading-4"
      title={`${name}: ${Math.round(bar.percent)}% used${threshold !== undefined ? ` · your limit ${formatPercent(threshold)}` : ""}${reset ? ` · resets in ${reset}` : ""}`}
    >
      <span className="truncate text-neutral-500">{bar.label}</span>
      <span className="relative h-1.5 overflow-hidden rounded-full bg-neutral-800">
        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${percent}%`, background: TONE_VAR[usageTone(bar.percent)] }} />
        {threshold !== undefined ? (
          <span aria-hidden className="absolute inset-y-[-2px] w-px bg-neutral-300/80" style={{ left: `${Math.min(100, threshold)}%` }} />
        ) : null}
      </span>
      <span className={cn("tabular-nums", over ? "text-danger" : "text-neutral-400")}>
        {Math.round(bar.percent)}%{reset ? <span className="text-neutral-600"> · {reset}</span> : null}
      </span>
    </div>
  );
};

const AccountRow: React.FC<{
  row: AccountUsageRow;
  policy: AccountPolicy;
  model: string;
  checked: boolean;
  /** Absent: this one can't be unticked (the last allowed). */
  onToggle?: () => void;
  ordered?: { index: number; count: number; move: (delta: number) => void };
  now: number;
}> = ({ row, policy, model, checked, onToggle, ordered, now }) => {
  // The engine skips on any rule that applies, so the lowest one is the limit.
  const scopedMax = (label: string): number | undefined => {
    const limits = (policy.scoped ?? [])
      .filter((rule) => rule.label.trim().toLowerCase() === label.trim().toLowerCase() && scopedRuleApplies(rule, model))
      .map((rule) => rule.maxPct);
    return limits.length > 0 ? Math.min(...limits) : undefined;
  };
  const locked = checked && !onToggle;
  return (
    <div className={cn("rounded-lg border px-2.5 py-2 transition-colors", checked ? "border-neutral-700 bg-neutral-900" : "border-neutral-800/70 bg-transparent")}>
      <div className="flex items-center gap-2">
        <label className={cn("flex min-w-0 flex-1 items-center gap-2", !locked && "cursor-pointer")} title={locked ? "Keep at least one account" : undefined}>
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggle}
            disabled={locked}
            className="h-3.5 w-3.5 shrink-0 accent-neutral-300 [.wf-touch_&]:h-5 [.wf-touch_&]:w-5"
          />
          {ordered && checked ? (
            <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded bg-neutral-800 px-1 text-[10.5px] font-semibold tabular-nums text-neutral-300">
              {ordered.index + 1}
            </span>
          ) : null}
          <span className={cn("min-w-0 flex-1 truncate text-[12.5px]", checked ? "text-neutral-200" : "text-neutral-500")} title={row.label}>
            {row.label}
          </span>
        </label>
        {row.needsReauth ? (
          <span className="shrink-0 rounded bg-danger-soft/60 px-1.5 text-[10px] font-medium leading-4 text-danger" title="Its sign-in expired: it is skipped until you sign in again (Settings → Accounts)">
            <KeyRound size={9} className="mr-0.5 inline" aria-hidden />
            sign in again
          </span>
        ) : null}
        {row.unknown && !row.needsReauth ? (
          <span className="shrink-0 text-[10px] text-neutral-500" title="No usage reading, or none in the last 20 minutes">
            usage unknown
          </span>
        ) : null}
        {ordered && checked ? (
          <span className="flex shrink-0 items-center">
            <IconButton size="sm" label={`Try ${row.label} earlier`} disabled={ordered.index === 0} onClick={() => ordered.move(-1)} className="[.wf-touch_&]:h-9 [.wf-touch_&]:w-9">
              <ArrowUp size={12} />
            </IconButton>
            <IconButton size="sm" label={`Try ${row.label} later`} disabled={ordered.index === ordered.count - 1} onClick={() => ordered.move(1)} className="[.wf-touch_&]:h-9 [.wf-touch_&]:w-9">
              <ArrowDown size={12} />
            </IconButton>
          </span>
        ) : null}
      </div>
      {row.session || row.weekly || row.scoped.length > 0 ? (
        <div className={cn("mt-1.5 space-y-1 pl-[22px]", !checked && "opacity-60")}>
          {row.session ? <Bar bar={row.session} threshold={policy.maxSessionPct} now={now} /> : null}
          {row.weekly ? <Bar bar={row.weekly} threshold={policy.maxWeeklyPct} now={now} /> : null}
          {row.scoped.map((bar) => (
            <Bar key={bar.label} bar={bar} threshold={scopedMax(bar.label)} now={now} />
          ))}
        </div>
      ) : null}
    </div>
  );
};

/** One usage limit: off (only a used-up window skips) or a slider + number, 5–100 %. */
const ThresholdRow: React.FC<{
  label: string;
  /** What "off" means for this window. */
  offText: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  children?: React.ReactNode;
}> = ({ label, offText, value, onChange, children }) => {
  const on = value !== undefined;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
        <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-neutral-200">
          <input
            type="checkbox"
            checked={on}
            onChange={() => onChange(on ? undefined : DEFAULT_THRESHOLD)}
            className="h-3.5 w-3.5 accent-neutral-300 [.wf-touch_&]:h-5 [.wf-touch_&]:w-5"
          />
          {label}
        </label>
        {on ? <span className="text-[11px] tabular-nums text-neutral-400">skipped at {formatPercent(value)} or more</span> : null}
      </div>
      {on ? (
        <div className="flex items-center gap-2.5 pl-[22px]">
          <input
            type="range"
            min={5}
            max={100}
            step={5}
            value={Math.max(5, Math.min(100, value))}
            aria-label={`${label}: skip at`}
            onChange={(event) => onChange(Number(event.target.value))}
            className="h-6 min-w-0 flex-1 cursor-pointer accent-neutral-300"
          />
          <NumberInput
            value={value}
            onValue={(next) => onChange(next ?? DEFAULT_THRESHOLD)}
            min={5}
            max={100}
            suffix="%"
            className="w-[76px] shrink-0"
            allowEmpty={false}
            aria-label={`${label}: skip at percent`}
          />
        </div>
      ) : (
        <p className="pl-[22px] text-[11px] leading-4 text-neutral-500">{offText}</p>
      )}
      {children ? <div className="pl-[22px]">{children}</div> : null}
    </div>
  );
};

/** The model list a scoped limit is checked for (`onlyForModels`), under an Advanced toggle. */
const ScopedModels: React.FC<{
  anchor: string;
  label: string;
  models: readonly ProviderModel[];
  value: readonly string[] | undefined;
  entryModel: string;
  onChange: (value: string[] | undefined) => void;
}> = ({ anchor, label, models, value, entryModel, onChange }) => {
  const [open, setOpen] = useRevealOpen([anchor]);
  const picked = value ?? [];
  const options = [
    ...models.map((model) => ({ value: model.slug, label: model.shortName ?? model.name, title: model.slug })),
    // A stored slug the catalogue doesn't list stays visible (and removable).
    ...picked.filter((slug) => !models.some((model) => model.slug === slug)).map((slug) => ({ value: slug, label: `${slug} (unavailable)`, title: slug }))
  ];
  const summary = picked.length === 0 ? "every model" : picked.length === 1 ? (options.find((option) => option.value === picked[0])?.label ?? picked[0]) : `${picked.length} models`;
  return (
    <FieldAnchor field={anchor}>
      <Disclosure label="Models it counts for" summary={summary} open={open} onOpenChange={setOpen}>
        {options.length > 0 ? (
          <ChipGroup
            ariaLabel={`Models the ${label} limit counts for`}
            values={picked}
            options={options}
            onValues={(next) => onChange(next.length > 0 ? next : undefined)}
          />
        ) : (
          <p className="text-[11px] leading-4 text-neutral-500">This agent's models haven't loaded yet.</p>
        )}
        <p className="text-[11px] leading-4 text-neutral-500">
          None picked: checked whatever model this choice runs. Picked: checked only when it runs one of them — and a used-up {label} window then stops
          those models even without a limit.
          {value && !value.includes(entryModel) ? <span className="text-warn"> This choice runs “{entryModel}”, which isn't picked, so this limit is not checked.</span> : null}
        </p>
      </Disclosure>
    </FieldAnchor>
  );
};

export const AccountPolicyEditor: React.FC<{
  family: string;
  /** The agent's name ("Claude"), for sentences. */
  agentLabel: string;
  policy: AccountPolicy;
  onChange: (policy: AccountPolicy) => void;
  /** The chain entry's model: scoped limits are checked per model. */
  model: string;
  /** The agent's catalogue models, for the scoped limits' model lists. */
  models: readonly ProviderModel[];
  /** The policy's validation field path ("config.chain.0.accounts"). */
  anchor: string;
}> = ({ family, agentLabel, policy, onChange, model, models, anchor }) => {
  const { problems } = useInspector();
  const usage = useAppStore((state) => state.usage);
  const agentAccounts = useAppStore((state) => state.agentAccounts);
  const { accounts: managed, loaded } = useManagedAccounts(family);
  const now = useNow(30_000);
  const set = (patch: Partial<AccountPolicy>): void => onChange({ ...policy, ...patch });
  const apply = (patch: AllowListPatch | null): void => {
    if (patch) set(patch);
  };

  const view = allowListView(policy, managed);
  const systemAllowed = view.candidates.includes(SYSTEM_ACCOUNT_ID);
  const rows = useMemo(
    () => accountUsageRows({ family, accounts: agentAccounts?.accounts, usage, includeSystem: systemAllowed, now }),
    [family, agentAccounts, usage, systemAllowed, now]
  );
  const scopedRows = useMemo(() => scopedLimitRows(policy.scoped, scopedWindowLabels(usage, family)), [policy.scoped, usage, family]);

  const fixed = policy.strategy === "fixed";
  // Fixed: the allowed accounts in the order tried, then the others. Otherwise the family's order, System last.
  const shownRows = fixed
    ? [
        ...view.candidates.map((id) => rows.find((row) => row.id === id)).filter((row): row is AccountUsageRow => row !== undefined),
        ...rows.filter((row) => !view.candidates.includes(row.id))
      ]
    : rows;
  const counts = allowedCounts(policy, managed);
  const lastOne = view.candidates.length === 1;

  const setScoped = (row: { label: string; ruleIndex: number | null }, maxPct: number | undefined): void => {
    const rules = [...(policy.scoped ?? [])];
    if (row.ruleIndex === null) {
      if (maxPct === undefined) return;
      rules.push({ label: row.label, maxPct });
    } else if (maxPct === undefined) {
      rules.splice(row.ruleIndex, 1);
    } else {
      rules[row.ruleIndex] = { ...rules[row.ruleIndex]!, maxPct };
    }
    set({ scoped: rules.length > 0 ? rules : undefined });
  };
  const setScopedModels = (ruleIndex: number, onlyForModels: string[] | undefined): void => {
    const rules = [...(policy.scoped ?? [])];
    const { onlyForModels: _drop, ...rest } = rules[ruleIndex]!;
    rules[ruleIndex] = onlyForModels ? { ...rest, onlyForModels } : rest;
    set({ scoped: rules });
  };

  // Schema problems anywhere in the policy (a hand-edited definition), each once.
  const policyProblems = problems.filter((problem) => problem.field !== undefined && (problem.field === anchor || problem.field.startsWith(`${anchor}.`)));

  return (
    <div className="space-y-5">
      {policyProblems.length > 0 ? (
        <div className="space-y-0.5">
          {policyProblems.map((problem, index) => (
            <p key={index} className={cn("text-[11px] leading-4", problem.severity === "error" ? "text-danger" : "text-warn")}>
              {problem.message.replace(/^[A-Za-z][A-Za-z0-9_]*: /, "")}
            </p>
          ))}
        </div>
      ) : null}

      <FieldAnchor field={`${anchor}.strategy`} className="space-y-2">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-neutral-400">Which account runs it</span>
        </div>
        <RadioCards<AccountPolicy["strategy"]>
          ariaLabel="Which account runs it"
          value={policy.strategy}
          onValue={(strategy) => onChange(withStrategy(policy, managed, strategy))}
          options={[
            {
              value: "least-used",
              label: "Most quota left",
              description: "The account furthest from its usage limits.",
              children: (
                <FieldAnchor field={`${anchor}.leastUsedMetric`}>
                  <Field label="Compare by" hint="On a tie, the one whose weekly quota resets sooner.">
                    <SelectInput value={policy.leastUsedMetric} onValue={(value) => set({ leastUsedMetric: value as AccountPolicy["leastUsedMetric"] })}>
                      <option value="max">Whichever limit is closer to full (recommended)</option>
                      <option value="weekly">Weekly limit only</option>
                      <option value="session">5-hour limit only</option>
                    </SelectInput>
                  </Field>
                </FieldAnchor>
              )
            },
            {
              value: "soonest-reset",
              label: "Quota that resets soonest",
              description: "Uses up quota that is about to refill anyway, and saves the rest.",
              children: (
                <FieldAnchor field={`${anchor}.soonestResetWindow`}>
                  <Field label="Which reset" hint="An account whose reset time isn't known goes last.">
                    <Segmented<AccountPolicy["soonestResetWindow"]>
                      label="Which reset"
                      size="sm"
                      wrap
                      value={policy.soonestResetWindow}
                      onChange={(soonestResetWindow) => set({ soonestResetWindow })}
                      options={[
                        { id: "weekly", label: "Weekly reset" },
                        { id: "session", label: "5-hour reset" }
                      ]}
                    />
                  </Field>
                </FieldAnchor>
              )
            },
            {
              value: "fixed",
              label: "Fixed order",
              description: "Tries the accounts in your order below, moving on when one can't run: over a limit, resting after one, or signed out."
            }
          ]}
        />
      </FieldAnchor>

      <div className="space-y-3">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-neutral-400">Skip an account once its usage reaches</span>
          <HelpTip label="usage limits">
            <p>Each provider meters an account in windows: a 5-hour one, a weekly one, and some add their own (e.g. Fable for some Claude models).</p>
            <p>With a limit set, an account is skipped while that window is at the limit or above. Without one, it is skipped only once the window is used up (100%).</p>
            <p>A window the provider doesn't report never skips an account.</p>
          </HelpTip>
        </div>
        <FieldAnchor field={`${anchor}.maxSessionPct`}>
          <ThresholdRow
            label="5-hour limit"
            offText="No limit — only skipped when used up (100%)."
            value={policy.maxSessionPct}
            onChange={(maxSessionPct) => set({ maxSessionPct })}
          />
        </FieldAnchor>
        <FieldAnchor field={`${anchor}.maxWeeklyPct`}>
          <ThresholdRow
            label="Weekly limit"
            offText="No limit — only skipped when used up (100%)."
            value={policy.maxWeeklyPct}
            onChange={(maxWeeklyPct) => set({ maxWeeklyPct })}
          />
        </FieldAnchor>
        {scopedRows.map((row, index) => {
          const rule = row.ruleIndex === null ? undefined : policy.scoped?.[row.ruleIndex];
          const covers = scopedWindowCovers(row.label, model, policy.scoped ?? []);
          const field = row.ruleIndex === null ? `${anchor}.scoped` : `${anchor}.scoped.${row.ruleIndex}`;
          return (
            <FieldAnchor key={`${row.label}:${row.ruleIndex ?? `new${index}`}`} field={field}>
              <ThresholdRow
                label={`${row.label} limit`}
                offText={covers ? "No limit — only skipped when used up (100%)." : `No limit — not checked for “${model}”.`}
                value={rule?.maxPct}
                onChange={(value) => setScoped(row, value)}
              >
                {rule && row.ruleIndex !== null ? (
                  <ScopedModels
                    anchor={`${anchor}.scoped.${row.ruleIndex}.onlyForModels`}
                    label={row.label}
                    models={models}
                    value={rule.onlyForModels}
                    entryModel={model}
                    onChange={(value) => setScopedModels(row.ruleIndex!, value)}
                  />
                ) : null}
              </ThresholdRow>
            </FieldAnchor>
          );
        })}
      </div>

      <FieldAnchor field={`${anchor}.accounts`} className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="text-xs font-medium text-neutral-400">{fixed ? "Accounts, in the order tried" : "Accounts it may use"}</span>
            <HelpTip label="the account list">
              <p>Untick an account to keep this choice off it.{fixed ? " The arrows set the order." : ""}</p>
              <p>Each bar is an account's usage now, with a tick at your limit and the time until the window resets.</p>
              <p>
                {view.explicit
                  ? "An account added later in Settings → Accounts isn't used until you tick it here."
                  : "An account added later in Settings → Accounts is used too."}
              </p>
            </HelpTip>
          </div>
          <span className="flex items-center gap-2 text-[11px] text-neutral-500">
            {loaded ? accountsCountText(counts.allowed, counts.total) : null}
            {loaded && managed.some((account) => !view.candidates.includes(account.id)) ? (
              <SmallButton variant="ghost" className="h-6 px-1.5 [.wf-touch_&]:h-9" onClick={() => apply(allowAllAccounts(policy, managed, policy.strategy))}>
                Use all
              </SmallButton>
            ) : null}
          </span>
        </div>
        {view.missing.length > 0 ? (
          <Callout
            tone="warn"
            action={
              <SmallButton onClick={() => apply(dropMissingAccounts(policy, managed, policy.strategy))}>
                Remove {view.missing.length === 1 ? "it" : "them"}
              </SmallButton>
            }
          >
            Listed but not found among the {agentLabel} accounts: {view.missing.map((entry) => `“${entry}”`).join(", ")}. Runs skip{" "}
            {view.missing.length === 1 ? "it" : "them"}.
          </Callout>
        ) : null}
        {!loaded ? (
          <p className="text-[11.5px] text-neutral-500">Loading accounts…</p>
        ) : shownRows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-neutral-800 px-3 py-2.5 text-[11.5px] leading-4 text-neutral-500">
            No {agentLabel} accounts are set up here. Add one in Settings → Accounts, or use the daemon's own sign-in below.
          </p>
        ) : (
          shownRows.map((row) => {
            const checked = view.candidates.includes(row.id);
            const toggle = row.isSystem
              ? () => apply(setSystemAllowed(policy, managed, policy.strategy, !checked))
              : () => apply(toggleAllowedAccount(policy, managed, policy.strategy, row.id));
            const index = view.candidates.indexOf(row.id);
            return (
              <AccountRow
                key={row.id}
                row={row}
                policy={policy}
                model={model}
                checked={checked}
                {...(checked && lastOne && managed.length > 0 ? {} : { onToggle: toggle })}
                {...(fixed && checked
                  ? { ordered: { index, count: view.candidates.length, move: (delta: number) => apply(moveAllowedAccount(policy, managed, row.id, delta)) } }
                  : {})}
                now={now}
              />
            );
          })
        )}
      </FieldAnchor>

      <FieldAnchor field={`${anchor}.includeSystem`} className="space-y-1">
        <ToggleRow
          checked={systemAllowed}
          disabled={systemAllowed && lastOne && managed.length > 0}
          onChange={(on) => apply(setSystemAllowed(policy, managed, policy.strategy, on))}
          label="Also use the daemon's own sign-in (System login)"
          description={`The ${agentLabel} sign-in of the user the Orquester daemon runs as — not one of the accounts in Settings → Accounts. It is picked like any other account.`}
        />
      </FieldAnchor>

      <FieldAnchor field={`${anchor}.unknownUsage`}>
        <Field label="If an account's usage can't be read" hint="Usage can't be read when the provider hasn't reported it, or not in the last 20 minutes.">
          <Segmented<AccountPolicy["unknownUsage"]>
            label="If an account's usage can't be read"
            size="sm"
            wrap
            value={policy.unknownUsage}
            onChange={(unknownUsage) => set({ unknownUsage })}
            options={[
              { id: "last", label: "Try it after the others", description: "Used only when no account with a reading can run." },
              { id: "exclude", label: "Don't use it", description: "Skipped until its usage can be read again." }
            ]}
          />
        </Field>
      </FieldAnchor>
    </div>
  );
};
