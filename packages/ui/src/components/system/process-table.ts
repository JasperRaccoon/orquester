import type { SystemProcessInfo, SystemProcessRole, SystemProcessState } from "@orquester/api";

/**
 * The pure model behind Settings → Host status' process table: filtering,
 * sorting and the three row layouts (flat, parent → child tree, grouped by
 * name). Free of React and transport imports so `process-table.check.ts` can
 * assert it with plain `node --import tsx`.
 */

export type ProcessColumn = "status" | "cpu" | "memory" | "disk" | "pid" | "threads" | "user" | "uptime";
export type ProcessSortKey = "name" | ProcessColumn;
export type SortDirection = "asc" | "desc";
export type ProcessScope = "all" | "orquester";
export type ProcessGrouping = "none" | "tree" | "name";

export const PROCESS_COLUMNS: readonly ProcessColumn[] = [
  "status",
  "cpu",
  "memory",
  "disk",
  "pid",
  "threads",
  "user",
  "uptime"
];

/** Threads is the one column a ~900 px settings pane can spare by default. */
export const DEFAULT_COLUMNS: readonly ProcessColumn[] = PROCESS_COLUMNS.filter((column) => column !== "threads");

/** Numbers read biggest-first; names and ids read A→Z / lowest-first. */
export function defaultDirection(key: ProcessSortKey): SortDirection {
  return key === "name" || key === "pid" || key === "user" || key === "status" ? "asc" : "desc";
}

/**
 * True when this row is inside the daemon's own tree. A daemon that predates
 * whole-host listing sends no `managed` flag — and lists only its own tree.
 */
export function isManaged(proc: SystemProcessInfo): boolean {
  return proc.managed !== false;
}

/** Stop is offered for managed rows, minus the infrastructure the daemon refuses anyway. */
export function canStop(proc: SystemProcessInfo, daemonPid: number): boolean {
  return isManaged(proc) && proc.pid !== daemonPid && proc.role === undefined;
}

/** Combined read + write rate; null when neither direction was measured. */
export function diskRate(proc: Pick<SystemProcessInfo, "diskReadBps" | "diskWriteBps">): number | null {
  const read = proc.diskReadBps ?? null;
  const write = proc.diskWriteBps ?? null;
  return read === null && write === null ? null : (read ?? 0) + (write ?? 0);
}

export interface ProcessFilter {
  query: string;
  scope: ProcessScope;
  /** Exact user name, or null for everyone. */
  user: string | null;
  state: SystemProcessState | null;
}

/** Case-insensitive match on name, command line, user and PID; then the dropdown filters. */
export function filterProcesses(processes: readonly SystemProcessInfo[], filter: ProcessFilter): SystemProcessInfo[] {
  const needle = filter.query.trim().toLowerCase();
  return processes.filter((proc) => {
    if (filter.scope === "orquester" && !isManaged(proc)) return false;
    if (filter.user !== null && proc.user !== filter.user) return false;
    if (filter.state !== null && proc.state !== filter.state) return false;
    if (!needle) return true;
    return (
      String(proc.pid) === needle ||
      proc.name.toLowerCase().includes(needle) ||
      proc.cmdline.toLowerCase().includes(needle) ||
      (proc.user?.toLowerCase().includes(needle) ?? false)
    );
  });
}

/** Distinct user names, for the user filter. */
export function processUsers(processes: readonly SystemProcessInfo[]): string[] {
  return [...new Set(processes.map((proc) => proc.user).filter((user): user is string => !!user))].sort();
}

/** What a row shows and sorts on — one process, or a name group's totals. */
export interface RowMetrics {
  name: string;
  pid: number;
  state?: SystemProcessState;
  cpuPercent: number | null;
  rssBytes: number;
  diskBps: number | null;
  threads?: number;
  user?: string;
  startedAt?: number;
}

export function processMetrics(proc: SystemProcessInfo): RowMetrics {
  return {
    name: proc.name,
    pid: proc.pid,
    state: proc.state,
    cpuPercent: proc.cpuPercent ?? null,
    rssBytes: proc.rssBytes,
    diskBps: diskRate(proc),
    threads: proc.threads,
    user: proc.user,
    startedAt: proc.startedAt
  };
}

const STATE_ORDER: Record<SystemProcessState, number> = {
  running: 0,
  "disk-wait": 1,
  sleeping: 2,
  idle: 3,
  stopped: 4,
  zombie: 5,
  other: 6
};

/** Sum of the known values; null only when none was known. */
function sumKnown(values: ReadonlyArray<number | null | undefined>): number | null {
  let total: number | null = null;
  for (const value of values) {
    if (value != null) total = (total ?? 0) + value;
  }
  return total;
}

/**
 * Totals of a name group: summed CPU/memory/disk/threads, the lowest pid, the
 * "busiest" state, the oldest start, and the user only when they all share one.
 */
export function groupMetrics(name: string, procs: readonly SystemProcessInfo[]): RowMetrics {
  const states = procs.map((proc) => proc.state).filter((state): state is SystemProcessState => !!state);
  const users = new Set(procs.map((proc) => proc.user));
  const starts = procs.map((proc) => proc.startedAt).filter((at): at is number => at !== undefined);
  return {
    name,
    pid: Math.min(...procs.map((proc) => proc.pid)),
    state: states.sort((a, b) => STATE_ORDER[a] - STATE_ORDER[b])[0],
    cpuPercent: sumKnown(procs.map((proc) => proc.cpuPercent)),
    rssBytes: procs.reduce((sum, proc) => sum + proc.rssBytes, 0),
    diskBps: sumKnown(procs.map(diskRate)),
    threads: sumKnown(procs.map((proc) => proc.threads)) ?? undefined,
    user: users.size === 1 ? procs[0]?.user : undefined,
    startedAt: starts.length > 0 ? Math.min(...starts) : undefined
  };
}

/**
 * The value a column sorts on. Unknowns are `null` and always sort last,
 * whichever the direction — an unmeasured row is not "the smallest".
 */
function sortValue(row: RowMetrics, key: ProcessSortKey): number | string | null {
  switch (key) {
    case "name":
      return row.name.toLowerCase();
    case "status":
      return row.state ? STATE_ORDER[row.state] : null;
    case "cpu":
      return row.cpuPercent;
    case "memory":
      return row.rssBytes;
    case "disk":
      return row.diskBps;
    case "pid":
      return row.pid;
    case "threads":
      return row.threads ?? null;
    case "user":
      return row.user?.toLowerCase() ?? null;
    case "uptime":
      // Longest-running first is "biggest uptime": an earlier start sorts higher.
      return row.startedAt === undefined ? null : -row.startedAt;
  }
}

export function compareRows(a: RowMetrics, b: RowMetrics, key: ProcessSortKey, direction: SortDirection): number {
  const left = sortValue(a, key);
  const right = sortValue(b, key);
  if (left === null || right === null) {
    if (left !== right) return left === null ? 1 : -1;
  } else if (left !== right) {
    const order = typeof left === "string" ? left.localeCompare(right as string) : left - (right as number);
    return direction === "asc" ? order : -order;
  }
  // Ties (and two unknowns) fall back to pid so a live table does not reshuffle.
  return a.pid - b.pid;
}

export interface ProcessSort {
  key: ProcessSortKey;
  direction: SortDirection;
}

/** A rendered table row: one process, or the header row of a name group. */
export type TableRow =
  | {
      kind: "process";
      key: string;
      proc: SystemProcessInfo;
      metrics: RowMetrics;
      depth: number;
      /** Children (tree) under this row; 0 when it has none. */
      childCount: number;
      expanded: boolean;
    }
  | {
      kind: "group";
      key: string;
      name: string;
      procs: SystemProcessInfo[];
      metrics: RowMetrics;
      expanded: boolean;
    };

export const processRowKey = (pid: number): string => `p:${pid}`;
export const groupRowKey = (name: string): string => `g:${name}`;

/** Depth cap for the ancestor walk that rejects a cyclic ppid chain. */
const ANCESTOR_WALK_LIMIT = 256;

/**
 * The rows to render, in order.
 *
 * - `none`: the processes, sorted.
 * - `tree`: parent → child, siblings sorted; a process whose parent is not in
 *   the (filtered) list is a root. Expanded unless its key is in `toggled`.
 * - `name`: processes sharing a name collapse into one group row carrying their
 *   totals, sorted among the singles by those totals. Collapsed unless its key
 *   is in `toggled`.
 *
 * `toggled` holds the keys the user flipped away from their layout's default.
 */
export function buildRows(
  processes: readonly SystemProcessInfo[],
  grouping: ProcessGrouping,
  sort: ProcessSort,
  toggled: ReadonlySet<string>
): TableRow[] {
  const byMetrics = (a: { metrics: RowMetrics }, b: { metrics: RowMetrics }) =>
    compareRows(a.metrics, b.metrics, sort.key, sort.direction);

  if (grouping === "name") {
    const groups = new Map<string, SystemProcessInfo[]>();
    for (const proc of processes) {
      const members = groups.get(proc.name);
      if (members) members.push(proc);
      else groups.set(proc.name, [proc]);
    }
    const tops = [...groups].map(([name, procs]) =>
      procs.length === 1
        ? { kind: "single" as const, proc: procs[0], metrics: processMetrics(procs[0]) }
        : { kind: "group" as const, name, procs, metrics: groupMetrics(name, procs) }
    );
    tops.sort(byMetrics);
    const rows: TableRow[] = [];
    for (const top of tops) {
      if (top.kind === "single") {
        rows.push(processRow(top.proc, top.metrics, 0, 0, false));
        continue;
      }
      const key = groupRowKey(top.name);
      const expanded = toggled.has(key);
      rows.push({ kind: "group", key, name: top.name, procs: top.procs, metrics: top.metrics, expanded });
      if (expanded) {
        const members = top.procs.map((proc) => ({ proc, metrics: processMetrics(proc) })).sort(byMetrics);
        for (const member of members) rows.push(processRow(member.proc, member.metrics, 1, 0, false));
      }
    }
    return rows;
  }

  const items = processes.map((proc) => ({ proc, metrics: processMetrics(proc) }));
  if (grouping === "none") {
    return items.sort(byMetrics).map((item) => processRow(item.proc, item.metrics, 0, 0, false));
  }

  // Tree. A recycled pid could describe a parent cycle: a link whose parent
  // already has the child among its ancestors is refused, so the forest stays
  // acyclic and the walk below terminates.
  const byPid = new Map(items.map((item) => [item.proc.pid, item]));
  const parentOf = (pid: number): number | undefined => {
    const ppid = byPid.get(pid)?.proc.ppid;
    return ppid !== undefined && ppid !== pid && byPid.has(ppid) ? ppid : undefined;
  };
  const reaches = (from: number, target: number): boolean => {
    let cursor: number | undefined = from;
    for (let step = 0; cursor !== undefined && step < ANCESTOR_WALK_LIMIT; step += 1) {
      if (cursor === target) return true;
      cursor = parentOf(cursor);
    }
    return cursor !== undefined;
  };
  const children = new Map<number, typeof items>();
  const roots: typeof items = [];
  for (const item of items) {
    const parent = parentOf(item.proc.pid);
    if (parent !== undefined && !reaches(parent, item.proc.pid)) {
      const siblings = children.get(parent);
      if (siblings) siblings.push(item);
      else children.set(parent, [item]);
    } else {
      roots.push(item);
    }
  }
  const rows: TableRow[] = [];
  const stack = roots.sort(byMetrics).reverse().map((item) => ({ item, depth: 0 }));
  while (stack.length > 0) {
    const { item, depth } = stack.pop()!;
    const kids = (children.get(item.proc.pid) ?? []).sort(byMetrics);
    const expanded = kids.length > 0 && !toggled.has(processRowKey(item.proc.pid));
    rows.push(processRow(item.proc, item.metrics, depth, kids.length, expanded));
    if (expanded) {
      for (let index = kids.length - 1; index >= 0; index -= 1) stack.push({ item: kids[index], depth: depth + 1 });
    }
  }
  return rows;
}

function processRow(
  proc: SystemProcessInfo,
  metrics: RowMetrics,
  depth: number,
  childCount: number,
  expanded: boolean
): TableRow {
  return { kind: "process", key: processRowKey(proc.pid), proc, metrics, depth, childCount, expanded };
}

/** ppid → child pids of the full list; a process listed as its own parent has none. */
function childrenByParent(processes: readonly SystemProcessInfo[]): Map<number, SystemProcessInfo[]> {
  const children = new Map<number, SystemProcessInfo[]>();
  for (const proc of processes) {
    if (proc.ppid === proc.pid) continue;
    const siblings = children.get(proc.ppid);
    if (siblings) siblings.push(proc);
    else children.set(proc.ppid, [proc]);
  }
  return children;
}

/** Every process under `pid` in the full list, breadth-first; cycle-safe. */
function descendantsOf(processes: readonly SystemProcessInfo[], pid: number): SystemProcessInfo[] {
  const children = childrenByParent(processes);
  const seen = new Set<number>([pid]);
  const queue = [pid];
  const out: SystemProcessInfo[] = [];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (!seen.has(child.pid)) {
        seen.add(child.pid);
        out.push(child);
        queue.push(child.pid);
      }
    }
  }
  return out;
}

/** Pids under `pid` in the full list (not just the visible rows) — what a Stop signals besides it. */
export function descendantCount(processes: readonly SystemProcessInfo[], pid: number): number {
  return descendantsOf(processes, pid).length;
}

/**
 * What an expanded row says about the processes under `pid`: its direct
 * children (busiest first), how many descendants there are in all, and the
 * whole subtree's CPU and memory including `pid` itself.
 */
export function subtreeSummary(
  processes: readonly SystemProcessInfo[],
  pid: number
): { children: SystemProcessInfo[]; descendants: number; cpuPercent: number | null; rssBytes: number } {
  const self = processes.find((proc) => proc.pid === pid);
  const below = descendantsOf(processes, pid);
  const all = self ? [self, ...below] : below;
  return {
    children: below
      .filter((proc) => proc.ppid === pid)
      .sort((a, b) => compareRows(processMetrics(a), processMetrics(b), "cpu", "desc")),
    descendants: below.length,
    cpuPercent: sumKnown(all.map((proc) => proc.cpuPercent)),
    rssBytes: all.reduce((sum, proc) => sum + proc.rssBytes, 0)
  };
}

/** The listed ancestors of `pid`, outermost first; stops at a missing parent or a cycle. */
export function ancestorsOf(processes: readonly SystemProcessInfo[], pid: number): SystemProcessInfo[] {
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const seen = new Set<number>([pid]);
  const chain: SystemProcessInfo[] = [];
  let parent = byPid.get(byPid.get(pid)?.ppid ?? -1);
  while (parent && !seen.has(parent.pid) && chain.length < ANCESTOR_WALK_LIMIT) {
    seen.add(parent.pid);
    chain.push(parent);
    parent = byPid.get(parent.ppid);
  }
  return chain.reverse();
}

/** The Orquester infrastructure rows, by role (first match wins). */
export function coreProcesses(
  processes: readonly SystemProcessInfo[],
  daemonPid: number
): Partial<Record<SystemProcessRole, SystemProcessInfo>> {
  const core: Partial<Record<SystemProcessRole, SystemProcessInfo>> = {};
  for (const proc of processes) {
    // An older daemon tags nothing; its own pid still names the daemon row.
    const role = proc.role ?? (proc.pid === daemonPid ? "daemon" : undefined);
    if (role && !core[role]) core[role] = proc;
  }
  return core;
}

/** Totals of everything inside the daemon's tree. */
export function managedTotals(processes: readonly SystemProcessInfo[]): {
  count: number;
  cpuPercent: number | null;
  rssBytes: number;
} {
  const managed = processes.filter(isManaged);
  return {
    count: managed.length,
    cpuPercent: sumKnown(managed.map((proc) => proc.cpuPercent)),
    rssBytes: managed.reduce((sum, proc) => sum + proc.rssBytes, 0)
  };
}

/**
 * Visible columns out of persisted JSON: known names only, in canonical order,
 * deduplicated. Anything malformed (another version's shape, hand edits) falls
 * back to the defaults.
 */
export function parseColumns(raw: string | null): ProcessColumn[] {
  if (raw === null) return [...DEFAULT_COLUMNS];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_COLUMNS];
    const wanted = new Set(parsed.filter((value): value is string => typeof value === "string"));
    return PROCESS_COLUMNS.filter((column) => wanted.has(column));
  } catch {
    return [...DEFAULT_COLUMNS];
  }
}
