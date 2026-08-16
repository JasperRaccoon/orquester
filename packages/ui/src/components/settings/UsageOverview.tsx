import React from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { AgentUsage, UsageAccount } from "@orquester/api";
import { usageAgentEnabled } from "@orquester/config";
import { cn } from "../../lib/cn";
import { shortAccountLabel } from "../../lib/account-label";
import type { UsageResetFormat } from "../../lib/usage-display";
import { getRegistryIcon } from "../../icons";
import { useUsageNow, useUsageResetFormat } from "../../hooks";
import { useAppStore } from "../../store/app";
import {
  STALE_MIN,
  barClass,
  formatAgo,
  formatReset,
  formatUsageCapacity,
  labelForAgent,
  minutesSince,
  missingUsageAgents,
  normalizeUsageWindows,
  usageLoginHint,
  type NormalizedUsageWindow
} from "../topbar/usage-format";

const RESET_OPTIONS: { value: UsageResetFormat; label: string }[] = [
  { value: "relative", label: "Countdown" },
  { value: "absolute", label: "Clock" },
  { value: "both", label: "Both" }
];

/** One labelled window: percent, bar, absolute numbers when the source has them. */
const WindowRow: React.FC<{
  window: NormalizedUsageWindow;
  resetFormat: UsageResetFormat;
  now: number;
  muted: boolean;
}> = ({ window, resetFormat, now, muted }) => {
  const pct = window.percent;
  const capacity = formatUsageCapacity(window);
  const reset = formatReset(window.resetsAt, resetFormat, now);
  return (
    <div className="rounded-md bg-neutral-950/40 px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-xs text-neutral-300">{window.longLabel}</span>
        <span
          className={cn("shrink-0 text-sm font-medium tabular-nums", muted ? "text-neutral-500" : "text-neutral-100")}
        >
          {Math.round(pct)}%
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
        <div
          className={cn("h-full rounded-full transition-[width] duration-500", muted ? "bg-neutral-600" : barClass(pct))}
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
      {/* Gated on content: a percent-only window with no reset time (most of
          them today) must not leave an empty ~22px row under the bar. The
          spacer keeps the reset time right-aligned when only it is present. */}
      {(capacity || reset) && (
        <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-[11px] text-neutral-500">
          {capacity ? <span className="tabular-nums text-neutral-400">{capacity}</span> : <span />}
          {reset && <span className="tabular-nums">{reset}</span>}
        </div>
      )}
    </div>
  );
};

/** Per-account block inside a card (agents that pool several logins). */
const AccountBlock: React.FC<{
  agentId: string;
  account: UsageAccount;
  resetFormat: UsageResetFormat;
  now: number;
}> = ({ agentId, account, resetFormat, now }) => {
  const windows = normalizeUsageWindows(agentId, account);
  const muted = account.stale || windows.length === 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 px-0.5">
        <p className="min-w-0 truncate text-xs font-medium text-neutral-300">
          {shortAccountLabel(account.label) || account.id}
        </p>
        {account.plan && <span className="shrink-0 text-[10px] text-neutral-500">{account.plan}</span>}
      </div>
      {windows.length > 0 ? (
        windows.map((w) => (
          <WindowRow key={w.id} window={w} resetFormat={resetFormat} now={now} muted={muted} />
        ))
      ) : (
        <p className="rounded-md bg-neutral-950/40 px-2.5 py-2 text-[11px] text-neutral-600">No reading yet.</p>
      )}
    </div>
  );
};

const AgentCard: React.FC<{
  agent: AgentUsage;
  hidden: boolean;
  resetFormat: UsageResetFormat;
  now: number;
}> = ({ agent, hidden, resetFormat, now }) => {
  const accounts = agent.accounts ?? [];
  const ownWindows = normalizeUsageWindows(agent.id, agent);
  const hasData = Boolean(agent.asOf) && (ownWindows.length > 0 || accounts.length > 0);
  const isOld = Boolean(agent.asOf) && minutesSince(agent.asOf, now) > STALE_MIN;
  const muted = !hasData || isOld || agent.stale;

  return (
    <article className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/50">
      <div className="flex items-center gap-2.5 px-3 pb-2 pt-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-neutral-800 text-neutral-300">
          {getRegistryIcon("agent", agent.id, 18)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-neutral-100">{labelForAgent(agent.id)}</p>
          <p className="truncate text-[11px] text-neutral-500">
            {!hasData
              ? "Signed in — usage updating…"
              : [agent.plan, agent.asOf ? `updated ${formatAgo(agent.asOf, now)}` : null].filter(Boolean).join(" · ")}
          </p>
        </div>
        {hidden && (
          <span
            className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400"
            title="Turned off below, so it stays out of the top-bar chip and panel."
          >
            Hidden
          </span>
        )}
      </div>
      <div className="space-y-2.5 px-2.5 pb-2.5">
        {accounts.length > 0 || agent.system ? (
          <>
            {accounts.map((a) => (
              <AccountBlock key={a.id} agentId={agent.id} account={a} resetFormat={resetFormat} now={now} />
            ))}
            {/* The System (daemon-home) login pools into the head numbers, so it
                stays visible here for the same reason as in the top-bar panel. */}
            {agent.system && (
              <AccountBlock
                key={agent.system.id}
                agentId={agent.id}
                account={agent.system}
                resetFormat={resetFormat}
                now={now}
              />
            )}
          </>
        ) : ownWindows.length > 0 ? (
          ownWindows.map((w) => (
            <WindowRow key={w.id} window={w} resetFormat={resetFormat} now={now} muted={muted} />
          ))
        ) : (
          <p className="rounded-md bg-neutral-950/40 px-2.5 py-3 text-center text-[11px] text-neutral-600">
            No quota windows reported yet.
          </p>
        )}
      </div>
    </article>
  );
};

const MissingCard: React.FC<{ id: string }> = ({ id }) => (
  <article className="rounded-xl border border-dashed border-neutral-800 bg-neutral-900/30 px-3 py-3">
    <div className="flex items-center gap-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-neutral-800/60 text-neutral-500">
        {getRegistryIcon("agent", id, 18)}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm text-neutral-400">{labelForAgent(id)}</p>
        <p className="text-[11px] leading-snug text-neutral-600">Not logged in — {usageLoginHint(id)}</p>
      </div>
    </div>
  </article>
);

/**
 * The wide usage overview in Settings → Usage: one card per reporting agent in
 * a CSS multi-column masonry (single column on mobile, two from `sm` up — no JS
 * layout, so cards keep their natural height and never scroll sideways).
 *
 * Unlike the top-bar panel this shows every reporting agent, marking the ones
 * switched off below as "Hidden" rather than dropping them — the toggles sit
 * right underneath, so a card vanishing on toggle reads as data loss.
 */
export const UsageOverview: React.FC = () => {
  const usage = useAppStore((s) => s.usage);
  const prefs = useAppStore((s) => s.appConfig.usage);
  const loadUsage = useAppStore((s) => s.loadUsage);
  const [resetFormat, setResetFormat] = useUsageResetFormat();
  const now = useUsageNow();
  const [refreshing, setRefreshing] = React.useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await loadUsage(true);
    } finally {
      setRefreshing(false);
    }
  };

  const agents = (usage?.agents ?? []).filter((a) => a.available);
  const missing = missingUsageAgents(prefs, (usage?.agents ?? []).map((a) => a.id));

  return (
    <section className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm text-neutral-200">Quota overview</p>
          <p className="text-xs text-neutral-500">Read from the active daemon; credentials never leave it.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="inline-flex rounded-md bg-neutral-800/60 p-0.5 text-xs">
            {RESET_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => setResetFormat(o.value)}
                title={`Show reset times as a ${o.label.toLowerCase()}`}
                className={cn(
                  "rounded px-2 py-1 transition-colors",
                  resetFormat === o.value ? "bg-neutral-700 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={refreshing}
            onClick={() => void refresh()}
            aria-label="Refresh usage"
            className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-50"
          >
            {refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </button>
        </div>
      </div>

      {!usage ? (
        /* No snapshot at all: never loaded, the read failed, or the daemon is
           older than this client. Deliberately NOT the per-agent "Not logged
           in" cards — that claim would be fabricated from an absent reading. */
        <p className="rounded-lg border border-neutral-800 px-3 py-4 text-sm text-neutral-500">
          {refreshing
            ? "Reading usage from the daemon…"
            : "No usage reading from this daemon yet. Refresh to retry — an older daemon may not report usage at all."}
        </p>
      ) : agents.length === 0 && missing.length === 0 ? (
        <p className="rounded-lg border border-neutral-800 px-3 py-4 text-sm text-neutral-500">
          No agent is reporting usage yet.
        </p>
      ) : (
        <div className="columns-1 gap-2.5 sm:columns-2">
          {agents.map((a) => (
            <div key={a.id} className="mb-2.5 break-inside-avoid">
              <AgentCard
                agent={a}
                hidden={!usageAgentEnabled(prefs, a.id)}
                resetFormat={resetFormat}
                now={now}
              />
            </div>
          ))}
          {missing.map((id) => (
            <div key={id} className="mb-2.5 break-inside-avoid">
              <MissingCard id={id} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
