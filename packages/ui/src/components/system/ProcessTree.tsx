import React, { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, ShieldCheck, X } from "lucide-react";
import type { SystemProcessesResponse } from "@orquester/api";
import { useApi } from "../../context/orquester-context";
import { ConfirmDialog } from "../ui";
import { SessionChip } from "./SessionChip";
import {
  buildProcessTree,
  countProcessNodes,
  formatBytes,
  killErrorCode,
  killErrorMessage,
  processLabel,
  subtreePids,
  type ProcessNode
} from "./system-format";

const INDENT_PX = 14;

const ProcessRow: React.FC<{
  node: ProcessNode;
  depth: number;
  daemonPid: number;
  collapsed: ReadonlySet<number>;
  onToggle: (pid: number) => void;
  busyPid: number | null;
  onAskKill: (node: ProcessNode) => void;
}> = ({ node, depth, daemonPid, collapsed, onToggle, busyPid, onAskKill }) => {
  const { proc } = node;
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(proc.pid);
  // The only row the daemon refuses outright that is actually rendered: the tmux
  // server is the other protected pid, but it is never part of the reported tree.
  const isProtected = proc.pid === daemonPid;

  return (
    <>
      <div className="group flex items-center gap-2 border-b border-neutral-900 py-1.5 pr-1 last:border-b-0 hover:bg-neutral-800/40">
        <div className="flex min-w-0 flex-1 items-center gap-1" style={{ paddingLeft: depth * INDENT_PX }}>
          <button
            type="button"
            disabled={!hasChildren}
            onClick={() => onToggle(proc.pid)}
            aria-label={isCollapsed ? `Expand children of ${proc.name}` : `Collapse children of ${proc.name}`}
            className="flex h-4 w-4 shrink-0 items-center justify-center text-neutral-600 hover:text-neutral-300 disabled:opacity-0"
          >
            {hasChildren && (isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />)}
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-xs text-neutral-200" title={proc.cmdline}>
                {proc.name}
              </span>
              {isProtected && (
                <span
                  className="flex shrink-0 items-center gap-0.5 text-[10px] text-neutral-500"
                  title="The Orquester daemon itself — it can't be stopped from here."
                >
                  <ShieldCheck size={10} /> daemon
                </span>
              )}
            </div>
            <p className="truncate text-[10px] text-neutral-600" title={proc.cmdline}>
              {proc.cmdline}
            </p>
          </div>
        </div>
        {proc.sessionId ? <SessionChip sessionId={proc.sessionId} className="shrink-0" /> : null}
        <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-neutral-500">{proc.pid}</span>
        <span
          className="w-20 shrink-0 text-right text-[11px] tabular-nums text-neutral-400"
          title={hasChildren ? `${formatBytes(node.subtreeRssBytes)} including children` : undefined}
        >
          {formatBytes(proc.rssBytes)}
        </span>
        <span className="flex w-6 shrink-0 justify-end">
          {!isProtected && (
            <button
              type="button"
              disabled={busyPid === proc.pid}
              onClick={() => onAskKill(node)}
              aria-label={`Stop ${processLabel(proc)}`}
              title={`Stop ${processLabel(proc)}`}
              className="rounded p-0.5 text-neutral-600 hover:bg-neutral-800 hover:text-danger disabled:opacity-40 md:opacity-0 md:group-hover:opacity-100"
            >
              {busyPid === proc.pid ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
            </button>
          )}
        </span>
      </div>
      {hasChildren &&
        !isCollapsed &&
        node.children.map((child) => (
          <ProcessRow
            key={child.proc.pid}
            node={child}
            depth={depth + 1}
            daemonPid={daemonPid}
            collapsed={collapsed}
            onToggle={onToggle}
            busyPid={busyPid}
            onAskKill={onAskKill}
          />
        ))}
    </>
  );
};

/**
 * The daemon's own process tree, built client-side from the flat
 * `/api/system/processes` list, with a guarded kill per row. Every kill is
 * confirmed first: it SIGTERMs the whole subtree, which for a session root means
 * the shell and everything it is running.
 */
export const ProcessTreeView: React.FC<{
  snapshot: SystemProcessesResponse;
  onChanged: () => void;
}> = ({ snapshot, onChanged }) => {
  const api = useApi();
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set());
  const [pending, setPending] = useState<ProcessNode | null>(null);
  const [busyPid, setBusyPid] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const roots = useMemo(() => buildProcessTree(snapshot.processes), [snapshot.processes]);
  const total = useMemo(() => countProcessNodes(roots), [roots]);

  const toggle = (pid: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(pid)) {
        next.add(pid);
      }
      return next;
    });

  const confirmKill = async (node: ProcessNode) => {
    const label = processLabel(node.proc);
    setPending(null);
    setBusyPid(node.proc.pid);
    setError(null);
    try {
      const result = await api.killSystemProcess(node.proc.pid);
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

  if (roots.length === 0) {
    return <p className="px-1 py-3 text-xs text-neutral-500">No processes reported.</p>;
  }

  return (
    <div className="space-y-2">
      {error && (
        <p className="rounded-md border border-danger-900/60 bg-danger-soft/30 px-2.5 py-2 text-[11px] text-danger-300">{error}</p>
      )}
      <div className="overflow-x-auto rounded-lg border border-neutral-800">
        <div className="min-w-[32rem]">
          <div className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-900/60 py-1.5 pr-1 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
            <span className="min-w-0 flex-1 pl-1">Process · {total}</span>
            <span className="w-14 shrink-0 text-right">PID</span>
            <span className="w-20 shrink-0 text-right">Memory</span>
            <span className="w-6 shrink-0" />
          </div>
          {roots.map((root) => (
            <ProcessRow
              key={root.proc.pid}
              node={root}
              depth={0}
              daemonPid={snapshot.daemonPid}
              collapsed={collapsed}
              onToggle={toggle}
              busyPid={busyPid}
              onAskKill={(node) => setPending(node)}
            />
          ))}
        </div>
      </div>

      <ConfirmDialog
        open={pending !== null}
        title="Stop process"
        confirmLabel="Stop"
        message={
          pending && (
            <>
              <p>
                SIGTERM <span className="text-neutral-200">{pending.proc.name}</span> (PID {pending.proc.pid})
                {pending.children.length > 0
                  ? ` and the ${subtreePids(pending).length - 1} process${subtreePids(pending).length === 2 ? "" : "es"} under it`
                  : ""}
                ?
              </p>
              <p className="mt-2 break-all text-xs text-neutral-500">{pending.proc.cmdline}</p>
              {pending.proc.sessionId && (
                <p className="mt-2 text-xs text-warn/90">
                  This process belongs to a session tab — stopping it ends what that tab is running.
                </p>
              )}
            </>
          )
        }
        onConfirm={() => {
          if (pending) {
            void confirmKill(pending);
          }
        }}
        onCancel={() => setPending(null)}
      />
    </div>
  );
};
