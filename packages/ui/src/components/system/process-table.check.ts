import assert from "node:assert/strict";
import type { SystemProcessInfo } from "@orquester/api";
import {
  DEFAULT_COLUMNS,
  ancestorsOf,
  buildRows,
  canStop,
  compareRows,
  coreProcesses,
  descendantCount,
  filterProcesses,
  groupMetrics,
  groupRowKey,
  managedTotals,
  parseColumns,
  processMetrics,
  processRowKey,
  processUsers,
  subtreeSummary,
  type ProcessFilter
} from "./process-table";
import { formatBitRate, formatCpu, formatDuration } from "./system-format";

const proc = (pid: number, ppid: number, extra: Partial<SystemProcessInfo> = {}): SystemProcessInfo => ({
  pid,
  ppid,
  name: `p${pid}`,
  cmdline: `p${pid} --run`,
  rssBytes: 1000,
  managed: true,
  cpuPercent: 0,
  state: "sleeping",
  user: "orquester",
  ...extra
});

const everyone: ProcessFilter = { query: "", scope: "all", user: null, state: null };
const pids = (rows: ReturnType<typeof buildRows>) =>
  rows.map((row) => (row.kind === "process" ? row.proc.pid : row.key));

// ── Filtering ────────────────────────────────────────────────────────────────
const host = [
  proc(1, 0, { name: "systemd", cmdline: "/sbin/init", user: "root", managed: false }),
  proc(10, 1, { name: "node", cmdline: "node daemon.js", role: "daemon" }),
  proc(11, 10, { name: "node", cmdline: "node vite.js", cpuPercent: 30, rssBytes: 5000, state: "running" }),
  proc(12, 10, { name: "bash", cmdline: "/bin/bash", cpuPercent: null, sessionId: "s1" }),
  proc(20, 1, { name: "dockerd", cmdline: "/usr/bin/dockerd", user: "root", managed: false, cpuPercent: 5 })
];
assert.deepEqual(filterProcesses(host, { ...everyone, scope: "orquester" }).map((p) => p.pid), [10, 11, 12]);
assert.deepEqual(filterProcesses(host, { ...everyone, query: "VITE" }).map((p) => p.pid), [11], "matches the command line, any case");
assert.deepEqual(filterProcesses(host, { ...everyone, query: "20" }).map((p) => p.pid), [20], "a bare number matches the exact pid");
assert.deepEqual(filterProcesses(host, { ...everyone, user: "root" }).map((p) => p.pid), [1, 20]);
assert.deepEqual(filterProcesses(host, { ...everyone, state: "running" }).map((p) => p.pid), [11]);
assert.deepEqual(processUsers(host), ["orquester", "root"]);
// A daemon from before whole-host listing sends no `managed`: every row it lists is its own.
assert.equal(filterProcesses([{ pid: 5, ppid: 1, name: "x", cmdline: "x", rssBytes: 0 }], { ...everyone, scope: "orquester" }).length, 1);

// ── Stop eligibility ─────────────────────────────────────────────────────────
assert.equal(canStop(host[2], 10), true);
assert.equal(canStop(host[1], 10), false, "the daemon is never offered");
assert.equal(canStop(host[0], 10), false, "nothing outside our tree is offered");
assert.equal(canStop(proc(30, 1, { role: "agent-host" }), 10), false, "nor is the agent host");

// ── Sorting ──────────────────────────────────────────────────────────────────
const flat = buildRows(host, "none", { key: "cpu", direction: "desc" }, new Set());
// Unknown CPU (pid 12) sorts last whichever way; ties (1 and 10 at 0%) fall back to pid.
assert.deepEqual(pids(flat), [11, 20, 1, 10, 12]);
assert.deepEqual(pids(buildRows(host, "none", { key: "cpu", direction: "asc" }, new Set())), [1, 10, 20, 11, 12]);
assert.deepEqual(pids(buildRows(host, "none", { key: "name", direction: "asc" }, new Set())), [12, 20, 10, 11, 1]);
const older = processMetrics(proc(1, 0, { startedAt: 1_000 }));
const newer = processMetrics(proc(2, 0, { startedAt: 9_000 }));
assert.ok(compareRows(older, newer, "uptime", "desc") < 0, "longest uptime first when descending");
assert.ok(compareRows(older, newer, "uptime", "asc") > 0);

// ── Tree ─────────────────────────────────────────────────────────────────────
const tree = buildRows(host, "tree", { key: "cpu", direction: "desc" }, new Set());
assert.deepEqual(pids(tree), [1, 20, 10, 11, 12], "siblings sorted by the active column, children follow their parent");
assert.deepEqual(
  tree.map((row) => (row.kind === "process" ? row.depth : -1)),
  [0, 1, 1, 2, 2]
);
const collapsed = buildRows(host, "tree", { key: "cpu", direction: "desc" }, new Set([processRowKey(10)]));
assert.deepEqual(pids(collapsed), [1, 20, 10], "a toggled parent hides its children");
const daemonRow = collapsed[2];
assert.ok(daemonRow.kind === "process" && daemonRow.childCount === 2 && !daemonRow.expanded);
// A filtered-out parent promotes its children to roots; a ppid cycle terminates.
assert.deepEqual(pids(buildRows([host[2], host[3]], "tree", { key: "pid", direction: "asc" }, new Set())), [11, 12]);
assert.equal(buildRows([proc(40, 41), proc(41, 40)], "tree", { key: "pid", direction: "asc" }, new Set()).length, 2);

// ── Group by name ────────────────────────────────────────────────────────────
const grouped = buildRows(host, "name", { key: "cpu", direction: "desc" }, new Set());
assert.deepEqual(pids(grouped), [groupRowKey("node"), 20, 1, 12], "the node pair folds into one group, sorted by its total");
const group = grouped[0];
assert.ok(group.kind === "group" && !group.expanded && group.procs.length === 2);
assert.equal(group.kind === "group" && group.metrics.cpuPercent, 30);
assert.equal(group.kind === "group" && group.metrics.rssBytes, 6000);
const opened = buildRows(host, "name", { key: "cpu", direction: "desc" }, new Set([groupRowKey("node")]));
assert.deepEqual(pids(opened).slice(0, 3), [groupRowKey("node"), 11, 10]);
const mixed = groupMetrics("x", [
  proc(1, 0, { user: "a", state: "sleeping", cpuPercent: null, startedAt: 50 }),
  proc(2, 0, { user: "b", state: "running", cpuPercent: null, startedAt: 10 })
]);
assert.equal(mixed.user, undefined, "a group of different users names none");
assert.equal(mixed.state, "running", "the busiest state represents the group");
assert.equal(mixed.cpuPercent, null, "no measured member means an unknown total, not 0");
assert.equal(mixed.startedAt, 10);

// ── Subtree, core and totals ─────────────────────────────────────────────────
assert.equal(descendantCount(host, 10), 2);
assert.equal(descendantCount(host, 1), 4);
assert.equal(descendantCount([proc(5, 5)], 5), 0, "a self-parented pid is not its own child");
const daemonTree = subtreeSummary(host, 10);
assert.deepEqual(daemonTree.children.map((p) => p.pid), [11, 12], "direct children, busiest first; unknown CPU last");
assert.equal(daemonTree.descendants, 2);
assert.equal(daemonTree.cpuPercent, 30, "the subtree total counts the process itself and skips unknowns");
assert.equal(daemonTree.rssBytes, 7000);
const initTree = subtreeSummary(host, 1);
assert.deepEqual(initTree.children.map((p) => p.pid), [20, 10], "grandchildren are counted, not listed");
assert.equal(initTree.descendants, 4);
assert.equal(subtreeSummary(host, 12).cpuPercent, null, "nothing measured is unknown, not 0%");
assert.deepEqual(ancestorsOf(host, 11).map((p) => p.pid), [1, 10], "outermost first");
assert.deepEqual(ancestorsOf(host, 1), [], "a parent outside the list ends the chain");
assert.deepEqual(ancestorsOf([proc(40, 41), proc(41, 40)], 40).map((p) => p.pid), [41], "a ppid cycle terminates");
const core = coreProcesses([...host, proc(30, 1, { role: "agent-host" })], 10);
assert.equal(core.daemon?.pid, 10);
assert.equal(core["agent-host"]?.pid, 30);
assert.equal(coreProcesses([proc(7, 1)], 7).daemon?.pid, 7, "an untagged daemon is found by its pid");
assert.deepEqual(managedTotals(host), { count: 3, cpuPercent: 30, rssBytes: 7000 });

// ── Persisted columns ────────────────────────────────────────────────────────
assert.deepEqual(parseColumns(null), DEFAULT_COLUMNS);
assert.deepEqual(parseColumns("not json"), DEFAULT_COLUMNS);
assert.deepEqual(parseColumns('{"cpu":true}'), DEFAULT_COLUMNS);
assert.deepEqual(parseColumns('["uptime","cpu","bogus","cpu",3]'), ["cpu", "uptime"], "known names, canonical order, once");
assert.deepEqual(parseColumns("[]"), [], "every column hidden is a valid choice");

// ── Formatting ───────────────────────────────────────────────────────────────
assert.equal(formatBitRate(10_912_500), "87.3 Mbps");
assert.equal(formatBitRate(125), "1.0 Kbps");
assert.equal(formatBitRate(null), "—");
assert.equal(formatCpu(62.44), "62.4%");
assert.equal(formatCpu(null), "—");
assert.equal(formatDuration(45), "45s");
assert.equal(formatDuration(2 * 3600 + 14 * 60 + 9), "2h 14m");
assert.equal(formatDuration(5 * 86_400 + 3 * 3600), "5d 3h");

console.log("process-table.check.ts OK");
