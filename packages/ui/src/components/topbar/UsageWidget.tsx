import React, { useState } from "react";
import { ChevronDown, Gauge, RefreshCw } from "lucide-react";
import type { AgentUsage, UsageAccount, UsageWindow } from "@orquester/api";
import { usageAgentEnabled } from "@orquester/config";
import { AdaptiveMenu } from "../ui";
import { getRegistryIcon } from "../../icons";
import { useAppStore } from "../../store/app";
import { barClass, formatAgo, formatClock, formatCountdown, gaugeClass, minutesSince, pickDriver, windowMax } from "./usage-format";

const AGENT_LABEL: Record<AgentUsage["id"], string> = { claude: "Claude Code", codex: "Codex" };

const Bar: React.FC<{ label: string; window: UsageWindow | null; muted: boolean }> = ({ label, window, muted }) => {
  const pct = window?.percent ?? 0;
  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-neutral-300">{label}</span>
        <span className={muted ? "text-neutral-500" : "text-neutral-200"}>{window ? `${Math.round(pct)}%` : "—"}</span>
      </div>
      <div className="mt-1 h-1.5 w-full rounded-full bg-neutral-800">
        <div
          className={`h-full rounded-full ${muted ? "bg-neutral-600" : barClass(pct)}`}
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
      <p className="mt-1 text-[11px] text-neutral-500">{formatCountdown(window?.resetsAt, Date.now())}</p>
    </div>
  );
};

/** A reading older than this reads as stale in the panel. */
const STALE_MIN = 10;

const AccountRow: React.FC<{ account: UsageAccount }> = ({ account }) => {
  const muted = account.stale || !(account.session || account.weekly);
  return (
    <div className="border-t border-neutral-800/80 py-1.5 pl-2">
      <p className="truncate text-[11px] text-neutral-400">{account.label ?? account.id}</p>
      <Bar label="5h" window={account.session} muted={muted} />
      <Bar label="Week" window={account.weekly} muted={muted} />
    </div>
  );
};

const AgentSection: React.FC<{ agent: AgentUsage; view: "aggregate" | "accounts" }> = ({ agent, view }) => {
  const hasTimestamp = Boolean(agent.asOf);
  const hasData = hasTimestamp && (agent.session || agent.weekly || (agent.accounts && agent.accounts.length > 0));
  const isOld = hasTimestamp && minutesSince(agent.asOf, Date.now()) > STALE_MIN;
  const muted = !hasData || isOld;
  const multi = (agent.accounts?.length ?? 0) > 0;
  const showAccounts = multi && view === "accounts";

  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm text-neutral-200">
          {getRegistryIcon("agent", agent.id, 14)}
          <span>{AGENT_LABEL[agent.id]} Usage</span>
        </p>
        {agent.plan && <span className="text-xs text-neutral-500">{agent.plan}</span>}
      </div>
      {!hasData ? (
        <p className="text-[11px] text-amber-400">Signed in — usage updating…</p>
      ) : isOld ? (
        <p className="text-[11px] text-amber-400">Updated {formatAgo(agent.asOf, Date.now())}</p>
      ) : null}
      {multi && (
        <p className="mt-1 text-[11px] text-neutral-500">
          {agent.aggregate?.accountCount ?? agent.accounts!.length} accounts ·{" "}
          {view === "aggregate" ? "pooled" : "per account"}
        </p>
      )}
      {!showAccounts && (
        <>
          <Bar label="Current session (5 hours)" window={agent.session} muted={muted} />
          <Bar label="Current week" window={agent.weekly} muted={muted} />
        </>
      )}
      {showAccounts && agent.accounts!.map((a) => <AccountRow key={a.id} account={a} />)}
    </div>
  );
};

export const UsageWidget: React.FC = () => {
  const usage = useAppStore((s) => s.usage);
  const prefs = useAppStore((s) => s.appConfig.usage);
  const loadUsage = useAppStore((s) => s.loadUsage);
  const updateAppConfig = useAppStore((s) => s.updateAppConfig);
  const [localView, setLocalView] = useState<"aggregate" | "accounts" | null>(null);

  if (!prefs.enabled || !usage) return null;
  const agents = usage.agents.filter((a) => a.available && usageAgentEnabled(prefs, a.id));
  if (agents.length === 0) return null;

  const driver = pickDriver(agents, prefs.chip);
  if (!driver) return null;

  const view = localView ?? prefs.view ?? "aggregate";
  const hasMulti = agents.some((a) => (a.accounts?.length ?? 0) > 0);

  // Included agents that are enabled in prefs but aren't logged in (so not present
  // in the live snapshot) get a muted, actionable row in the panel.
  const present = new Set(agents.map((a) => a.id));
  const missing = (["claude", "codex"] as const).filter(
    (id) => usageAgentEnabled(prefs, id) && !present.has(id)
  );
  // Honest "as of": the most recent successful reading among the shown agents.
  const freshestAsOf = agents
    .map((a) => a.asOf)
    .filter((x): x is string => !!x)
    .sort()
    .at(-1);

  const cell = (w: AgentUsage["session"]) => (w ? `${Math.round(w.percent)}%` : "—");
  const chipText = `${cell(driver.session)} • ${cell(driver.weekly)}`;
  // Color by usage level whenever we have a number (even if stale — the value is
  // still real); grey only when there's no reading yet.
  const gauge = driver.session || driver.weekly ? gaugeClass(windowMax(driver)) : "text-neutral-600";
  const trigger = (
    <span className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-neutral-300 hover:bg-neutral-800">
      {getRegistryIcon("agent", driver.id, 13)}
      <Gauge size={13} className={gauge} />
      <span>{chipText}</span>
      <ChevronDown size={13} className="text-neutral-500" />
    </span>
  );

  return (
    <AdaptiveMenu title="Usage" trigger={trigger} align="right" width="w-72">
      <div className="flex items-center justify-between px-3 pt-2 text-[11px] text-neutral-500">
        <span>{freshestAsOf ? `Updated ${formatClock(freshestAsOf)}` : "Updating…"}</span>
        <button
          type="button"
          className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          onClick={(e) => {
            e.stopPropagation();
            void loadUsage(true);
          }}
          aria-label="Refresh usage"
        >
          <RefreshCw size={13} />
        </button>
      </div>
      {hasMulti && (
        <div className="flex gap-1 px-3 pt-1">
          {(
            [
              ["aggregate", "Aggregated"],
              ["accounts", "Per account"]
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`rounded px-2 py-0.5 text-[11px] ${
                view === id ? "bg-neutral-700 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"
              }`}
              onClick={(e) => {
                e.stopPropagation();
                setLocalView(id);
                void updateAppConfig({ usage: { ...prefs, view: id } });
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {agents.map((a) => (
        <AgentSection key={a.id} agent={a} view={view} />
      ))}
      {missing.map((id) => (
        <div key={id} className="px-3 py-2 text-xs text-neutral-500">
          {AGENT_LABEL[id]} — not logged in <span className="text-neutral-600">(run {id} login)</span>
        </div>
      ))}
    </AdaptiveMenu>
  );
};
