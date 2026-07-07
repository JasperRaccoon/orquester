import React from "react";
import { ChevronDown, Gauge, RefreshCw } from "lucide-react";
import type { AgentUsage } from "@orquester/api";
import { AdaptiveMenu } from "../ui";
import { getRegistryIcon } from "../../icons";
import { useAppStore } from "../../store/app";
import { barClass, formatClock, formatCountdown, gaugeClass, pickDriver, windowMax } from "./usage-format";

const AGENT_LABEL: Record<AgentUsage["id"], string> = { claude: "Claude Code", codex: "Codex" };

const Bar: React.FC<{ label: string; window: AgentUsage["session"]; muted: boolean }> = ({ label, window, muted }) => {
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

const AgentSection: React.FC<{ agent: AgentUsage }> = ({ agent }) => (
  <div className="px-3 py-2">
    <div className="flex items-center justify-between">
      <p className="text-sm text-neutral-200">{AGENT_LABEL[agent.id]} Usage</p>
      {agent.plan && <span className="text-xs text-neutral-500">{agent.plan}</span>}
    </div>
    {agent.stale && (
      <p className="text-[11px] text-amber-400">
        {agent.session || agent.weekly ? "Last known — updating…" : "Signed in — usage updating…"}
      </p>
    )}
    <Bar label="Current session (5 hours)" window={agent.session} muted={agent.stale} />
    <Bar label="Current week" window={agent.weekly} muted={agent.stale} />
  </div>
);

export const UsageWidget: React.FC = () => {
  const usage = useAppStore((s) => s.usage);
  const prefs = useAppStore((s) => s.appConfig.usage);
  const loadUsage = useAppStore((s) => s.loadUsage);

  if (!prefs.enabled || !usage) return null;
  const agents = usage.agents.filter((a) => a.available && (a.id === "claude" ? prefs.claude : prefs.codex));
  if (agents.length === 0) return null;

  const driver = pickDriver(agents, prefs.chip);
  if (!driver) return null;

  // Included agents that are enabled in prefs but aren't logged in (so not present
  // in the live snapshot) get a muted, actionable row in the panel.
  const present = new Set(agents.map((a) => a.id));
  const missing = (["claude", "codex"] as const).filter((id) => prefs[id] && !present.has(id));

  const cell = (w: AgentUsage["session"]) => (w ? `${Math.round(w.percent)}%` : "—");
  const chipText = `${cell(driver.session)} • ${cell(driver.weekly)}`;
  const gauge = driver.stale ? "text-neutral-600" : gaugeClass(windowMax(driver));
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
        <span>Updated {formatClock(usage.updatedAt)}</span>
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
      {agents.map((a) => (
        <AgentSection key={a.id} agent={a} />
      ))}
      {missing.map((id) => (
        <div key={id} className="px-3 py-2 text-xs text-neutral-500">
          {AGENT_LABEL[id]} — not logged in <span className="text-neutral-600">(run {id} login)</span>
        </div>
      ))}
    </AdaptiveMenu>
  );
};
