/**
 * The account policy of one chain entry (workflows spec §5.1, §5.2): how the
 * engine picks an account — least used, soonest reset, or a fixed order — the
 * usage thresholds that rule one out (5h, weekly, and each scoped window the
 * usage data knows, e.g. Fable), and which accounts may run it, each with its
 * live usage bars.
 */

import React, { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, KeyRound } from "lucide-react";

import type { AccountPolicy } from "@orquester/api";

import { cn } from "../../../lib/cn";
import {
  accountUsageRows,
  formatResetIn,
  scopedWindowLabels,
  usageTone,
  type AccountUsageRow,
  type UsageBar
} from "../../../lib/workflows/inspector-usage";
import { useAppStore } from "../../../store/app";
import { Field, IconButton, NumberInput, Segmented, ToggleRow } from "../ui/controls";

const TONE_VAR: Record<ReturnType<typeof usageTone>, string> = {
  ok: "var(--usage-ok)",
  med: "var(--usage-med)",
  high: "var(--usage-high)",
  crit: "var(--usage-crit)"
};

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const Bar: React.FC<{ bar: UsageBar; threshold?: number; now: number }> = ({ bar, threshold, now }) => {
  const percent = Math.max(0, Math.min(100, bar.percent));
  const over = threshold !== undefined && bar.percent >= threshold;
  const reset = formatResetIn(bar.resetsAt, now);
  return (
    <div className="grid grid-cols-[42px_1fr_auto] items-center gap-2 text-[10.5px] leading-4">
      <span className="truncate text-neutral-500">{bar.label}</span>
      <span className="relative h-1.5 overflow-hidden rounded-full bg-neutral-800">
        <span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${percent}%`, background: TONE_VAR[usageTone(bar.percent)] }}
        />
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
  checked: boolean;
  onToggle?: () => void;
  ordered?: { index: number; count: number; move: (delta: number) => void };
  now: number;
}> = ({ row, policy, checked, onToggle, ordered, now }) => {
  const scopedMax = (label: string): number | undefined => policy.scoped?.find((entry) => entry.label === label)?.maxPct;
  return (
    <div className={cn("rounded-lg border px-2.5 py-2 transition-colors", checked ? "border-neutral-700 bg-neutral-900" : "border-neutral-800/70 bg-transparent opacity-70")}>
      <div className="flex items-center gap-2">
        {ordered ? (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-neutral-800 text-[10.5px] font-semibold tabular-nums text-neutral-300">
            {ordered.index + 1}
          </span>
        ) : (
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggle}
            disabled={!onToggle}
            title={onToggle ? undefined : "Set by “Include the System login” below"}
            aria-label={`Allow ${row.label}`}
            className="h-3.5 w-3.5 shrink-0 accent-neutral-300"
          />
        )}
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-neutral-200">{row.label}</span>
        {row.needsReauth ? (
          <span className="shrink-0 rounded bg-danger-soft/60 px-1.5 text-[10px] font-medium leading-4 text-danger" title="Its login expired — it is skipped until you sign in again">
            <KeyRound size={9} className="mr-0.5 inline" aria-hidden />
            needs re-login
          </span>
        ) : null}
        {row.unknown && !row.needsReauth ? (
          <span className="shrink-0 text-[10px] text-neutral-500" title="No usage reading for this account">
            usage unknown
          </span>
        ) : null}
        {ordered ? (
          <span className="flex shrink-0 items-center">
            <IconButton size="sm" label={`Move ${row.label} up`} disabled={ordered.index === 0} onClick={() => ordered.move(-1)}>
              <ArrowUp size={12} />
            </IconButton>
            <IconButton size="sm" label={`Move ${row.label} down`} disabled={ordered.index === ordered.count - 1} onClick={() => ordered.move(1)}>
              <ArrowDown size={12} />
            </IconButton>
          </span>
        ) : null}
      </div>
      {row.session || row.weekly || row.scoped.length > 0 ? (
        <div className="mt-1.5 space-y-1 pl-[22px]">
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

/** A threshold: off (no cap) or a slider + number, 0–100 %. */
const ThresholdField: React.FC<{
  label: string;
  hint: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
}> = ({ label, hint, value, onChange }) => {
  const on = value !== undefined;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs font-medium text-neutral-300">
          <input
            type="checkbox"
            checked={on}
            onChange={() => onChange(on ? undefined : 85)}
            className="h-3.5 w-3.5 accent-neutral-300"
          />
          {label}
        </label>
        <span className="text-[11px] text-neutral-500">{on ? `skip at ≥ ${value}%` : "no limit"}</span>
      </div>
      {on ? (
        <div className="flex items-center gap-2.5 pl-[22px]">
          <input
            type="range"
            min={5}
            max={100}
            step={5}
            value={value}
            aria-label={`${label} threshold`}
            onChange={(event) => onChange(Number(event.target.value))}
            className="h-6 flex-1 cursor-pointer accent-neutral-300"
          />
          <NumberInput value={value} onValue={(next) => onChange(next ?? 85)} min={0} max={100} suffix="%" className="w-[76px]" allowEmpty={false} aria-label={`${label} threshold percent`} />
        </div>
      ) : (
        <p className="pl-[22px] text-[11px] text-neutral-600">{hint}</p>
      )}
    </div>
  );
};

export const AccountPolicyEditor: React.FC<{
  family: string;
  policy: AccountPolicy;
  onChange: (policy: AccountPolicy) => void;
  /** The chain entry's model — a scoped threshold can be limited to it. */
  model: string;
}> = ({ family, policy, onChange }) => {
  const usage = useAppStore((state) => state.usage);
  const agentAccounts = useAppStore((state) => state.agentAccounts);
  const now = useNow(30_000);
  const set = (patch: Partial<AccountPolicy>): void => onChange({ ...policy, ...patch });

  const rows = useMemo(
    () => accountUsageRows({ family, accounts: agentAccounts?.accounts, usage, includeSystem: policy.includeSystem, now }),
    [family, agentAccounts, usage, policy.includeSystem, now]
  );
  const scopedLabels = useMemo(() => {
    const labels = new Set(scopedWindowLabels(usage, family));
    for (const entry of policy.scoped ?? []) labels.add(entry.label);
    return [...labels];
  }, [usage, family, policy.scoped]);

  const allowed = policy.accounts;
  const isAllowed = (id: string): boolean => allowed === undefined || allowed.includes(id);
  const managedIds = rows.filter((row) => !row.isSystem).map((row) => row.id);

  const toggle = (id: string): void => {
    const current = allowed ?? managedIds;
    const next = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
    const everything = managedIds.every((entry) => next.includes(entry));
    set({ accounts: everything ? undefined : next });
  };

  // Fixed order: the listed order, then any account not listed yet.
  const orderedRows = useMemo(() => {
    const order = policy.accounts ?? [];
    const listed = order.map((id) => rows.find((row) => row.id === id)).filter((row): row is AccountUsageRow => row !== undefined);
    return [...listed, ...rows.filter((row) => !order.includes(row.id))];
  }, [rows, policy.accounts]);

  const move = (index: number, delta: number): void => {
    const ids = orderedRows.map((row) => row.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    set({ accounts: ids });
  };

  const setScoped = (label: string, maxPct: number | undefined): void => {
    const others = (policy.scoped ?? []).filter((entry) => entry.label !== label);
    const existing = policy.scoped?.find((entry) => entry.label === label);
    const next = maxPct === undefined ? others : [...others, { ...(existing ?? { label }), label, maxPct }];
    set({ scoped: next.length > 0 ? next : undefined });
  };

  return (
    <div className="space-y-4">
      <Field label="Pick the account by">
        <Segmented<AccountPolicy["strategy"]>
          label="Account strategy"
          value={policy.strategy}
          onChange={(strategy) => set({ strategy })}
          options={[
            { id: "least-used", label: "Least used", title: "The account with the most headroom" },
            { id: "soonest-reset", label: "Soonest reset", title: "Burn the quota that resets first" },
            { id: "fixed", label: "Fixed order", title: "Try accounts in the order below" }
          ]}
        />
      </Field>
      {policy.strategy === "least-used" ? (
        <Field label="Measured by">
          <Segmented<AccountPolicy["leastUsedMetric"]>
            label="Least-used metric"
            size="sm"
            value={policy.leastUsedMetric}
            onChange={(leastUsedMetric) => set({ leastUsedMetric })}
            options={[
              { id: "max", label: "Worst window" },
              { id: "weekly", label: "Weekly" },
              { id: "session", label: "5 hours" }
            ]}
          />
        </Field>
      ) : policy.strategy === "soonest-reset" ? (
        <Field label="Window that resets">
          <Segmented<AccountPolicy["soonestResetWindow"]>
            label="Soonest-reset window"
            size="sm"
            value={policy.soonestResetWindow}
            onChange={(soonestResetWindow) => set({ soonestResetWindow })}
            options={[
              { id: "weekly", label: "Weekly" },
              { id: "session", label: "5 hours" }
            ]}
          />
        </Field>
      ) : null}

      <div className="space-y-3">
        <ThresholdField
          label="5-hour window"
          hint="Never skipped for its 5-hour usage."
          value={policy.maxSessionPct}
          onChange={(maxSessionPct) => set({ maxSessionPct })}
        />
        <ThresholdField
          label="Weekly window"
          hint="Never skipped for its weekly usage."
          value={policy.maxWeeklyPct}
          onChange={(maxWeeklyPct) => set({ maxWeeklyPct })}
        />
        {scopedLabels.map((label) => (
          <ThresholdField
            key={label}
            label={`${label} window`}
            hint={`Never skipped for its ${label} usage.`}
            value={policy.scoped?.find((entry) => entry.label === label)?.maxPct}
            onChange={(value) => setScoped(label, value)}
          />
        ))}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-neutral-400">
            {policy.strategy === "fixed" ? "Accounts, in order" : "Accounts it may use"}
          </span>
          {policy.strategy !== "fixed" && allowed !== undefined ? (
            <button type="button" onClick={() => set({ accounts: undefined })} className="text-[11px] text-neutral-500 hover:text-neutral-200">
              Allow all
            </button>
          ) : null}
        </div>
        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-neutral-800 px-3 py-2.5 text-[11.5px] leading-4 text-neutral-500">
            No {family} accounts are managed here. Add one in Settings → Accounts, or allow the System login below.
          </p>
        ) : policy.strategy === "fixed" ? (
          orderedRows.map((row, index) => (
            <AccountRow
              key={row.id}
              row={row}
              policy={policy}
              checked
              now={now}
              ordered={{ index, count: orderedRows.length, move: (delta) => move(index, delta) }}
            />
          ))
        ) : (
          rows.map((row) => (
            <AccountRow
              key={row.id}
              row={row}
              policy={policy}
              checked={row.isSystem || isAllowed(row.id)}
              {...(row.isSystem ? {} : { onToggle: () => toggle(row.id) })}
              now={now}
            />
          ))
        )}
      </div>

      <ToggleRow
        checked={policy.includeSystem}
        onChange={(includeSystem) => set({ includeSystem })}
        label="Include the System login"
        description="The daemon user's own sign-in, as one more candidate."
      />
      <Field label="When an account has no usage reading">
        <Segmented<AccountPolicy["unknownUsage"]>
          label="Unknown usage"
          size="sm"
          value={policy.unknownUsage}
          onChange={(unknownUsage) => set({ unknownUsage })}
          options={[
            { id: "last", label: "Try it last" },
            { id: "exclude", label: "Skip it" }
          ]}
        />
      </Field>
    </div>
  );
};
