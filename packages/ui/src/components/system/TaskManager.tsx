import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Columns3,
  Copy,
  Info,
  Loader2,
  MoreHorizontal,
  Search,
  X
} from "lucide-react";
import type {
  SystemPortsResponse,
  SystemProcessInfo,
  SystemProcessState,
  SystemProcessesResponse
} from "@orquester/api";
import { useApi } from "../../context/orquester-context";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { ConfirmDialog, ContextMenu, Dropdown, DropdownItem, DropdownLabel, type ContextMenuItem } from "../ui";
import { Badge, SegmentedControl } from "../settings/primitives";
import { ROLE_LABEL } from "./OrquesterCore";
import { ProcessIcon } from "./ProcessIcon";
import { SessionChip } from "./SessionChip";
import {
  PROCESS_COLUMNS,
  buildRows,
  canStop,
  defaultDirection,
  descendantCount,
  filterProcesses,
  isManaged,
  parseColumns,
  processRowKey,
  processUsers,
  type ProcessColumn,
  type ProcessGrouping,
  type ProcessScope,
  type ProcessSort,
  type ProcessSortKey,
  type RowMetrics,
  type TableRow
} from "./process-table";
import {
  formatByteRate,
  formatBytes,
  formatCpu,
  formatDuration,
  killErrorCode,
  killErrorMessage,
  processLabel
} from "./system-format";

const COLUMNS_KEY = "orquester:host-status-columns";

function loadColumns(): ProcessColumn[] {
  try {
    return parseColumns(typeof localStorage === "undefined" ? null : localStorage.getItem(COLUMNS_KEY));
  } catch {
    return parseColumns(null);
  }
}

function saveColumns(columns: readonly ProcessColumn[]): void {
  try {
    localStorage.setItem(COLUMNS_KEY, JSON.stringify(columns));
  } catch {
    // Storage full or disabled: the choice lasts for this page view only.
  }
}

const COLUMN_META: Record<ProcessColumn, { label: string; width: string; numeric: boolean }> = {
  status: { label: "Status", width: "w-[6.5rem]", numeric: false },
  cpu: { label: "CPU", width: "w-[5.5rem]", numeric: true },
  memory: { label: "Memory", width: "w-[6.5rem]", numeric: true },
  disk: { label: "Disk", width: "w-[6rem]", numeric: true },
  pid: { label: "PID", width: "w-[5rem]", numeric: true },
  threads: { label: "Threads", width: "w-[4.5rem]", numeric: true },
  user: { label: "User", width: "w-[6.5rem]", numeric: false },
  uptime: { label: "Uptime", width: "w-[5.5rem]", numeric: true }
};

const STATE_META: Record<SystemProcessState, { label: string; className: string }> = {
  running: { label: "Running", className: "bg-ok-soft/40 text-ok" },
  sleeping: { label: "Sleeping", className: "bg-neutral-800 text-neutral-400" },
  idle: { label: "Idle", className: "bg-neutral-800 text-neutral-500" },
  "disk-wait": { label: "Disk wait", className: "bg-warn-soft/40 text-warn" },
  stopped: { label: "Stopped", className: "bg-warn-soft/40 text-warn" },
  zombie: { label: "Zombie", className: "bg-danger-soft/50 text-danger" },
  other: { label: "Other", className: "bg-neutral-800 text-neutral-500" }
};

const STATES = Object.keys(STATE_META) as SystemProcessState[];

/**
 * Heat for a per-process share of the machine: the usage ramp's colour at a
 * low alpha that deepens with the value. Thresholds are per-process scale —
 * one pegged core of a 12-core box is 8%, which already deserves attention.
 */
function heat(percent: number | null, [moderate, high, critical]: readonly [number, number, number]): {
  color: string;
  alpha: number;
} | null {
  if (percent == null || percent < 0.5) return null;
  const color =
    percent >= critical
      ? "var(--usage-crit)"
      : percent >= high
        ? "var(--usage-high)"
        : percent >= moderate
          ? "var(--usage-med)"
          : "var(--usage-ok)";
  return { color, alpha: Math.round(6 + Math.min(1, percent / critical) * 22) };
}

const CPU_SCALE = [5, 20, 50] as const;
const MEMORY_SCALE = [3, 10, 25] as const;

/** A numeric cell with a heat wash and a thin share-of-machine bar under the number. */
const HeatCell: React.FC<{ text: string; percent: number | null; scale: readonly [number, number, number]; title?: string }> = ({
  text,
  percent,
  scale,
  title
}) => {
  const tint = heat(percent, scale);
  return (
    <td
      className="px-2 py-1.5 text-right align-middle"
      title={title}
      style={tint ? { backgroundColor: `color-mix(in srgb, ${tint.color} ${tint.alpha}%, transparent)` } : undefined}
    >
      <span className={cn("text-xs tabular-nums", percent == null ? "text-neutral-600" : "text-neutral-200")}>{text}</span>
      <span className="mt-1 block h-0.5 w-full overflow-hidden rounded-full bg-neutral-800/80">
        {tint && (
          <span
            className="block h-full rounded-full"
            style={{ width: `${Math.max(3, Math.min(100, percent ?? 0))}%`, backgroundColor: tint.color }}
          />
        )}
      </span>
    </td>
  );
};

const StatePill: React.FC<{ state: SystemProcessState | undefined }> = ({ state }) =>
  state ? (
    <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium", STATE_META[state].className)}>
      {STATE_META[state].label}
    </span>
  ) : (
    <span className="text-xs text-neutral-600">—</span>
  );

const INDENT_PX = 16;

interface RowCallbacks {
  onSelect: (pid: number) => void;
  onToggle: (key: string) => void;
  onMenu: (proc: SystemProcessInfo, x: number, y: number) => void;
}

/** Metric cells shared by process rows and name-group rows, in column order. */
function metricCells(
  metrics: RowMetrics,
  columns: readonly ProcessColumn[],
  memoryTotal: number,
  now: number,
  diskTitle?: string
): React.ReactNode[] {
  return columns.map((column) => {
    switch (column) {
      case "status":
        return (
          <td key={column} className="px-2 py-1.5">
            <StatePill state={metrics.state} />
          </td>
        );
      case "cpu":
        return <HeatCell key={column} text={formatCpu(metrics.cpuPercent)} percent={metrics.cpuPercent} scale={CPU_SCALE} />;
      case "memory":
        return (
          <HeatCell
            key={column}
            text={formatBytes(metrics.rssBytes)}
            percent={memoryTotal > 0 ? (metrics.rssBytes / memoryTotal) * 100 : null}
            scale={MEMORY_SCALE}
            title={memoryTotal > 0 ? `${((metrics.rssBytes / memoryTotal) * 100).toFixed(1)}% of memory` : undefined}
          />
        );
      case "disk":
        return (
          <td
            key={column}
            title={metrics.diskBps == null ? diskTitle : undefined}
            className={cn("px-2 py-1.5 text-right text-xs tabular-nums", metrics.diskBps ? "text-neutral-200" : "text-neutral-600")}
          >
            {formatByteRate(metrics.diskBps)}
          </td>
        );
      case "pid":
        return (
          <td key={column} className="px-2 py-1.5 text-right text-xs tabular-nums text-neutral-400">
            {metrics.pid}
          </td>
        );
      case "threads":
        return (
          <td key={column} className="px-2 py-1.5 text-right text-xs tabular-nums text-neutral-400">
            {metrics.threads ?? "—"}
          </td>
        );
      case "user":
        return (
          <td key={column} className="truncate px-2 py-1.5 text-xs text-neutral-400" title={metrics.user}>
            {metrics.user ?? "—"}
          </td>
        );
      case "uptime":
        return (
          <td key={column} className="px-2 py-1.5 text-right text-xs tabular-nums text-neutral-400">
            {metrics.startedAt === undefined ? "—" : formatDuration((now - metrics.startedAt) / 1000)}
          </td>
        );
    }
  });
}

const ProcessRow: React.FC<
  RowCallbacks & {
    row: Extract<TableRow, { kind: "process" }>;
    columns: readonly ProcessColumn[];
    memoryTotal: number;
    now: number;
    selected: boolean;
    busy: boolean;
  }
> = ({ row, columns, memoryTotal, now, selected, busy, onSelect, onToggle, onMenu }) => {
  const { proc } = row;
  const core = proc.role !== undefined;
  return (
    <tr
      data-pid={proc.pid}
      tabIndex={0}
      aria-selected={selected}
      onClick={() => onSelect(proc.pid)}
      // Keyboard navigation selects as it moves. Focus that bubbled up from a
      // control inside the row (chevron, actions, session chip) must not: a
      // mousedown focuses the button before its click can stop propagating.
      onFocus={(event) => {
        if (event.target === event.currentTarget) onSelect(proc.pid);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(proc, event.clientX, event.clientY);
      }}
      className={cn(
        "group relative cursor-default border-b border-neutral-800/60 outline-none last:border-b-0",
        "focus-visible:bg-neutral-800/60",
        selected ? "bg-neutral-800/70" : core ? "bg-info-soft/10 hover:bg-info-soft/20" : "hover:bg-neutral-800/35",
        !isManaged(proc) && !selected && "text-neutral-400"
      )}
    >
      <td className="relative py-1.5 pl-2 pr-2">
        {core && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-info" />}
        <div className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: row.depth * INDENT_PX }}>
          <button
            type="button"
            tabIndex={-1}
            disabled={row.childCount === 0}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(processRowKey(proc.pid));
            }}
            aria-label={row.expanded ? `Collapse ${proc.name}` : `Expand ${proc.name}`}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-neutral-500 hover:text-neutral-200 disabled:invisible"
          >
            {row.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          <ProcessIcon proc={proc} />
          <span className={cn("shrink-0 text-xs font-medium", isManaged(proc) ? "text-neutral-100" : "text-neutral-300")}>
            {proc.name}
          </span>
          {row.childCount > 0 && !row.expanded && (
            <span className="shrink-0 text-[10px] tabular-nums text-neutral-500">+{row.childCount}</span>
          )}
          {proc.role && (
            <Badge tone="info" className="py-0">
              {ROLE_LABEL[proc.role]}
            </Badge>
          )}
          <span className="min-w-0 truncate text-[11px] text-neutral-500" title={proc.cmdline}>
            {proc.cmdline}
          </span>
          {proc.sessionId && (
            <span className="ml-auto shrink-0" onClick={(event) => event.stopPropagation()}>
              <SessionChip sessionId={proc.sessionId} />
            </span>
          )}
        </div>
      </td>
      {metricCells(
        row.metrics,
        columns,
        memoryTotal,
        now,
        isManaged(proc) ? "Not measured yet" : "Only readable for processes owned by the daemon's user"
      )}
      <td className="w-9 px-1 py-1.5 text-right">
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Actions for ${processLabel(proc)}`}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            onMenu(proc, rect.right - 192, rect.bottom + 4);
          }}
          className={cn(
            "rounded p-1 text-neutral-500 hover:bg-neutral-700/60 hover:text-neutral-100",
            "md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100",
            (selected || busy) && "md:opacity-100"
          )}
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <MoreHorizontal size={13} />}
        </button>
      </td>
    </tr>
  );
};

const GroupRow: React.FC<{
  row: Extract<TableRow, { kind: "group" }>;
  columns: readonly ProcessColumn[];
  memoryTotal: number;
  now: number;
  onToggle: (key: string) => void;
}> = ({ row, columns, memoryTotal, now, onToggle }) => (
  <tr
    tabIndex={0}
    aria-expanded={row.expanded}
    onClick={() => onToggle(row.key)}
    onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onToggle(row.key);
      }
    }}
    className="cursor-pointer border-b border-neutral-800/60 outline-none hover:bg-neutral-800/35 focus-visible:bg-neutral-800/60"
  >
    <td className="py-1.5 pl-2 pr-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-neutral-500">
          {row.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        {/* A group shares a name, so its first member's logo is everyone's — without
            the role icon one Orquester member would lend the whole group. */}
        <ProcessIcon proc={{ ...row.procs[0], role: undefined }} />
        <span className="truncate text-xs font-medium text-neutral-100">{row.name}</span>
        <span className="shrink-0 rounded bg-neutral-800 px-1.5 text-[10px] tabular-nums text-neutral-400">
          {row.procs.length}
        </span>
      </div>
    </td>
    {metricCells(row.metrics, columns, memoryTotal, now).map((cell, index) =>
      // A group has many pids; its lowest one would read as the group's own.
      columns[index] === "pid" ? (
        <td key="pid" className="px-2 py-1.5 text-right text-[11px] text-neutral-600">
          {row.procs.length} pids
        </td>
      ) : (
        cell
      )
    )}
    <td className="w-9" />
  </tr>
);

const SortHeader: React.FC<{
  column: ProcessSortKey;
  label: string;
  numeric: boolean;
  sort: ProcessSort;
  onSort: (key: ProcessSortKey) => void;
  className?: string;
}> = ({ column, label, numeric, sort, onSort, className }) => {
  const active = sort.key === column;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}
      className={cn("sticky top-0 z-10 bg-neutral-900 p-0 font-medium", className)}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          "flex w-full items-center gap-1 px-2 py-2 text-[11px] transition-colors",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500",
          numeric ? "justify-end" : "justify-start",
          active ? "text-neutral-100" : "text-neutral-500 hover:text-neutral-200"
        )}
      >
        {label}
        {active ? (
          sort.direction === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />
        ) : (
          <ArrowDown size={11} className="opacity-0" />
        )}
      </button>
    </th>
  );
};

const selectClass = cn(
  "h-8 rounded-md border border-neutral-800 bg-neutral-900 px-2 text-xs text-neutral-300",
  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
);

const Detail: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="min-w-0">
    <dt className="text-[10px] text-neutral-500">{label}</dt>
    <dd className="truncate text-xs tabular-nums text-neutral-200">{children}</dd>
  </div>
);

const ProcessDetails: React.FC<{
  proc: SystemProcessInfo;
  daemonPid: number;
  parent: SystemProcessInfo | undefined;
  ports: SystemPortsResponse | null;
  now: number;
  busy: boolean;
  onSelect: (pid: number) => void;
  onStop: (proc: SystemProcessInfo) => void;
  onClose: () => void;
}> = ({ proc, daemonPid, parent, ports, now, busy, onSelect, onStop, onClose }) => {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [proc.pid]);
  const listening = ports?.ports.filter((entry) => entry.pid === proc.pid) ?? [];
  const stoppable = canStop(proc, daemonPid);
  return (
    <section
      aria-label={`Details for ${processLabel(proc)}`}
      className={cn(
        "space-y-3 rounded-xl border bg-neutral-900/60 px-4 py-3",
        proc.role ? "border-info-900/60" : "border-neutral-800"
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ProcessIcon proc={proc} size={16} />
        <h4 className="text-sm font-medium text-neutral-100">{proc.name}</h4>
        <span className="text-xs tabular-nums text-neutral-500">PID {proc.pid}</span>
        {proc.role && <Badge tone="info">{ROLE_LABEL[proc.role]}</Badge>}
        <StatePill state={proc.state} />
        {proc.sessionId && <SessionChip sessionId={proc.sessionId} />}
        <div className="ml-auto flex items-center gap-1.5">
          {stoppable && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onStop(proc)}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-danger-900/60 px-2.5 text-xs text-danger hover:bg-danger-soft/30 disabled:opacity-50"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
              Stop process
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close details"
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4 lg:grid-cols-6">
        <Detail label="CPU">{formatCpu(proc.cpuPercent)}</Detail>
        <Detail label="Memory">{formatBytes(proc.rssBytes)}</Detail>
        <Detail label="Disk read">{formatByteRate(proc.diskReadBps)}</Detail>
        <Detail label="Disk write">{formatByteRate(proc.diskWriteBps)}</Detail>
        <Detail label="Threads">{proc.threads ?? "—"}</Detail>
        <Detail label="User">{proc.user ?? "—"}</Detail>
        <Detail label="Parent">
          {parent ? (
            <button type="button" onClick={() => onSelect(parent.pid)} className="truncate text-left hover:text-info hover:underline">
              {parent.name} ({parent.pid})
            </button>
          ) : (
            proc.ppid || "—"
          )}
        </Detail>
        <Detail label="Started">
          {proc.startedAt ? (
            <span title={new Date(proc.startedAt).toLocaleString()}>{formatDuration((now - proc.startedAt) / 1000)} ago</span>
          ) : (
            "—"
          )}
        </Detail>
        <Detail label="Listening on">
          {listening.length > 0 ? listening.map((entry) => `${entry.address}:${entry.port}`).join(", ") : "—"}
        </Detail>
        <Detail label="Started by Orquester">{isManaged(proc) ? "Yes" : "No — view only"}</Detail>
      </dl>

      <div className="flex items-start gap-2 rounded-lg bg-neutral-950/60 px-2.5 py-2">
        <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-neutral-300">
          {proc.cmdline}
        </code>
        <button
          type="button"
          onClick={() => {
            void copyText(proc.cmdline);
            setCopied(true);
          }}
          aria-label="Copy command line"
          title="Copy command line"
          className="shrink-0 rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
        >
          {copied ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
        </button>
      </div>
    </section>
  );
};

/**
 * Settings → Host status' process table: every process on the host, sortable
 * by any column, filterable, flat / as a tree / grouped by name, with a details
 * panel and a guarded Stop for the processes the daemon manages. Stop is a
 * SIGTERM of the whole subtree and is always confirmed first.
 */
export const TaskManager: React.FC<{
  snapshot: SystemProcessesResponse;
  ports: SystemPortsResponse | null;
  memoryTotal: number;
  selectedPid: number | null;
  onSelect: (pid: number | null) => void;
  onChanged: () => void;
}> = ({ snapshot, ports, memoryTotal, selectedPid, onSelect, onChanged }) => {
  const api = useApi();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ProcessScope>("all");
  const [user, setUser] = useState<string | null>(null);
  const [state, setState] = useState<SystemProcessState | null>(null);
  const [grouping, setGrouping] = useState<ProcessGrouping>("none");
  const [sort, setSort] = useState<ProcessSort>({ key: "cpu", direction: "desc" });
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  const [columns, setColumns] = useState<ProcessColumn[]>(loadColumns);
  const [menu, setMenu] = useState<{ proc: SystemProcessInfo; x: number; y: number } | null>(null);
  const [pending, setPending] = useState<SystemProcessInfo | null>(null);
  const [busyPid, setBusyPid] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  const users = useMemo(() => processUsers(snapshot.processes), [snapshot.processes]);
  const visible = useMemo(
    () => filterProcesses(snapshot.processes, { query, scope, user, state }),
    [snapshot.processes, query, scope, user, state]
  );
  const rows = useMemo(() => buildRows(visible, grouping, sort, toggled), [visible, grouping, sort, toggled]);
  const byPid = useMemo(() => new Map(snapshot.processes.map((proc) => [proc.pid, proc])), [snapshot.processes]);
  const selected = selectedPid === null ? undefined : byPid.get(selectedPid);
  const now = Date.now();
  const filtered = visible.length !== snapshot.processes.length;

  // A selection made from outside the table (the core cards) scrolls its row
  // into view when that row is rendered.
  useEffect(() => {
    if (selectedPid === null) return;
    const row = bodyRef.current?.querySelector<HTMLElement>(`tr[data-pid="${selectedPid}"]`);
    if (row && document.activeElement !== row) row.scrollIntoView({ block: "nearest" });
  }, [selectedPid]);

  const toggle = (key: string) =>
    setToggled((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const changeGrouping = (next: ProcessGrouping) => {
    setGrouping(next);
    setToggled(new Set());
  };

  const sortBy = (key: ProcessSortKey) =>
    setSort((previous) =>
      previous.key === key
        ? { key, direction: previous.direction === "asc" ? "desc" : "asc" }
        : { key, direction: defaultDirection(key) }
    );

  const setColumn = (column: ProcessColumn, on: boolean) => {
    const wanted = new Set(columns);
    if (on) wanted.add(column);
    else wanted.delete(column);
    const next = PROCESS_COLUMNS.filter((candidate) => wanted.has(candidate));
    setColumns(next);
    saveColumns(next);
  };

  const askStop = (proc: SystemProcessInfo) => {
    if (canStop(proc, snapshot.daemonPid)) setPending(proc);
  };

  const confirmStop = async (proc: SystemProcessInfo) => {
    const label = processLabel(proc);
    setPending(null);
    setBusyPid(proc.pid);
    setError(null);
    try {
      const result = await api.killSystemProcess(proc.pid);
      // `killed` counts the signals actually sent; zero means every target had
      // already exited between the snapshot and the signal.
      setError(result.killed === 0 ? `${label} had already exited — nothing was signalled.` : null);
    } catch (err) {
      setError(killErrorMessage(killErrorCode(err), label));
    } finally {
      setBusyPid(null);
      onChanged();
    }
  };

  const menuItems = (proc: SystemProcessInfo): ContextMenuItem[] => [
    { label: "Show details", icon: <Info size={13} />, onClick: () => onSelect(proc.pid) },
    { label: "Copy PID", icon: <Copy size={13} />, onClick: () => void copyText(String(proc.pid)) },
    { label: "Copy command line", icon: <Copy size={13} />, onClick: () => void copyText(proc.cmdline) },
    {
      label: canStop(proc, snapshot.daemonPid)
        ? "Stop process…"
        : proc.role
          ? `Stop — ${ROLE_LABEL[proc.role].toLowerCase()} is protected`
          : "Stop — not started by Orquester",
      icon: <X size={13} />,
      danger: true,
      disabled: !canStop(proc, snapshot.daemonPid),
      onClick: () => askStop(proc)
    }
  ];

  /** Arrow keys walk the rows, Left/Right fold a tree node, Delete asks to stop. */
  const onBodyKeyDown = (event: React.KeyboardEvent<HTMLTableSectionElement>) => {
    const row = (event.target as HTMLElement).closest("tr");
    if (!row) return;
    const pid = Number(row.dataset.pid);
    const proc = Number.isInteger(pid) ? byPid.get(pid) : undefined;
    const rowModel = proc ? rows.find((candidate) => candidate.kind === "process" && candidate.proc.pid === pid) : undefined;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        (row.nextElementSibling as HTMLElement | null)?.focus();
        break;
      case "ArrowUp":
        event.preventDefault();
        (row.previousElementSibling as HTMLElement | null)?.focus();
        break;
      case "ArrowRight":
      case "ArrowLeft":
        if (rowModel?.kind === "process" && rowModel.childCount > 0 && rowModel.expanded === (event.key === "ArrowLeft")) {
          event.preventDefault();
          toggle(rowModel.key);
        }
        break;
      case "Delete":
        if (proc) {
          event.preventDefault();
          askStop(proc);
        }
        break;
    }
  };

  const shownColumns = PROCESS_COLUMNS.filter((column) => columns.includes(column));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[12rem] flex-1">
          <span className="sr-only">Search processes</span>
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, command, user or PID"
            className={cn(
              "h-8 w-full rounded-md border border-neutral-800 bg-neutral-900 pl-8 pr-2.5 text-xs text-neutral-100",
              "placeholder:text-neutral-500 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
            )}
          />
        </label>
        <SegmentedControl<ProcessScope>
          ariaLabel="Which processes"
          value={scope}
          onChange={setScope}
          options={[
            { value: "all", label: "All processes" },
            { value: "orquester", label: "Orquester", title: "Only what the daemon runs: sessions, agents and their children" }
          ]}
        />
        <select aria-label="Filter by user" value={user ?? ""} onChange={(event) => setUser(event.target.value || null)} className={selectClass}>
          <option value="">All users</option>
          {users.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by status"
          value={state ?? ""}
          onChange={(event) => setState((event.target.value || null) as SystemProcessState | null)}
          className={selectClass}
        >
          <option value="">All statuses</option>
          {STATES.map((value) => (
            <option key={value} value={value}>
              {STATE_META[value].label}
            </option>
          ))}
        </select>
        <select
          aria-label="Group processes"
          value={grouping}
          onChange={(event) => changeGrouping(event.target.value as ProcessGrouping)}
          className={selectClass}
        >
          <option value="none">No grouping</option>
          <option value="tree">Parent → child tree</option>
          <option value="name">Group by name</option>
        </select>
        <Dropdown
          align="right"
          width="w-44"
          ariaLabel="Visible columns"
          triggerClassName={cn(selectClass, "items-center gap-1.5 hover:text-neutral-100")}
          trigger={
            <>
              <Columns3 size={13} /> Columns
            </>
          }
        >
          <DropdownLabel>Show columns</DropdownLabel>
          {PROCESS_COLUMNS.map((column) => {
            const on = columns.includes(column);
            return (
              <DropdownItem
                key={column}
                keepOpen
                role="menuitemcheckbox"
                aria-checked={on}
                icon={on ? <Check size={13} className="text-neutral-200" /> : null}
                onClick={() => setColumn(column, !on)}
                className="text-xs"
              >
                {COLUMN_META[column].label}
              </DropdownItem>
            );
          })}
        </Dropdown>
      </div>

      {error && (
        <p className="rounded-md border border-danger-900/60 bg-danger-soft/30 px-2.5 py-2 text-[11px] text-danger-300">{error}</p>
      )}

      <div className="max-h-[min(36rem,60vh)] overflow-auto rounded-xl border border-neutral-800 bg-neutral-900/40">
        <table className="w-full min-w-[44rem] table-fixed border-collapse text-left">
          <colgroup>
            <col />
            {shownColumns.map((column) => (
              <col key={column} className={COLUMN_META[column].width} />
            ))}
            <col className="w-9" />
          </colgroup>
          <thead>
            <tr className="border-b border-neutral-800">
              <SortHeader
                column="name"
                label={filtered ? `Process · ${visible.length} of ${snapshot.processes.length}` : `Process · ${snapshot.processes.length}`}
                numeric={false}
                sort={sort}
                onSort={sortBy}
                className="pl-5"
              />
              {shownColumns.map((column) => (
                <SortHeader
                  key={column}
                  column={column}
                  label={COLUMN_META[column].label}
                  numeric={COLUMN_META[column].numeric}
                  sort={sort}
                  onSort={sortBy}
                />
              ))}
              <th className="sticky top-0 z-10 bg-neutral-900" />
            </tr>
          </thead>
          <tbody ref={bodyRef} onKeyDown={onBodyKeyDown}>
            {rows.map((row) =>
              row.kind === "group" ? (
                <GroupRow key={row.key} row={row} columns={shownColumns} memoryTotal={memoryTotal} now={now} onToggle={toggle} />
              ) : (
                <ProcessRow
                  key={row.key}
                  row={row}
                  columns={shownColumns}
                  memoryTotal={memoryTotal}
                  now={now}
                  selected={row.proc.pid === selectedPid}
                  busy={row.proc.pid === busyPid}
                  onSelect={onSelect}
                  onToggle={toggle}
                  onMenu={(proc, x, y) => setMenu({ proc, x, y })}
                />
              )
            )}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="px-3 py-8 text-center text-xs text-neutral-500">
            No process matches these filters.{" "}
            <button
              type="button"
              className="text-neutral-300 underline-offset-2 hover:underline"
              onClick={() => {
                setQuery("");
                setScope("all");
                setUser(null);
                setState(null);
              }}
            >
              Clear filters
            </button>
          </p>
        )}
      </div>

      {selected && (
        <ProcessDetails
          proc={selected}
          daemonPid={snapshot.daemonPid}
          parent={byPid.get(selected.ppid)}
          ports={ports}
          now={now}
          busy={busyPid === selected.pid}
          onSelect={onSelect}
          onStop={askStop}
          onClose={() => onSelect(null)}
        />
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.proc)} onClose={() => setMenu(null)} />}

      <ConfirmDialog
        open={pending !== null}
        title="Stop process"
        confirmLabel="Stop"
        message={
          pending && (
            <>
              <p>
                SIGTERM <span className="text-neutral-200">{pending.name}</span> (PID {pending.pid})
                {(() => {
                  const under = descendantCount(snapshot.processes, pending.pid);
                  return under > 0 ? ` and the ${under} process${under === 1 ? "" : "es"} under it` : "";
                })()}
                ?
              </p>
              <p className="mt-2 break-all text-xs text-neutral-500">{pending.cmdline}</p>
              {pending.sessionId && (
                <p className="mt-2 text-xs text-warn/90">
                  This process belongs to a session tab — stopping it ends what that tab is running.
                </p>
              )}
            </>
          )
        }
        onConfirm={() => {
          if (pending) void confirmStop(pending);
        }}
        onCancel={() => setPending(null)}
      />
    </div>
  );
};
