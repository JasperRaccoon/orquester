import type { KillProcessErrorCode, SystemProcessInfo } from "@orquester/api";

/**
 * Pure helpers behind the System status surfaces (top-bar chip, Settings →
 * System). Kept free of React and of any transport import so `system-format.check.ts`
 * can assert them with plain `node --import tsx`.
 */

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/**
 * Human bytes. `null`/`undefined` is *unknown* and renders as an em-dash — the
 * daemon reports an unmeasurable volume as null and that must never be shown as
 * a genuine 0 bytes.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) {
    return "—";
  }
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** Percent with the same unknown-is-an-em-dash rule as {@link formatBytes}. */
export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "—";
  }
  return `${Math.round(Math.max(0, Math.min(100, value)))}%`;
}

/** Bar width for a possibly-unknown percent: an unknown bar is drawn empty. */
export function barWidth(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "0%";
  }
  return `${Math.max(0, Math.min(100, value))}%`;
}

export interface ProcessNode {
  proc: SystemProcessInfo;
  children: ProcessNode[];
  /** RSS of this process plus everything under it — what a kill would reclaim. */
  subtreeRssBytes: number;
}

/** Depth cap for the ancestor walk that rejects a cyclic ppid chain. */
const ANCESTOR_WALK_LIMIT = 256;

/**
 * Flat `/api/system/processes` list → forest. A pid whose ppid is absent from
 * the list is a root: the daemon itself, and every tmux pane (whose real parent
 * is the tmux server, which the daemon deliberately keeps out of the tree).
 *
 * A pid recycled between the daemon's scan passes could in principle describe a
 * cycle; linking is therefore refused whenever the candidate parent already has
 * the node among its ancestors, so the returned forest is always acyclic and
 * safe to render recursively.
 */
export function buildProcessTree(processes: readonly SystemProcessInfo[]): ProcessNode[] {
  const byPid = new Map<number, ProcessNode>();
  for (const proc of processes) {
    byPid.set(proc.pid, { proc, children: [], subtreeRssBytes: proc.rssBytes });
  }

  const reachesPid = (from: ProcessNode, target: number): boolean => {
    let cursor: ProcessNode | undefined = from;
    for (let step = 0; cursor && step < ANCESTOR_WALK_LIMIT; step += 1) {
      if (cursor.proc.pid === target) {
        return true;
      }
      cursor = byPid.get(cursor.proc.ppid);
    }
    // Ran out of budget without terminating: treat as cyclic and don't link.
    return cursor !== undefined;
  };

  const roots: ProcessNode[] = [];
  for (const node of byPid.values()) {
    const parent = byPid.get(node.proc.ppid);
    if (parent && parent !== node && !reachesPid(parent, node.proc.pid)) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const byPidAsc = (a: ProcessNode, b: ProcessNode) => a.proc.pid - b.proc.pid;
  for (const node of byPid.values()) {
    node.children.sort(byPidAsc);
  }
  roots.sort(byPidAsc);

  // Post-order subtree sums, iteratively — the tree is shallow but a recursive
  // sum on thousands of pids is a stack risk for no gain.
  const order: ProcessNode[] = [];
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop() as ProcessNode;
    order.push(node);
    stack.push(...node.children);
  }
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const node = order[i];
    node.subtreeRssBytes = node.children.reduce((sum, child) => sum + child.subtreeRssBytes, node.proc.rssBytes);
  }

  return roots;
}

/** Total processes in a forest (the header count). */
export function countProcessNodes(nodes: readonly ProcessNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countProcessNodes(node.children), 0);
}

/** Pids in `node`'s subtree, itself included — what a kill would signal. */
export function subtreePids(node: ProcessNode): number[] {
  return node.children.reduce<number[]>((pids, child) => pids.concat(subtreePids(child)), [node.proc.pid]);
}

/**
 * The daemon's refusal code out of a thrown API error, duck-typed on
 * `error.body.code` so this module stays free of the transport layer. Null when
 * the failure carried no recognised code (network drop, 500, …).
 */
export function killErrorCode(error: unknown): KillProcessErrorCode | null {
  const body = (error as { body?: unknown } | null | undefined)?.body;
  const code = (body as { code?: unknown } | null | undefined)?.code;
  switch (code) {
    case "INVALID_PID":
    case "PROCESS_NOT_MANAGED":
    case "PROCESS_PROTECTED":
    case "UNSUPPORTED_PLATFORM":
      return code;
    default:
      return null;
  }
}

/**
 * Distinct copy per refusal reason: "you may not touch that one" and "this host
 * cannot do it at all" call for different reactions, and a single generic
 * "failed" would hide which one happened.
 */
export function killErrorMessage(code: KillProcessErrorCode | null, label: string): string {
  switch (code) {
    case "PROCESS_PROTECTED":
      return `${label} is protected — the daemon and the tmux server that keeps your sessions alive can't be stopped from here.`;
    case "PROCESS_NOT_MANAGED":
      return `${label} is no longer in this daemon's process tree — it probably exited already. Refresh the list.`;
    case "INVALID_PID":
      return `${label} is not a valid target. Refresh the list and try again.`;
    case "UNSUPPORTED_PLATFORM":
      return "Stopping processes is only available on Linux hosts.";
    default:
      return `Could not stop ${label}.`;
  }
}

/** "node dev.mjs --port 3000" → the row's title attribute; empty stays empty. */
export function processLabel(proc: SystemProcessInfo): string {
  return `${proc.name} (PID ${proc.pid})`;
}
