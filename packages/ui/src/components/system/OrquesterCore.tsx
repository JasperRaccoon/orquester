import React from "react";
import { Bot, Boxes, Layers, Server, type LucideIcon } from "lucide-react";
import type { SystemProcessInfo, SystemProcessRole, SystemProcessesResponse } from "@orquester/api";
import { cn } from "../../lib/cn";
import { coreProcesses, managedTotals } from "./process-table";
import { formatBytes, formatCpu, formatDuration } from "./system-format";

export const ROLE_LABEL: Record<SystemProcessRole, string> = {
  daemon: "Daemon",
  "agent-host": "Agent host",
  tmux: "Session server"
};

export const ROLE_ICON: Record<SystemProcessRole, LucideIcon> = {
  daemon: Server,
  "agent-host": Bot,
  tmux: Layers
};

const ROLE_ABOUT: Record<SystemProcessRole, string> = {
  daemon: "Serves this app, owns sessions, files, git and workflows.",
  "agent-host": "Runs the agent CLIs behind every chat thread.",
  tmux: "Keeps terminal sessions alive across daemon restarts."
};

/** Healthy unless the kernel says it is stopped or a zombie. */
function health(proc: SystemProcessInfo | undefined): { tone: "ok" | "warn" | "danger"; label: string } {
  if (!proc) return { tone: "danger", label: "Not running" };
  if (proc.state === "zombie") return { tone: "danger", label: "Zombie" };
  if (proc.state === "stopped") return { tone: "warn", label: "Stopped" };
  return { tone: "ok", label: "Running" };
}

const DOT: Record<"ok" | "warn" | "danger", string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger"
};

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="min-w-0">
    <p className="text-[10px] text-neutral-500">{label}</p>
    <p className="truncate text-xs font-medium tabular-nums text-neutral-200">{value}</p>
  </div>
);

const CoreCard: React.FC<{
  role: SystemProcessRole;
  proc: SystemProcessInfo | undefined;
  now: number;
  selected: boolean;
  onSelect: (pid: number) => void;
}> = ({ role, proc, now, selected, onSelect }) => {
  const Icon = ROLE_ICON[role];
  const status = health(proc);
  return (
    <button
      type="button"
      disabled={!proc}
      onClick={() => proc && onSelect(proc.pid)}
      title={proc ? `${ROLE_ABOUT[role]} Show PID ${proc.pid} in the process list.` : ROLE_ABOUT[role]}
      className={cn(
        "group relative flex min-w-0 flex-col gap-2.5 overflow-hidden rounded-xl border px-3.5 py-3 text-left transition-colors",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-info",
        selected
          ? "border-info/60 bg-info-soft/25"
          : "border-info-900/50 bg-info-soft/10 hover:border-info-900 hover:bg-info-soft/20",
        !proc && "cursor-default border-danger-900/60 bg-danger-soft/15"
      )}
    >
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-0.5", proc ? "bg-info" : "bg-danger")} />
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-info-soft/40 text-info">
          <Icon size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-neutral-100">{ROLE_LABEL[role]}</p>
          <p className="truncate text-[10px] tabular-nums text-neutral-500">{proc ? `PID ${proc.pid}` : "—"}</p>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-neutral-400">
          <span className={cn("h-1.5 w-1.5 rounded-full", DOT[status.tone])} />
          {status.label}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="CPU" value={formatCpu(proc?.cpuPercent)} />
        <Stat label="Memory" value={proc ? formatBytes(proc.rssBytes) : "—"} />
        <Stat label="Uptime" value={proc?.startedAt ? formatDuration((now - proc.startedAt) / 1000) : "—"} />
      </div>
    </button>
  );
};

/**
 * The processes Orquester cannot work without — the daemon and the agent host
 * (and the tmux server, where sessions run under one) — pinned above the
 * table so no sort or filter can push them out of sight, plus the footprint of
 * everything the daemon runs. Clicking a card selects that row in the table.
 */
export const OrquesterCore: React.FC<{
  snapshot: SystemProcessesResponse;
  selectedPid: number | null;
  onSelect: (pid: number) => void;
}> = ({ snapshot, selectedPid, onSelect }) => {
  const core = coreProcesses(snapshot.processes, snapshot.daemonPid);
  const totals = managedTotals(snapshot.processes);
  const now = Date.now();
  // A daemon that predates role tags (and the `managed` flag that came with
  // them) cannot name its agent host; a "Not running" card would be a lie.
  const tagsRoles = snapshot.processes.some((proc) => proc.managed !== undefined);
  const roles: SystemProcessRole[] = ["daemon"];
  if (tagsRoles) roles.push("agent-host");
  if (core.tmux) roles.push("tmux");

  return (
    <div
      className={cn(
        "grid gap-2 sm:grid-cols-2",
        roles.length === 3 ? "xl:grid-cols-4" : roles.length === 2 ? "xl:grid-cols-3" : "xl:grid-cols-2"
      )}
    >
      {roles.map((role) => (
        <CoreCard
          key={role}
          role={role}
          proc={core[role]}
          now={now}
          selected={core[role] !== undefined && core[role]?.pid === selectedPid}
          onSelect={onSelect}
        />
      ))}
      <div className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-neutral-800 bg-neutral-900/40 px-3.5 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-neutral-800 text-neutral-400">
            <Boxes size={15} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-neutral-100">Orquester total</p>
            <p className="truncate text-[10px] text-neutral-500">Sessions, agents, children</p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Processes" value={String(totals.count)} />
          <Stat label="CPU" value={formatCpu(totals.cpuPercent)} />
          <Stat label="Memory" value={formatBytes(totals.rssBytes)} />
        </div>
      </div>
    </div>
  );
};
