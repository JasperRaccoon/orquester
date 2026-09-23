/**
 * The incremental roster engine (design `2026-09-23-fold-performance-design.md`
 * §A3). What it owes, and what these tests hold it to:
 * - for the list an engine stands for, `rosterFromEngine(engine, o)` deep-equals
 *   `foldSubagentActivities(list, o)` — at EVERY step of any append/replace
 *   sequence, for a live, a dead and an unknown session;
 * - nothing is ever mutated: not a row, not an engine (an old engine still
 *   folds to its own list after its successors moved on), not a roster row it
 *   handed out;
 * - an append the roster ignores returns the same engine, and a replacement it
 *   cannot apply incrementally returns `null` — exactly in the documented cases;
 * - a step hands back the same row object for every agent it did not change.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import {
  createRosterEngine,
  foldSubagentActivities,
  rosterEngineAppend,
  rosterEngineReplace,
  rosterFromEngine,
  type RosterEngine
} from "./roster.ts";
import { ACTIVE_SUBAGENT_STATUSES, ROSTER_LIMIT, TERMINAL_SUBAGENT_STATUSES } from "./thread.ts";
import type { RuntimeSubagent, ThreadActivityItem } from "./thread.ts";

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const ROSTER_KINDS = [
  "task.started",
  "task.progress",
  "task.updated",
  "task.completed",
  "tool.progress"
] as const;

const OPTIONS: ReadonlyArray<{ readonly sessionLive?: boolean } | undefined> = [
  { sessionLive: true },
  { sessionLive: false },
  undefined
];

function optionLabel(options: { readonly sessionLive?: boolean } | undefined): string {
  return options === undefined ? "sessionLive unset" : `sessionLive ${String(options.sessionLive)}`;
}

function stampAt(second: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + second * 1000).toISOString();
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** A deep-frozen activity row: any write the engine attempted would throw. */
function row(
  activityKind: string,
  payload: unknown,
  id: string,
  createdAt: string = stampAt(0)
): ThreadActivityItem {
  const item: ThreadActivityItem = {
    kind: "activity",
    id,
    tone: "info",
    activityKind,
    summary: activityKind,
    payload,
    turnId: null,
    createdAt,
    updatedAt: createdAt
  };
  return deepFreeze(item);
}

/** The roster's documented reading of a row: its trimmed task id, or `undefined` when it ignores it. */
function taskIdOf(activity: ThreadActivityItem): string | undefined {
  if (!(ROSTER_KINDS as readonly string[]).includes(activity.activityKind)) return undefined;
  const payload = activity.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const taskId = (payload as Record<string, unknown>).taskId;
  return typeof taskId === "string" && taskId.trim().length > 0 ? taskId.trim() : undefined;
}

/**
 * Deep equality for plain data — own enumerable keys, prototypes, array
 * lengths, `Object.is` on leaves: what `assert.deepStrictEqual` checks on
 * these shapes, at a fraction of its cost. The property tests compare three
 * rosters per step for thousands of steps; a miss falls through to
 * `assert.deepStrictEqual` for the diff.
 */
function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (Array.isArray(a) && (a as unknown[]).length !== (b as unknown[]).length) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!sameData((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

function assertSameRoster(actual: unknown, expected: unknown, message: string): void {
  if (sameData(actual, expected)) return;
  assert.deepStrictEqual(actual, expected, message);
  assert.fail(`${message}: the rosters differ`);
}

function assertInvariant(engine: RosterEngine, list: readonly ThreadActivityItem[], label: string): void {
  for (const options of OPTIONS) {
    assertSameRoster(
      rosterFromEngine(engine, options),
      foldSubagentActivities(list, options),
      `${label} (${optionLabel(options)})`
    );
  }
}

function byId(roster: readonly RuntimeSubagent[], id: string): RuntimeSubagent {
  const agent = roster.find((entry) => entry.id === id);
  assert.ok(agent, `no roster row for ${id}`);
  return agent;
}

// ---------------------------------------------------------------------------
// The documented cases
// ---------------------------------------------------------------------------

test("an append the roster never reads returns the same engine", () => {
  const list = [row("task.started", { taskId: "t1", agentKind: "agent" }, "a1", stampAt(1))];
  const engine = createRosterEngine(list);
  const ignored = [
    row("tool.started", { taskId: "t1", toolUseId: "x" }, "n1"),
    row("item.completed", { taskId: "t1" }, "n2"),
    row("task.progress", null, "n3"),
    row("task.updated", "t1", "n4"),
    row("task.completed", Object.assign(["t1"], { taskId: "t1" }), "n5"),
    row("task.started", { agentKind: "agent" }, "n6"),
    row("task.progress", { taskId: "   " }, "n7"),
    row("tool.progress", { taskId: 7, toolName: "Bash" }, "n8")
  ];
  for (const activity of ignored) {
    assert.equal(rosterEngineAppend(engine, activity), engine, activity.id);
  }
  assertInvariant(engine, [...list, ...ignored], "the roster is unchanged");
});

test("a replacement between two rows the roster ignores returns the same engine", () => {
  const noise = row("tool.started", { toolUseId: "x" }, "n1");
  const list = [row("task.started", { taskId: "t1" }, "a1"), noise];
  const engine = createRosterEngine(list);
  assert.equal(rosterEngineReplace(engine, noise, row("tool.completed", {}, "n1")), engine);
  assert.equal(rosterEngineReplace(engine, noise, row("task.progress", { taskId: "" }, "n1")), engine);
  // The engine cannot know whether it saw an ignored row, and needs not to.
  assert.equal(rosterEngineReplace(engine, row("x", {}, "never"), row("y", {}, "never")), engine);
});

test("replacing a held row by itself returns the same engine", () => {
  const started = row("task.started", { taskId: "t1", agentKind: "agent" }, "a1");
  const engine = createRosterEngine([started]);
  assert.equal(rosterEngineReplace(engine, started, started), engine);
});

test("a replacement that changes relevance, task or kind returns null", () => {
  const progress = row("task.progress", { taskId: "t1", agentKind: "agent", summary: "one" }, "p1");
  const noise = row("tool.started", { taskId: "t1" }, "n1");
  const engine = createRosterEngine([row("task.started", { taskId: "t1" }, "a1"), progress, noise]);
  const cases: Array<[string, ThreadActivityItem, ThreadActivityItem]> = [
    ["relevant → ignored (payload)", progress, row("task.progress", null, "p1")],
    ["relevant → ignored (task id)", progress, row("task.progress", { taskId: " " }, "p1")],
    ["relevant → ignored (kind)", progress, row("tool.started", { taskId: "t1" }, "p1")],
    ["ignored → relevant", noise, row("task.progress", { taskId: "t1" }, "n1")],
    ["another task", progress, row("task.progress", { taskId: "t2" }, "p1")],
    ["another kind", progress, row("task.updated", { taskId: "t1" }, "p1")],
    ["another kind (a task row becomes a heartbeat)", progress, row("tool.progress", { taskId: "t1" }, "p1")]
  ];
  for (const [label, previous, next] of cases) {
    assert.equal(rosterEngineReplace(engine, previous, next), null, label);
  }
});

test("a replacement of a row the engine does not hold — or holds twice — returns null", () => {
  const started = row("task.started", { taskId: "t1", agentKind: "agent" }, "a1");
  const progress = row("task.progress", { taskId: "t1", summary: "one" }, "p1");
  const engine = createRosterEngine([started, progress]);

  const stranger = row("task.progress", { taskId: "t1", summary: "never appended" }, "p9");
  assert.equal(rosterEngineReplace(engine, stranger, row("task.progress", { taskId: "t1" }, "p9")), null);
  const unknownTask = row("task.progress", { taskId: "t7" }, "p7");
  assert.equal(rosterEngineReplace(engine, unknownTask, row("task.progress", { taskId: "t7" }, "p7")), null);

  // Replaced away: the old object is no longer a row of the list.
  const progress2 = row("task.progress", { taskId: "t1", summary: "two" }, "p1");
  const replaced = rosterEngineReplace(engine, progress, progress2);
  assert.ok(replaced !== null && replaced !== engine);
  assert.equal(rosterEngineReplace(replaced, progress, row("task.progress", { taskId: "t1" }, "p1")), null);

  // The same object at two positions: which one the caller replaced is unknowable.
  const twice = rosterEngineAppend(engine, progress);
  assert.equal(rosterEngineReplace(twice, progress, progress2), null);
});

test("a padded task id is the same task on every path", () => {
  const started = row("task.started", { taskId: " t1 ", agentKind: "agent", title: "Padded" }, "a1", stampAt(1));
  const progress = row("task.progress", { taskId: "t1", summary: "one" }, "p1", stampAt(2));
  const list = [started, progress];
  let engine = createRosterEngine([started]);
  engine = rosterEngineAppend(engine, progress);
  assertInvariant(engine, list, "append");
  const progress2 = row("task.progress", { taskId: "t1\n", summary: "two" }, "p1", stampAt(3));
  const replaced = rosterEngineReplace(engine, progress, progress2);
  assert.ok(replaced !== null);
  list[1] = progress2;
  assertInvariant(replaced, list, "replace");
  assert.deepStrictEqual(rosterFromEngine(replaced).map((agent) => agent.id), ["t1"]);
});

test("a task seen only through tool.progress has no row until a task row creates it, and then comes last", () => {
  const list: ThreadActivityItem[] = [];
  let engine = createRosterEngine([]);
  const step = (activity: ThreadActivityItem): void => {
    list.push(activity);
    engine = rosterEngineAppend(engine, activity);
    assertInvariant(engine, list, activity.id);
  };
  step(row("tool.progress", { taskId: "late", toolName: "Bash" }, "h1", stampAt(1)));
  assert.deepStrictEqual(rosterFromEngine(engine), []);
  step(row("task.started", { taskId: "early", agentKind: "agent" }, "a1", stampAt(2)));
  // A heartbeat of a task with no agent is held (it can be replaced in place)…
  const heartbeat = list[0]!;
  const beat2 = row("tool.progress", { taskId: "late", toolName: "Read" }, "h1", stampAt(3));
  const replaced = rosterEngineReplace(engine, heartbeat, beat2);
  assert.ok(replaced !== null && replaced !== engine);
  engine = replaced;
  list[0] = beat2;
  assertInvariant(engine, list, "heartbeat replaced");
  // …but the agent is created by its first task row, which orders it.
  step(row("task.progress", { taskId: "late", agentKind: "agent", summary: "now known" }, "p1", stampAt(4)));
  step(row("tool.progress", { taskId: "late", toolName: "Grep" }, "h2", stampAt(5)));
  assert.deepStrictEqual(rosterFromEngine(engine).map((agent) => agent.id), ["early", "late"]);
  assert.equal(byId(rosterFromEngine(engine), "late").lastToolName, "Grep");
});

test("an append to one task hands every other task's row back as the same object, live or dead", () => {
  const list = [
    row("task.started", { taskId: "a", agentKind: "agent" }, "a1", stampAt(1)),
    row("task.started", { taskId: "b", agentKind: "agent" }, "b1", stampAt(2)),
    row("task.started", { taskId: "wf", agentKind: "agent", taskType: "local_workflow" }, "w1", stampAt(3)),
    row("task.started", { taskId: "m", agentKind: "agent", parentAgentId: "wf" }, "m1", stampAt(4)),
    row("task.completed", { taskId: "wf", status: "completed" }, "w2", stampAt(5))
  ];
  const engine = createRosterEngine(list);
  const next = rosterEngineAppend(
    engine,
    row("task.progress", { taskId: "a", summary: "working" }, "a2", stampAt(6))
  );
  for (const options of OPTIONS) {
    const before = rosterFromEngine(engine, options);
    const after = rosterFromEngine(next, options);
    assert.notEqual(byId(after, "a"), byId(before, "a"), "the touched task is a new row");
    for (const id of ["b", "wf", "m"]) {
      // `b` is moved to interrupted by a dead session, `m` by its settled
      // coordinator: a row the post-passes moved is reused too.
      assert.equal(byId(after, id), byId(before, id), `${id} (${optionLabel(options)})`);
    }
  }
  assert.equal(byId(rosterFromEngine(next, { sessionLive: false }), "b").status, "interrupted");
  assert.equal(byId(rosterFromEngine(next), "m").status, "completed");
});

test("an in-place replacement refolds its own task alone", () => {
  const progress = row("task.progress", { taskId: "a", summary: "one" }, "task-progress:a", stampAt(3));
  const list = [
    row("task.started", { taskId: "a", agentKind: "agent" }, "a1", stampAt(1)),
    row("task.started", { taskId: "b", agentKind: "agent" }, "b1", stampAt(2)),
    progress,
    row("tool.progress", { taskId: "a", toolName: "Bash" }, "tool-progress:a", stampAt(4))
  ];
  const engine = createRosterEngine(list);
  const progress2 = row("task.progress", { taskId: "a", summary: "two" }, "task-progress:a", stampAt(5));
  const next = rosterEngineReplace(engine, progress, progress2);
  assert.ok(next !== null);
  list[2] = progress2;
  assertInvariant(next, list, "replaced");
  assert.equal(byId(rosterFromEngine(next), "b"), byId(rosterFromEngine(engine), "b"));
  // Its position is its first emission's, its content the latest: the
  // heartbeat after it still folds after it.
  const a = byId(rosterFromEngine(next), "a");
  assert.equal(a.progress, "two");
  assert.equal(a.updatedAt, stampAt(4));
  assert.deepStrictEqual(a.recentActivity.map((entry) => entry.summary), ["two", "▸ Bash"]);
});

test("nothing is mutated: rows, handed-out rows, and an engine two branches grew from", () => {
  const base = [
    row("task.started", { taskId: "a", agentKind: "agent", toolUseId: "t_a0" }, "a1", stampAt(1)),
    row("task.progress", { taskId: "a", summary: "one", usage: { totalTokens: 5, inputTokens: 3 } }, "task-progress:a", stampAt(2)),
    row("task.started", { taskId: "wf", agentKind: "agent", taskType: "local_workflow", phases: [{ index: 0, title: "Plan" }] }, "w1", stampAt(3)),
    row("task.started", { taskId: "m", agentKind: "agent", parentAgentId: "wf", runHandles: { runId: "r" } }, "m1", stampAt(4))
  ];
  const engine = createRosterEngine(base);
  // Every row handed out is frozen: a later operation that wrote into one would throw.
  const handedOut = OPTIONS.map((options) => deepFreeze(rosterFromEngine(engine, options)));

  const left = [...base, row("task.completed", { taskId: "wf", status: "failed" }, "w2", stampAt(5))];
  const right = [...base, row("task.progress", { taskId: "a", summary: "two", usage: { totalTokens: 9 } }, "a2", stampAt(5))];
  const leftEngine = rosterEngineAppend(engine, left[4]!);
  const rightEngine = rosterEngineAppend(engine, right[4]!);
  const replacedEngine = rosterEngineReplace(
    rightEngine,
    base[1]!,
    row("task.progress", { taskId: "a", summary: "one again", usage: { totalTokens: 7, outputTokens: 2 } }, "task-progress:a", stampAt(6))
  );
  assert.ok(replacedEngine !== null);
  const replacedList = [...right];
  replacedList[1] = row("task.progress", { taskId: "a", summary: "one again", usage: { totalTokens: 7, outputTokens: 2 } }, "task-progress:a", stampAt(6));

  assertInvariant(leftEngine, left, "left branch");
  assertInvariant(rightEngine, right, "right branch");
  assertInvariant(replacedEngine, replacedList, "replaced");
  assertInvariant(engine, base, "the engine both branches grew from");
  OPTIONS.forEach((options, i) => {
    assert.deepStrictEqual(rosterFromEngine(engine, options), handedOut[i], optionLabel(options));
  });
});

test("the cap keeps creation order and reuses the rows it keeps", () => {
  const list: ThreadActivityItem[] = [];
  for (let i = 0; i < ROSTER_LIMIT + 15; i += 1) {
    list.push(row("task.started", { taskId: `t${i}`, agentKind: "agent" }, `s${i}`, stampAt(2 * i)));
    if (i % 3 !== 0) {
      list.push(row("task.completed", { taskId: `t${i}`, status: "completed" }, `c${i}`, stampAt(2 * i + 1)));
    }
  }
  const engine = createRosterEngine(list);
  assertInvariant(engine, list, "over the cap");
  const settle = row("task.completed", { taskId: "t0", status: "completed" }, "c0", stampAt(1000));
  const next = rosterEngineAppend(engine, settle);
  assertInvariant(next, [...list, settle], "one more settled");
  const before = new Map(rosterFromEngine(engine).map((agent) => [agent.id, agent]));
  for (const agent of rosterFromEngine(next)) {
    if (agent.id !== "t0" && before.has(agent.id)) assert.equal(agent, before.get(agent.id), agent.id);
  }
});

test("a coordinator settled by its parent's cascade cascades onward only when it comes after that parent", () => {
  // The old fold's order, kept: coordinators are visited in roster order and
  // read what an earlier cascade gave them.
  const outer = row("task.started", { taskId: "outer", agentKind: "agent", taskType: "local_workflow" }, "o1", stampAt(1));
  const inner = row(
    "task.started",
    { taskId: "inner", agentKind: "agent", taskType: "local_workflow", parentAgentId: "outer" },
    "i1",
    stampAt(2)
  );
  const member = row("task.started", { taskId: "member", agentKind: "agent", parentAgentId: "inner" }, "m1", stampAt(3));
  const settle = row("task.completed", { taskId: "outer", status: "completed" }, "o2", stampAt(4));
  for (const [list, memberStatus] of [
    [[outer, inner, member, settle], "completed"],
    [[inner, outer, member, settle], "running"]
  ] as const) {
    let engine = createRosterEngine([]);
    for (const activity of list) engine = rosterEngineAppend(engine, activity);
    assertInvariant(engine, list, list[0]!.id);
    const roster = rosterFromEngine(engine);
    assert.equal(byId(roster, "inner").status, "completed", "the parent's cascade settles the nested coordinator");
    assert.equal(byId(roster, "member").status, memberStatus, `the member, with ${list[0]!.id} created first`);
  }
});

test("the cap's ranking does not depend on what an earlier read — of this engine or of a branch — left behind", () => {
  // `rosterFromEngine` starts the cap's sort from the lineage's last ranking;
  // that must only ever make it faster. Ties in `updatedAt` (the stamps
  // below collide) fall to roster order, whatever order the sort started from.
  const list: ThreadActivityItem[] = [];
  for (let i = 0; i < ROSTER_LIMIT + 20; i += 1) {
    list.push(row("task.started", { taskId: `t${i}`, agentKind: "agent" }, `s${i}`, stampAt(i)));
    if (i % 4 !== 0) {
      list.push(row("task.completed", { taskId: `t${i}`, status: "completed" }, `c${i}`, stampAt(200 + ((i * 37) % 97))));
    }
  }
  const engine = createRosterEngine(list);
  assertInvariant(engine, list, "fresh");

  // Branch A settles the live rows; branch B revives settled ones.
  let a = engine;
  const listA = list.slice();
  for (let i = 0; i < ROSTER_LIMIT + 20; i += 4) {
    const settle = row("task.completed", { taskId: `t${i}`, status: "failed" }, `a${i}`, stampAt(500 + (i % 7)));
    a = rosterEngineAppend(a, settle);
    listA.push(settle);
  }
  assertInvariant(a, listA, "branch A");
  assertInvariant(engine, list, "the engine it grew from, read after branch A");
  let b = engine;
  const listB = list.slice();
  for (let i = 1; i < ROSTER_LIMIT + 20; i += 3) {
    const revive = row("task.updated", { taskId: `t${i}`, status: "running" }, `b${i}`, stampAt(900 - i));
    b = rosterEngineAppend(b, revive);
    listB.push(revive);
  }
  assertInvariant(b, listB, "branch B, read after branch A");
  assertInvariant(a, listA, "branch A, read again after branch B");
});

// ---------------------------------------------------------------------------
// Property tests: long random sequences, checked at every step
// ---------------------------------------------------------------------------

/** Seeded, so a failure names a sequence that replays exactly (mulberry32). */
class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
}

type TaskRole = "agent" | "batch" | "background" | "workflow" | "member";

interface TaskSpec {
  readonly id: string;
  readonly role: TaskRole;
  /** The coordinator a member (or a nested coordinator) names, if any. */
  readonly parent: string | null;
  /** The current launching call; a bump is a resume. */
  launch: number;
  attempt: number;
  /**
   * `lingers`: never settles through a row of its own — no terminal status,
   * no completion — like the members that never report their end, which are
   * what the coordinator cascade exists for. `finishes`: settles and stays
   * settled — terminal statuses only, never a new launching call — like a
   * coordinator whose run is over. `free`: anything goes.
   */
  readonly behavior: "free" | "lingers" | "finishes";
}

interface Scenario {
  readonly name: string;
  readonly seed: number;
  readonly steps: number;
  readonly agents: number;
  readonly backgrounds: number;
  readonly workflows: number;
  readonly membersPerWorkflow: number;
  /** Probability that a step is a row the roster ignores. */
  readonly noise: number;
  /**
   * Past this many rows the oldest are trimmed and the engine rebuilt, as the
   * fold's retention does — which also keeps the per-step reference fold cheap.
   */
  readonly maxRows: number;
  /** The first this-many steps start one task each, in order: a fleet launch. */
  readonly burst?: number;
  /** Probability of a trim at a random step, besides the `maxRows` bound. */
  readonly trimRate: number;
  /**
   * `wf-0` finishes while the coordinators nested under it and half their
   * members linger ({@link TaskSpec.behavior}): only the cascade can settle
   * them — from `wf-0` onto a nested coordinator, and onward from it.
   */
  readonly lingering?: boolean;
}

/**
 * What the sequences exercised. The first group counts engine paths; the rest
 * counts roster rules, each read off the reference rosters ({@link observe}),
 * so a generator change that stops reaching one fails its property loudly.
 */
const COVERAGE_KEYS = [
  "appends",
  "sameEngine",
  "incremental",
  "nulls",
  "trims",
  /** Steps whose roster was cut at {@link ROSTER_LIMIT}. */
  "capped",
  /** Rows a step handed back as the very object the step before did. */
  "reused",
  /** A start row naming a new launching call reopened a settled agent. */
  "resumed",
  /** A start row on a settled agent left it settled (a late delivery). */
  "lateStarts",
  /** An agent created by a terminal `task.updated` (its start aged out). */
  "firstSeenSettled",
  /** A `tool.progress` row of a task with no agent, which stays without one. */
  "heartbeatsWithoutAgent",
  /** A `tool.progress` row on an existing agent. */
  "heartbeatsOnAgent",
  /** A usage-only row that created its agent, running. */
  "usageSnapshotsCreate",
  /** A usage-only row on a pending/waiting agent, which stays so. */
  "usageSnapshotsKeepStatus",
  /** A smaller usage total that did not shrink the agent's. */
  "usageKeptMax",
  /** A provider `endedAt` that became the settling time. */
  "endedAt",
  /** A member settled by its coordinator's cascade, not by a row of its own. */
  "cascades",
  /** …and a cascaded coordinator that cascaded onward to its own members. */
  "nestedCascades",
  "background",
  /** A background row a later `agent` stamp promoted. */
  "promotions",
  /** An attempt bump on a workflow slot. */
  "attempts",
  "phases",
  "runHandles",
  /** A dead session interrupted a row the live roster reads as active. */
  "deaths"
] as const;

type Coverage = Record<(typeof COVERAGE_KEYS)[number], number>;

function emptyCoverage(): Coverage {
  return Object.fromEntries(COVERAGE_KEYS.map((key) => [key, 0])) as Coverage;
}

function taskSpecs(scenario: Scenario): TaskSpec[] {
  const specs: TaskSpec[] = [];
  for (let i = 0; i < scenario.agents; i += 1) {
    specs.push({ id: `agent-${i}`, role: i % 7 === 3 ? "batch" : "agent", parent: null, launch: 0, attempt: 1, behavior: "free" });
  }
  for (let i = 0; i < scenario.backgrounds; i += 1) {
    specs.push({ id: `shell-${i}`, role: "background", parent: null, launch: 0, attempt: 1, behavior: "free" });
  }
  for (let w = 0; w < scenario.workflows; w += 1) {
    const id = `wf-${w}`;
    // Every odd coordinator nests under the first, so a settled parent can
    // cascade onto a coordinator that cascades onward — the order-sensitive case.
    const nested = w % 2 === 1;
    const lingering = scenario.lingering === true;
    specs.push({
      id,
      role: "workflow",
      parent: nested ? "wf-0" : null,
      launch: 0,
      attempt: 1,
      behavior: lingering && nested ? "lingers" : lingering && w === 0 ? "finishes" : "free"
    });
    for (let m = 0; m < scenario.membersPerWorkflow; m += 1) {
      // Some members say so only through their id (`:wf:`), never a parent.
      const byIdOnly = m % 4 === 3;
      specs.push({
        id: byIdOnly ? `${id}:wf:m${m}` : `${id}-m${m}`,
        role: "member",
        parent: byIdOnly ? null : id,
        launch: 0,
        attempt: 1,
        behavior: lingering && nested && m % 2 === 0 ? "lingers" : "free"
      });
    }
  }
  return specs;
}

const SUMMARIES = ["reading files", "running tests", "writing the patch", "reading files", `long ${"x".repeat(200)}`];
const TOOL_NAMES = ["Read", "Bash", "Edit", "Grep"];
const UPDATE_STATUSES = ["running", "waiting", "idle", "pending", "completed", "failed", "cancelled", "interrupted", "toString", "bogus"];
const LINGERING_STATUSES = ["running", "waiting", "pending", "toString"];
const FINISHING_STATUSES = ["completed", "failed", "cancelled", "interrupted"];

function statusesOf(spec: TaskSpec): readonly string[] {
  return spec.behavior === "lingers"
    ? LINGERING_STATUSES
    : spec.behavior === "finishes"
      ? FINISHING_STATUSES
      : UPDATE_STATUSES;
}
const COMPLETED_STATUSES = ["completed", "failed", "stopped", "cancelled", "toString"];

function usage(rng: Rng): unknown {
  if (rng.chance(0.08)) {
    return rng.pick<unknown>([null, "12", { totalTokens: -1 }, { totalTokens: Number.NaN }, { inputTokens: 5 }]);
  }
  const value: Record<string, unknown> = { totalTokens: rng.int(5000) };
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "toolUses", "durationMs"]) {
    if (rng.chance(0.35)) value[key] = rng.int(3000);
  }
  return value;
}

function phases(rng: Rng): unknown {
  switch (rng.int(4)) {
    case 0:
      return [{ index: 1, title: "Build" }, { index: 0, title: "Plan" }];
    case 1:
      return [{ index: 0, title: "Plan" }, { index: 2 }, "junk", null];
    case 2:
      return [];
    default:
      return "not-a-list";
  }
}

function runHandles(rng: Rng): unknown {
  switch (rng.int(5)) {
    case 0:
      return { runId: `run-${rng.int(3)}` };
    case 1:
      return { scriptPath: "/tmp/wf.js", transcriptDir: "/tmp/t" };
    case 2:
      return { sessionUrl: "https://example.test/s/1" };
    case 3:
      return { sessionUrl: "javascript:alert(1)", runId: "r" };
    default:
      return "nope";
  }
}

/** A task row's payload: every field the fold reads, each present at random. */
function taskPayload(rng: Rng, spec: TaskSpec, kind: string, usageRow: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = { taskId: rng.chance(0.08) ? ` ${spec.id} ` : spec.id };
  // The host's stamp. An unstamped row is background; a later `agent` stamp
  // promotes the row and nothing demotes it.
  if (spec.role === "background") {
    if (rng.chance(0.6)) payload.agentKind = "background";
  } else if (rng.chance(0.8)) {
    payload.agentKind = "agent";
  } else if (rng.chance(0.3)) {
    payload.agentKind = "background";
  }

  switch (spec.role) {
    case "workflow":
      if (spec.behavior !== "free" || rng.chance(0.7)) payload.taskType = "local_workflow";
      if (rng.chance(0.3)) payload.workflowName = rng.pick(["Ship it", "Audit"]);
      if (rng.chance(0.2)) payload.phases = phases(rng);
      if (spec.parent !== null && rng.chance(0.6)) payload.parentAgentId = spec.parent;
      break;
    case "member":
      if (spec.parent !== null && rng.chance(0.6)) payload.parentAgentId = spec.parent;
      if (rng.chance(0.3)) payload.phaseIndex = rng.int(3);
      if (rng.chance(0.2)) payload.phaseTitle = rng.pick(["Plan", "Build"]);
      if (rng.chance(0.3)) payload.agentIndex = rng.int(4);
      if (rng.chance(0.3)) {
        if (rng.chance(0.5)) spec.attempt += 1;
        payload.attempt = spec.attempt;
      }
      break;
    case "batch":
      if (rng.chance(0.5)) payload.taskType = "subagent_batch";
      break;
    case "background":
      if (rng.chance(0.4)) payload.taskType = "local_bash";
      if (rng.chance(0.3)) payload.exitCode = rng.pick([0, 1, -9, 1.5]);
      if (rng.chance(0.2)) payload.outputFile = `/tmp/${spec.id}.out`;
      break;
    default:
      break;
  }
  if (rng.chance(0.1)) payload.title = rng.pick(["Reviewer", "Backend", " "]);
  if (rng.chance(0.1)) payload.description = rng.pick(["Audit the code", "Fix the tests"]);
  if (rng.chance(0.05)) payload.detail = "the detail spelling";
  if (rng.chance(0.08)) payload.role = rng.pick(["review", "impl"]);
  if (rng.chance(0.08)) payload.model = rng.pick(["opus", "sonnet"]);
  if (rng.chance(0.05)) payload.effort = "high";
  if (rng.chance(0.1)) payload.isBackgrounded = rng.chance(0.5);
  if (rng.chance(0.05)) payload.runHandles = runHandles(rng);
  if (rng.chance(0.03)) payload.outputFile = "/tmp/out";

  switch (kind) {
    case "task.started": {
      const roll = rng.next();
      if (roll < 0.25 && spec.behavior !== "finishes") spec.launch += 1; // a resume: a new launching call
      if (roll < 0.85) payload.toolUseId = `toolu_${spec.id}_${spec.launch}`;
      else if (roll < 0.93) payload.toolUseId = `toolu_${spec.id}_${Math.max(0, spec.launch - 1)}`;
      break;
    }
    case "task.progress":
      if (usageRow) {
        payload.usageSnapshot = true;
        payload.usage = usage(rng);
        if (rng.chance(0.1)) payload.typedUsage = usage(rng);
      } else {
        if (rng.chance(0.5)) payload.summary = rng.pick(SUMMARIES);
        if (rng.chance(0.3)) payload.lastToolName = rng.pick(TOOL_NAMES);
        if (rng.chance(0.2)) payload.status = rng.pick(statusesOf(spec));
        if (rng.chance(0.08)) payload.error = rng.pick(["boom", `long ${"e".repeat(200)}`]);
        if (rng.chance(0.3)) payload.usage = usage(rng);
        if (rng.chance(0.05)) payload.typedUsage = usage(rng);
        if (rng.chance(0.03)) payload.usageSnapshot = true;
      }
      // Progress rows name the NEW call before its start row arrives.
      if (rng.chance(0.3)) payload.toolUseId = `toolu_${spec.id}_${spec.launch + rng.int(2)}`;
      break;
    case "task.updated":
      if (rng.chance(0.75)) payload.status = rng.pick(statusesOf(spec));
      if (rng.chance(0.4)) payload.endedAt = stampAt(rng.int(400));
      if (rng.chance(0.1)) payload.error = "failed hard";
      break;
    case "task.completed":
      if (rng.chance(0.85)) payload.status = rng.pick(COMPLETED_STATUSES);
      if (rng.chance(0.5)) payload.summary = rng.pick(SUMMARIES);
      if (rng.chance(0.4)) payload.usage = usage(rng);
      if (rng.chance(0.05)) payload.typedUsage = usage(rng);
      break;
    case "tool.progress":
      if (rng.chance(0.85)) payload.toolName = rng.pick(TOOL_NAMES);
      break;
    default:
      break;
  }
  return payload;
}

/** A row the roster ignores: another kind, or a task kind it cannot read. */
function noisePayload(rng: Rng): [string, unknown] {
  switch (rng.int(8)) {
    case 0:
      return ["tool.started", { toolUseId: "x", taskId: "agent-0" }];
    case 1:
      return ["item.completed", { itemType: "command_execution" }];
    case 2:
      return [rng.pick(ROSTER_KINDS), null];
    case 3:
      return [rng.pick(ROSTER_KINDS), "agent-0"];
    case 4:
      return [rng.pick(ROSTER_KINDS), Object.assign(["x"], { taskId: "agent-0" })];
    case 5:
      return [rng.pick(ROSTER_KINDS), { taskId: "   ", agentKind: "agent" }];
    case 6:
      return [rng.pick(ROSTER_KINDS), { taskId: 7, agentKind: "agent" }];
    default:
      return [rng.pick(ROSTER_KINDS), { agentKind: "agent", status: "running" }];
  }
}

type Outcome = "same" | "null" | "new";

/** What `rosterEngineReplace` owes for this change, from the documented rules alone. */
function expectedReplace(
  list: readonly ThreadActivityItem[],
  previous: ThreadActivityItem,
  next: ThreadActivityItem
): Outcome {
  const before = taskIdOf(previous);
  const after = taskIdOf(next);
  if (before === undefined && after === undefined) return "same";
  if (before === undefined || before !== after || previous.activityKind !== next.activityKind) {
    return "null";
  }
  const held = list.filter((item) => item === previous).length;
  if (held !== 1) return "null";
  return previous === next ? "same" : "new";
}

const VALID_STATUSES: ReadonlySet<unknown> = new Set([
  "pending",
  "running",
  "waiting",
  "idle",
  "completed",
  "failed",
  "cancelled",
  "interrupted"
]);

function settled(agent: RuntimeSubagent | undefined): boolean {
  return agent !== undefined && TERMINAL_SUBAGENT_STATUSES.has(agent.status);
}

/** The usage total a row carries as the fold reads it: `usage`, else `typedUsage`. */
function usageTotal(payload: Record<string, unknown>): number | undefined {
  for (const value of [payload.usage, payload.typedUsage]) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const total = (value as Record<string, unknown>).totalTokens;
    if (typeof total === "number" && Number.isFinite(total) && total >= 0) return total;
  }
  return undefined;
}

/**
 * `member` was settled by `workflow`'s cascade, not by a row of its own: its
 * roster row is settled while the fold of its own rows alone — no coordinator
 * in the list, nothing to cascade — is still live. The cascade stamps the
 * coordinator's `updatedAt` on the member, a cheap filter before that fold.
 */
function cascaded(
  member: RuntimeSubagent,
  workflow: RuntimeSubagent,
  list: readonly ThreadActivityItem[]
): boolean {
  if (member.parentAgentId !== workflow.id || member.id === workflow.id) return false;
  if (!settled(member) || member.updatedAt !== workflow.updatedAt) return false;
  const own = foldSubagentActivities(list.filter((item) => taskIdOf(item) === member.id))[0];
  return own !== undefined && !settled(own) && own.status !== "idle";
}

interface Placed {
  readonly activity: ThreadActivityItem;
  /** Landed at the END of the list: its effect is the row applied to the state before it. */
  readonly appended: boolean;
}

/**
 * Counts which roster rules a step demonstrably exercised, off the reference
 * rosters (the engine's equal them): `before`/`live` read without a session
 * death, `dead` with one.
 */
function observe(
  counts: Coverage,
  placed: Placed | null,
  before: readonly RuntimeSubagent[] | null,
  live: readonly RuntimeSubagent[],
  dead: readonly RuntimeSubagent[],
  list: readonly ThreadActivityItem[]
): void {
  const now = new Map(live.map((agent) => [agent.id, agent]));
  if (live.some((agent) => agent.agentKind === "background")) counts.background += 1;
  if (live.some((agent) => agent.kind === "workflow" && agent.phases.length > 0)) counts.phases += 1;
  if (live.some((agent) => agent.runHandles !== null)) counts.runHandles += 1;
  const died = dead.some((agent) => {
    const alive = now.get(agent.id);
    return agent.status === "interrupted" && alive !== undefined && ACTIVE_SUBAGENT_STATUSES.has(alive.status);
  });
  if (died) counts.deaths += 1;
  // A cascade persists from step to step: enough sightings prove the rule
  // is reached, and stop the own-rows folds from adding up.
  if (counts.cascades < 40 || counts.nestedCascades < 8) {
    for (const workflow of live) {
      if (workflow.kind !== "workflow" || !settled(workflow)) continue;
      for (const member of live) {
        if (!cascaded(member, workflow, list)) continue;
        counts.cascades += 1;
        if (member.kind === "workflow" && live.some((inner) => cascaded(inner, member, list))) {
          counts.nestedCascades += 1;
        }
      }
    }
  }

  // One row's own effect: read only for a row appended at the end, and only
  // while no row hides behind the cap.
  if (placed === null || !placed.appended || before === null) return;
  if (before.length >= ROSTER_LIMIT || live.length >= ROSTER_LIMIT) return;
  const taskId = taskIdOf(placed.activity);
  if (taskId === undefined) return;
  const was = before.find((agent) => agent.id === taskId);
  const is = now.get(taskId);
  const payload = placed.activity.payload as Record<string, unknown>;
  switch (placed.activity.activityKind) {
    case "task.started":
      if (was !== undefined && is !== undefined && settled(was)) {
        if (!settled(is) && is.activationCount === was.activationCount + 1) counts.resumed += 1;
        if (settled(is) && is.activationCount === was.activationCount) counts.lateStarts += 1;
      }
      break;
    case "task.updated":
      if (was === undefined && settled(is)) counts.firstSeenSettled += 1;
      if (
        typeof payload.endedAt === "string" &&
        is !== undefined &&
        settled(is) &&
        !settled(was) &&
        is.completedAt === payload.endedAt.trim()
      ) {
        counts.endedAt += 1;
      }
      break;
    case "tool.progress":
      if (was === undefined && is === undefined) counts.heartbeatsWithoutAgent += 1;
      if (was !== undefined && is !== undefined) counts.heartbeatsOnAgent += 1;
      break;
    case "task.progress":
      if (payload.usageSnapshot === true && !VALID_STATUSES.has(payload.status)) {
        if (was === undefined && is?.status === "running") counts.usageSnapshotsCreate += 1;
        if ((was?.status === "pending" || was?.status === "waiting") && is?.status === was.status) {
          counts.usageSnapshotsKeepStatus += 1;
        }
      }
      break;
    default:
      break;
  }
  const kind = placed.activity.activityKind;
  if ((kind === "task.progress" || kind === "task.completed") && was?.usage && is?.usage) {
    const incoming = usageTotal(payload);
    if (incoming !== undefined && incoming < was.usage.totalTokens && is.usage.totalTokens === was.usage.totalTokens) {
      counts.usageKeptMax += 1;
    }
  }
  if (was?.agentKind === "background" && is?.agentKind === "agent") counts.promotions += 1;
  if (was?.attempt != null && is?.attempt != null && is.attempt > was.attempt) counts.attempts += 1;
}

/**
 * Plays `scenario` the way the thread fold drives the engine: a row whose id
 * the list already holds replaces it IN PLACE (`reduceActivityAppended`), any
 * other row is appended, a `null` replacement rebuilds from the current list,
 * and an occasional trim drops the oldest rows and rebuilds (retention).
 */
function runScenario(scenario: Scenario, counts: Coverage): void {
  const rng = new Rng(scenario.seed);
  const specs = taskSpecs(scenario);
  // Half the task rows go to a few "hot" tasks, so their stable-id rows are
  // replaced in place again and again, as a working agent's are.
  const hot = specs.slice().sort(() => rng.next() - 0.5).slice(0, 8);
  let list: ThreadActivityItem[] = [];
  let positions = new Map<string, number>();
  let engine: RosterEngine = createRosterEngine([]);
  let second = 0;
  let nextId = 0;
  let previousRosters: RuntimeSubagent[][] | null = null;
  const retired: ThreadActivityItem[] = [];
  const keptRosters: Array<{ roster: RuntimeSubagent[]; snapshot: RuntimeSubagent[] }> = [];
  const keptEngines: Array<{ engine: RosterEngine; list: ThreadActivityItem[] }> = [];

  const stamp = (): string => {
    const roll = rng.next();
    if (roll < 0.05) return stampAt(second - 1 - rng.int(30)); // out of order
    if (roll > 0.12) second += 1 + rng.int(3); // else: the same second again
    return stampAt(second);
  };
  const reindex = (): void => {
    positions = new Map();
    list.forEach((item, at) => {
      if (!positions.has(item.id)) positions.set(item.id, at);
    });
  };

  for (let step = 0; step < scenario.steps; step += 1) {
    const label = `${scenario.name} seed ${scenario.seed} step ${step}`;
    // `touched`: the task this step may change. `undefined` after a rebuild,
    // which owes no identity reuse.
    // (Asserted, not annotated: `place` assigns it, and a narrowing to `null`
    // would survive the call.)
    let touched = null as string | null | undefined;
    let placed: Placed | null = null as Placed | null;
    const roll = rng.next();

    const place = (activity: ThreadActivityItem): void => {
      const at = positions.get(activity.id);
      if (at === undefined) {
        const next = rosterEngineAppend(engine, activity);
        if (taskIdOf(activity) === undefined) {
          assert.equal(next, engine, `${label}: an ignored append returns the same engine`);
          counts.sameEngine += 1;
        } else {
          assert.notEqual(next, engine, `${label}: a roster append is a new engine`);
          counts.appends += 1;
        }
        touched = taskIdOf(activity) ?? null;
        engine = next;
        list.push(activity);
        positions.set(activity.id, list.length - 1);
        placed = { activity, appended: true };
        return;
      }
      const previous = list[at]!;
      const expected = expectedReplace(list, previous, activity);
      const next = rosterEngineReplace(engine, previous, activity);
      list[at] = activity;
      retired.push(previous);
      placed = { activity, appended: false };
      if (expected === "same") {
        assert.equal(next, engine, `${label}: replacement expected to keep the engine`);
        counts.sameEngine += 1;
        touched = null;
      } else if (expected === "null") {
        assert.equal(next, null, `${label}: replacement expected to be refused`);
        counts.nulls += 1;
        engine = createRosterEngine(list);
        touched = undefined;
      } else {
        assert.ok(next !== null && next !== engine, `${label}: replacement expected to apply`);
        counts.incremental += 1;
        engine = next;
        touched = taskIdOf(activity);
      }
    };

    if (step < (scenario.burst ?? 0)) {
      const spec = specs[step % specs.length]!;
      place(row("task.started", taskPayload(rng, spec, "task.started", false), `a${nextId++}`, stamp()));
    } else if (roll < scenario.noise) {
      const [kind, payload] = noisePayload(rng);
      // A few stable ids so an ignored row is replaced in place too — mostly
      // by another ignored row, sometimes by a task row (relevance changes).
      const stable = rng.chance(0.4);
      const id = stable ? `noise:${rng.int(3)}` : `n${nextId++}`;
      if (stable && positions.has(id) && rng.chance(0.25)) {
        const spec = rng.pick(specs);
        place(row("task.progress", taskPayload(rng, spec, "task.progress", false), id, stamp()));
      } else {
        place(row(kind, payload, id, stamp()));
      }
    } else if (list.length > scenario.maxRows || (roll < scenario.noise + scenario.trimRate && list.length > 20)) {
      // Retention: the oldest rows go, and the fold rebuilds its engine.
      list = list.slice(Math.floor(list.length * (0.1 + rng.next() * 0.3)));
      reindex();
      engine = createRosterEngine(list);
      counts.trims += 1;
      touched = undefined;
    } else if (roll < scenario.noise + scenario.trimRate + 0.006 && list.length > 0) {
      // The same object appended twice: legal for an engine, and a later
      // replacement of it is ambiguous.
      const again = list[rng.int(list.length)]!;
      const next = rosterEngineAppend(engine, again);
      touched = taskIdOf(again) ?? null;
      engine = next;
      list.push(again);
      placed = { activity: again, appended: true };
    } else if (roll < scenario.noise + scenario.trimRate + 0.012 && retired.length > 0) {
      // A probe with a row the engine no longer holds: refused, nothing moves.
      const stale = rng.pick(retired);
      if (!list.includes(stale) && taskIdOf(stale) !== undefined) {
        const probe = row(stale.activityKind, stale.payload, stale.id, stamp());
        assert.equal(rosterEngineReplace(engine, stale, probe), null, `${label}: an unheld row is refused`);
      }
    } else {
      const spec = rng.chance(0.5) ? rng.pick(hot) : rng.pick(specs);
      const picked = rng.pick([
        "task.started",
        "task.started",
        "task.progress",
        "task.progress",
        "task.progress",
        "task-usage",
        "tool.progress",
        "tool.progress",
        "task.updated",
        "task.completed"
      ]);
      const kind = spec.behavior === "lingers" && picked === "task.completed" ? "task.updated" : picked;
      const usageRow = kind === "task-usage";
      const activityKind = usageRow ? "task.progress" : kind;
      // The host's stable ids: one "latest state" row per task and stream,
      // replaced in place (`message-ids.ts`); everything else is unique.
      // (A usage row sometimes arrives under a unique id — an older host's.)
      const id =
        kind === "task.progress"
          ? `task-progress:${spec.id}`
          : usageRow && rng.chance(0.7)
            ? `task-usage:${spec.id}`
            : kind === "tool.progress"
              ? `tool-progress:${spec.id}`
              : `a${nextId++}`;
      let payload: unknown = taskPayload(rng, spec, activityKind, usageRow);
      let finalKind = activityKind;
      if (positions.has(id) && rng.chance(0.05)) {
        // A replacement the engine must refuse: another kind, another task,
        // or a payload the roster cannot read.
        const change = rng.int(3);
        if (change === 0) finalKind = rng.pick(ROSTER_KINDS.filter((k) => k !== activityKind));
        else if (change === 1) payload = taskPayload(rng, rng.pick(specs), activityKind, usageRow);
        else payload = null;
      }
      place(row(finalKind, payload, id, stamp()));
    }

    // The invariant, at every step, for every session liveness.
    const rosters = OPTIONS.map((options) => {
      const actual = rosterFromEngine(engine, options);
      assertSameRoster(actual, foldSubagentActivities(list, options), `${label} (${optionLabel(options)})`);
      return actual;
    });
    if (rosters[0]!.length === ROSTER_LIMIT) counts.capped += 1;
    observe(counts, placed, previousRosters?.[0] ?? null, rosters[0]!, rosters[1]!, list);

    // Structural sharing: an incremental step hands back the same object for
    // every agent whose row it did not change.
    if (previousRosters !== null && touched !== undefined) {
      rosters.forEach((roster, i) => {
        const before = new Map(previousRosters![i]!.map((agent) => [agent.id, agent]));
        for (const agent of roster) {
          const old = before.get(agent.id);
          if (old === agent) counts.reused += 1;
          if (old === undefined || old === agent || agent.id === touched) continue;
          assert.ok(
            !isDeepStrictEqual(old, agent),
            `${label}: unchanged row ${agent.id} came back as a new object (${optionLabel(OPTIONS[i])})`
          );
        }
      });
    }
    previousRosters = rosters;

    if (step % 40 === 0) {
      keptRosters.push({ roster: rosters[1]!, snapshot: structuredClone(rosters[1]!) });
      keptEngines.push({ engine, list: list.slice() });
    }
  }

  // Nothing handed out, and no engine left behind, moved since.
  for (const { roster, snapshot } of keptRosters) {
    assert.deepStrictEqual(roster, snapshot, `${scenario.name} seed ${scenario.seed}: a handed-out roster changed`);
  }
  for (const [i, kept] of keptEngines.entries()) {
    assertInvariant(kept.engine, kept.list, `${scenario.name} seed ${scenario.seed}: kept engine ${i}`);
    // And an old engine still branches correctly.
    const spec = rng.pick(specs);
    const branchRow = row("task.progress", taskPayload(rng, spec, "task.progress", false), `branch-${i}`, stampAt(second + 1));
    assertInvariant(rosterEngineAppend(kept.engine, branchRow), [...kept.list, branchRow], `${scenario.name}: branch ${i}`);
  }

}

/**
 * Runs every seed, then checks the sequences exercised every engine path and
 * every roster rule in `expects`.
 */
function runProperty(
  seeds: readonly number[],
  scenario: Omit<Scenario, "seed">,
  expects: ReadonlyArray<keyof Coverage>
): Coverage {
  const counts = emptyCoverage();
  for (const seed of seeds) {
    runScenario({ ...scenario, seed }, counts);
  }
  const label = `${scenario.name}: ${JSON.stringify(counts)}`;
  for (const key of ["appends", "sameEngine", "incremental", "reused", ...expects] as const) {
    assert.ok(counts[key] > 0, `${scenario.name} never exercised "${key}" — ${label}`);
  }
  assert.ok(counts.incremental > counts.nulls, `mostly incremental replacements — ${label}`);
  if (scenario.trimRate > 0) assert.ok(counts.trims > 0, label);
  return counts;
}

test("property: a mixed fleet with workflows keeps the invariant at every step", () => {
  runProperty(
    [1, 2, 3, 4, 5, 6],
    {
      name: "fleet",
      steps: 160,
      agents: 14,
      backgrounds: 4,
      workflows: 3,
      membersPerWorkflow: 4,
      noise: 0.15,
      maxRows: 140,
      trimRate: 0.006
    },
    [
      "nulls",
      "resumed",
      "lateStarts",
      "firstSeenSettled",
      "heartbeatsWithoutAgent",
      "heartbeatsOnAgent",
      "usageSnapshotsCreate",
      "usageSnapshotsKeepStatus",
      "usageKeptMax",
      "endedAt",
      "cascades",
      "background",
      "promotions",
      "attempts",
      "runHandles",
      "deaths"
    ]
  );
});

test("property: a few long-lived tasks (deep per-task histories, resumes, attempts)", () => {
  runProperty(
    [11, 12, 13],
    {
      name: "deep",
      steps: 200,
      agents: 3,
      backgrounds: 1,
      workflows: 1,
      membersPerWorkflow: 3,
      noise: 0.1,
      maxRows: 120,
      trimRate: 0.006
    },
    ["nulls", "resumed", "lateStarts", "attempts", "phases", "usageKeptMax", "runHandles", "deaths"]
  );
});

test("property: workflow-heavy threads (cascades, nested coordinators)", () => {
  runProperty(
    [21, 22, 23],
    {
      name: "workflows",
      steps: 160,
      agents: 2,
      backgrounds: 1,
      workflows: 4,
      membersPerWorkflow: 5,
      noise: 0.1,
      maxRows: 140,
      trimRate: 0.006,
      lingering: true,
      // One start row per task in spec order (27 tasks): every coordinator
      // before its members, and `wf-0` before the coordinators nested under it.
      burst: 27
    },
    ["nulls", "cascades", "nestedCascades", "phases", "attempts", "deaths"]
  );
});

test("property: more agents than ROSTER_LIMIT (the cap and its order)", () => {
  const steps = 240;
  const burst = ROSTER_LIMIT + 10;
  const counts = runProperty(
    [31, 32],
    {
      name: "over the cap",
      steps,
      agents: ROSTER_LIMIT + 5,
      backgrounds: 15,
      workflows: 1,
      membersPerWorkflow: 4,
      noise: 0.05,
      // Room for every task's start row: past the burst only `maxRows` trims,
      // so the roster stays over the cap for the rest of the run.
      maxRows: 320,
      trimRate: 0,
      burst
    },
    // The per-row rules are read only below the cap (`observe`); this
    // property is about the cap itself.
    ["background", "deaths"]
  );
  assert.ok(counts.capped >= 2 * (steps - burst), `the cap held after the burst: ${JSON.stringify(counts)}`);
});
