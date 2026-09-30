import React from "react";
import { Gauge, Loader2, RefreshCw } from "lucide-react";
import type { AgentUsage, ProviderUsageWindow, UsageAccount } from "@orquester/api";
import { usageAgentEnabled } from "@orquester/config";
import { cn } from "../../lib/cn";
import { shortAccountLabel } from "../../lib/account-label";
import type { UsageResetFormat } from "../../lib/usage-display";
import { getRegistryIcon } from "../../icons";
import { useUsageNow, useUsageResetFormat } from "../../hooks";
import { useAppStore } from "../../store/app";
import { Button } from "../ui";
import { Badge, EmptyState, SettingsCard } from "./primitives";
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
  providerWindowsToNormalized,
  usageLoginHint,
  type NormalizedUsageWindow
} from "../topbar/usage-format";

/** Stable empty slice, so an agent with no live windows never churns props. */
const NO_PROVIDER_WINDOWS: readonly ProviderUsageWindow[] = [];

/** Same surface as `SettingsCard`, so the quota cards sit in the page's family. */
const CARD = "overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/40";

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
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-xs text-neutral-400">{window.longLabel}</span>
        <span
          className={cn(
            "shrink-0 text-sm font-semibold tabular-nums",
            muted ? "text-neutral-500" : "text-neutral-100"
          )}
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
        <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-[11px] text-neutral-500">
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
    <div className="space-y-2.5 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-xs font-medium text-neutral-200">
          {shortAccountLabel(account.label) || account.id}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          {account.stale && windows.length > 0 && <Badge tone="warn">Stale</Badge>}
          {account.plan && <Badge>{account.plan}</Badge>}
        </div>
      </div>
      {windows.length > 0 ? (
        windows.map((w) => <WindowRow key={w.id} window={w} resetFormat={resetFormat} now={now} muted={muted} />)
      ) : (
        <p className="text-[11px] text-neutral-500">No reading yet.</p>
      )}
    </div>
  );
};

const AgentCard: React.FC<{
  agent: AgentUsage;
  hidden: boolean;
  resetFormat: UsageResetFormat;
  now: number;
  /** Merged `account.rate-limits.updated` windows for this agent (§7.7). */
  liveWindows: readonly ProviderUsageWindow[];
}> = ({ agent, hidden, resetFormat, now, liveWindows }) => {
  const accounts = agent.accounts ?? [];
  const pollWindows = normalizeUsageWindows(agent.id, agent);
  // Windows an open chat thread reported through `account.rate-limits.updated`
  // (§7.7). They merge by window id — already done in the store — and anything
  // the daemon's own poll covers is dropped here rather than printed twice with
  // two slightly different readings.
  const providerWindows = providerWindowsToNormalized(
    agent.id,
    liveWindows,
    // The daemon's snapshot slots its pools as "session" / "weekly"; a provider
    // window with either of those ids is the same pool by another route.
    pollWindows.map((w) => w.id)
  );
  const ownWindows = [...pollWindows, ...providerWindows];
  const hasData = Boolean(agent.asOf) && (ownWindows.length > 0 || accounts.length > 0);
  const isOld = Boolean(agent.asOf) && minutesSince(agent.asOf, now) > STALE_MIN;
  const muted = !hasData || isOld || agent.stale;

  return (
    <article className={CARD}>
      <header className="flex items-center gap-3 px-4 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-neutral-800/80 text-neutral-300">
          {getRegistryIcon("agent", agent.id, 18)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <p className="truncate text-sm font-medium text-neutral-100">{labelForAgent(agent.id)}</p>
            {agent.plan && <Badge>{agent.plan}</Badge>}
          </div>
          <p className="truncate text-[11px] text-neutral-500">
            {!hasData
              ? "Signed in — usage updating…"
              : agent.asOf
                ? `Updated ${formatAgo(agent.asOf, now)}`
                : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {hasData && (isOld || agent.stale) && (
            <Badge
              tone="warn"
              title={
                agent.stale
                  ? "The token or log behind this reading has expired; showing the last-known numbers."
                  : `No fresh reading for over ${STALE_MIN} minutes; showing the last-known numbers.`
              }
            >
              Stale
            </Badge>
          )}
          {hidden && <Badge title="Turned off below, so it stays out of the top-bar chip and panel.">Hidden</Badge>}
        </div>
      </header>
      <div className="divide-y divide-neutral-800/60 border-t border-neutral-800/80">
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
            {/* A pooling agent still gets its live provider windows: they are
                per credential, not per account, so they sit below the blocks
                rather than inside one. */}
            {providerWindows.length > 0 && (
              <div className="space-y-3 px-4 py-3">
                {providerWindows.map((w) => (
                  <WindowRow key={w.id} window={w} resetFormat={resetFormat} now={now} muted={muted} />
                ))}
              </div>
            )}
          </>
        ) : ownWindows.length > 0 ? (
          <div className="space-y-3 px-4 py-3">
            {ownWindows.map((w) => (
              <WindowRow key={w.id} window={w} resetFormat={resetFormat} now={now} muted={muted} />
            ))}
          </div>
        ) : (
          <p className="px-4 py-4 text-center text-[11px] text-neutral-500">No quota windows reported yet.</p>
        )}
      </div>
    </article>
  );
};

const MissingCard: React.FC<{ id: string }> = ({ id }) => (
  <article className="rounded-xl border border-dashed border-neutral-800 px-4 py-3">
    <div className="flex items-start gap-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-neutral-800/60 text-neutral-500">
        {getRegistryIcon("agent", id, 18)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <p className="truncate text-sm font-medium text-neutral-400">{labelForAgent(id)}</p>
          <Badge>Not logged in</Badge>
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-neutral-500">To see its quota, {usageLoginHint(id)}.</p>
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
 *
 * The refresh control and reset-time format live in the page header
 * (`UsageSettings`), which owns the refresh state and passes it down so the
 * empty state can say "reading…" instead of "no reading".
 */
export const UsageOverview: React.FC<{
  refreshing: boolean;
  onRefresh: () => void;
}> = ({ refreshing, onRefresh }) => {
  const usage = useAppStore((s) => s.usage);
  const prefs = useAppStore((s) => s.appConfig.usage);
  const providerRateLimits = useAppStore((s) => s.providerRateLimits);
  // Shared, persisted display format — the header's picker writes the same store.
  const [resetFormat] = useUsageResetFormat();
  const now = useUsageNow();

  const agents = (usage?.agents ?? []).filter((a) => a.available);
  const missing = missingUsageAgents(prefs, (usage?.agents ?? []).map((a) => a.id));

  if (!usage) {
    /* No snapshot at all: never loaded, the read failed, or the daemon is
       older than this client. Deliberately NOT the per-agent "Not logged
       in" cards — that claim would be fabricated from an absent reading. */
    return (
      <SettingsCard>
        {refreshing ? (
          <EmptyState
            icon={<Loader2 size={18} className="animate-spin" />}
            title="Reading usage from the daemon…"
          />
        ) : (
          <EmptyState
            icon={<Gauge size={18} />}
            title="No usage reading from this daemon yet"
            description="Refresh to retry — an older daemon may not report usage at all."
            action={
              <Button size="sm" variant="outline" onClick={onRefresh}>
                <RefreshCw size={13} /> Refresh
              </Button>
            }
          />
        )}
      </SettingsCard>
    );
  }

  if (agents.length === 0 && missing.length === 0) {
    return (
      <SettingsCard>
        <EmptyState
          icon={<Gauge size={18} />}
          title="No agent is reporting usage yet"
        />
      </SettingsCard>
    );
  }

  return (
    <div className="columns-1 gap-3 sm:columns-2">
      {agents.map((a) => (
        <div key={a.id} className="mb-3 break-inside-avoid">
          <AgentCard
            agent={a}
            hidden={!usageAgentEnabled(prefs, a.id)}
            resetFormat={resetFormat}
            now={now}
            liveWindows={providerRateLimits[a.id] ?? NO_PROVIDER_WINDOWS}
          />
        </div>
      ))}
      {missing.map((id) => (
        <div key={id} className="mb-3 break-inside-avoid">
          <MissingCard id={id} />
        </div>
      ))}
    </div>
  );
};
