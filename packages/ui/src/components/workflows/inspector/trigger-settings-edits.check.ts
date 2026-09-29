/**
 * What the trigger forms WRITE (`TriggerSettings.tsx`): re-picking the kind
 * that is already chosen (schedule frequency, repository, event) writes
 * nothing, and every edit keeps the rest of the stored object — including
 * fields this build does not know, which configs pass through (AGENTS.md).
 *
 * The package has no DOM to click in, so this calls the form component once
 * with a minimal hook dispatcher (state = initial values, effects skipped),
 * walks the element tree it returns for the control by its label, and calls
 * that control's handler — the same function a click would call. The editor
 * is a recorder: each `change` is applied to a copy of the workflow so the
 * written config can be compared.
 */

import assert from "node:assert/strict";
import React, { isValidElement, type ReactElement, type ReactNode } from "react";

import type { Workflow, WorkflowNode } from "@orquester/api";

import { node as makeNode, workflow as makeWorkflow } from "../../../lib/workflows/testing";
import { InspectorContext, type InspectorContextValue } from "./inspector-context";
import { GitSettings, ScheduleSettings } from "./TriggerSettings";

// --- Harness ---------------------------------------------------------------

type Dispatcher = Record<string, unknown>;
const internals = (React as unknown as {
  __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: Dispatcher | null } };
}).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;

/** Calls `form` for `node` and returns its element tree plus the configs its edits write. */
function mount(form: React.FC, node: WorkflowNode, wf: Partial<Workflow> = {}) {
  let workflow = { ...makeWorkflow([]), ...wf, nodes: [node] } as Workflow;
  const writes: unknown[] = [];
  const editor = {
    change(recipe: (draft: Workflow) => Workflow) {
      workflow = recipe(workflow);
      writes.push(workflow.nodes[0]!.config);
    }
  } as unknown as InspectorContextValue["editor"];
  const context: InspectorContextValue = {
    editor,
    workflow,
    node,
    readOnly: false,
    projectPath: "",
    secretNames: [],
    scope: {} as InspectorContextValue["scope"],
    promptScope: {} as InspectorContextValue["promptScope"],
    problems: [],
    openSecrets: () => undefined,
    reveal: null
  };
  const orquester = { runtime: "web", api: {}, useTitlebar: false };
  const readContext = (ctx: { _currentValue: unknown }): unknown =>
    ctx === (InspectorContext as unknown) ? context : ctx._currentValue === null ? orquester : ctx._currentValue;
  const dispatcher: Dispatcher = {
    readContext,
    useContext: readContext,
    useState: (init: unknown) => [typeof init === "function" ? (init as () => unknown)() : init, () => undefined],
    useReducer: (_reducer: unknown, init: unknown, initFn?: (value: unknown) => unknown) => [initFn ? initFn(init) : init, () => undefined],
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
    useInsertionEffect: () => undefined,
    useMemo: (factory: () => unknown) => factory(),
    useCallback: (callback: unknown) => callback,
    useRef: (current: unknown) => ({ current }),
    useId: () => ":id:",
    useDebugValue: () => undefined,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot()
  };
  const previous = internals.current;
  internals.current = dispatcher;
  let tree: ReactNode;
  try {
    tree = form({});
  } finally {
    internals.current = previous;
  }
  return { tree, writes };
}

/** Every element in `tree`, looking inside children and element-valued props. */
function* elements(tree: ReactNode): Generator<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(tree)) {
    for (const child of tree) yield* elements(child);
    return;
  }
  if (!isValidElement(tree)) return;
  const element = tree as ReactElement<Record<string, unknown>>;
  yield element;
  for (const value of Object.values(element.props)) {
    if (isValidElement(value) || Array.isArray(value)) yield* elements(value as ReactNode);
  }
}

/** The `handler` prop of the one element whose `key` prop equals `value` and that has that handler. */
function control(tree: ReactNode, key: string, value: string, handler: string): unknown {
  const found = [...elements(tree)].filter((element) => element.props[key] === value && typeof element.props[handler] === "function");
  assert.equal(found.length, 1, `one control with ${key}=${JSON.stringify(value)} and ${handler}`);
  return found[0]!.props[handler];
}

const FUTURE = { keep: true };
const call = (handler: unknown, ...args: unknown[]): void => (handler as (...values: unknown[]) => void)(...args);

// --- Schedule --------------------------------------------------------------

const schedule = (preset: Record<string, unknown>, cron: string) =>
  makeNode("s1", "trigger.schedule", { preset: { ...preset, futureField: FUTURE }, cron, futureTop: FUTURE }, { name: "Nightly" });

{
  // Re-picking the current frequency writes nothing, for every frequency.
  const cases: [Record<string, unknown>, string][] = [
    [{ kind: "minutes", every: 5 }, "*/5 * * * *"],
    [{ kind: "hours", every: 6, atMinute: 45 }, "45 */6 * * *"],
    [{ kind: "daily", time: "07:30" }, "30 7 * * *"],
    [{ kind: "weekly", days: [0, 6], time: "10:00" }, "0 10 * * 0,6"],
    [{ kind: "monthly", day: 28, time: "23:15" }, "15 23 28 * *"],
    [{ kind: "cron" }, "0 9 * * 1-5"]
  ];
  for (const [preset, cron] of cases) {
    const { tree, writes } = mount(ScheduleSettings, schedule(preset, cron));
    call(control(tree, "label", "How often it runs", "onChange"), preset.kind);
    assert.deepEqual(writes, [], `re-picking ${String(preset.kind)} keeps the schedule`);
  }
  // Another frequency does switch.
  const { tree, writes } = mount(ScheduleSettings, schedule({ kind: "daily", time: "07:30" }, "30 7 * * *"));
  call(control(tree, "label", "How often it runs", "onChange"), "weekly");
  assert.deepEqual(writes, [{ preset: { kind: "weekly", days: [1, 2, 3, 4, 5], time: "07:30" }, cron: "30 7 * * 1,2,3,4,5", futureTop: FUTURE }]);
}

{
  // Edits within a frequency keep the preset's unknown fields.
  const minutes = mount(ScheduleSettings, schedule({ kind: "minutes", every: 5 }, "*/5 * * * *"));
  call(control(minutes.tree, "label", "Minutes between runs", "onValue"), 10);
  assert.deepEqual(minutes.writes, [{ preset: { kind: "minutes", every: 10, futureField: FUTURE }, cron: "*/10 * * * *", futureTop: FUTURE }]);

  const daily = mount(ScheduleSettings, schedule({ kind: "daily", time: "07:30" }, "30 7 * * *"));
  call(control(daily.tree, "ariaLabel", "Time of day", "onValue"), "08:15");
  assert.deepEqual(daily.writes, [{ preset: { kind: "daily", time: "08:15", futureField: FUTURE }, cron: "15 8 * * *", futureTop: FUTURE }]);

  const cron = mount(ScheduleSettings, schedule({ kind: "cron" }, "0 9 * * 1-5"));
  const input = [...elements(cron.tree)].find((element) => element.props.placeholder === "0 9 * * 1-5");
  assert.ok(input, "the cron input");
  call(input.props.onValue, "0 10 * * 1-5");
  assert.deepEqual(cron.writes, [{ preset: { kind: "cron", futureField: FUTURE }, cron: "0 10 * * 1-5", futureTop: FUTURE }]);
}

// --- Git -------------------------------------------------------------------

const git = (repo: Record<string, unknown>, event: Record<string, unknown>) =>
  makeNode("g1", "trigger.git", { repo: { ...repo, futureField: FUTURE }, event: { ...event, futureField: FUTURE } }, { name: "OnPush" });

{
  // Re-picking "Another repository" keeps the URL and the account; switching does switch.
  const repo = { kind: "url", url: "git@github.com:acme/app.git", accountId: "a1" };
  const same = mount(GitSettings, git(repo, { kind: "push", branches: [] }));
  call(control(same.tree, "label", "Which repository", "onChange"), "url");
  assert.deepEqual(same.writes, []);
  const project = mount(GitSettings, git({ kind: "project" }, { kind: "push", branches: [] }));
  call(control(project.tree, "label", "Which repository", "onChange"), "project");
  assert.deepEqual(project.writes, []);
  call(control(project.tree, "label", "Which repository", "onChange"), "url");
  assert.deepEqual((project.writes[0] as { repo: unknown }).repo, { kind: "url", url: "" });
}

{
  // Changing the account keeps the URL and the repository's unknown fields; "public" drops only the account.
  const repo = { kind: "url", url: "git@github.com:acme/app.git", accountId: "a1" };
  const { tree, writes } = mount(GitSettings, git(repo, { kind: "push", branches: [] }));
  const select = [...elements(tree)].find((element) => element.props.value === "a1" && typeof element.props.onValue === "function");
  assert.ok(select, "the Access select");
  call(select.props.onValue, "");
  assert.deepEqual((writes[0] as { repo: unknown }).repo, { kind: "url", url: "git@github.com:acme/app.git", futureField: FUTURE });
}

{
  // Re-picking the current event writes nothing, for every event.
  const events: Record<string, unknown>[] = [
    { kind: "push", branches: ["main", "release/*"] },
    { kind: "tag", pattern: "release-*" },
    { kind: "release", includePrereleases: true },
    { kind: "pull_request", actions: ["merged"], baseBranches: ["main"] }
  ];
  for (const event of events) {
    const { tree, writes } = mount(GitSettings, git({ kind: "project" }, event));
    call(control(tree, "label", "Event", "onChange"), event.kind);
    assert.deepEqual(writes, [], `re-picking ${String(event.kind)} keeps it`);
  }
}

{
  // Edits within an event keep its other (and unknown) fields.
  const push = mount(GitSettings, git({ kind: "project" }, { kind: "push", branches: ["main"] }));
  call(control(push.tree, "label", "Branches", "onChange"), ["main", "dev"]);
  assert.deepEqual((push.writes[0] as { event: unknown }).event, { kind: "push", branches: ["main", "dev"], futureField: FUTURE });

  const tag = mount(GitSettings, git({ kind: "project" }, { kind: "tag", pattern: "v*" }));
  call(control(tag.tree, "aria-label", "Tag pattern", "onValue"), "");
  assert.deepEqual((tag.writes[0] as { event: unknown }).event, { kind: "tag", futureField: FUTURE });

  const release = mount(GitSettings, git({ kind: "project" }, { kind: "release", includePrereleases: false }));
  call(control(release.tree, "label", "Include pre-releases", "onChange"), true);
  assert.deepEqual((release.writes[0] as { event: unknown }).event, { kind: "release", includePrereleases: true, futureField: FUTURE });

  const pr = mount(GitSettings, git({ kind: "project" }, { kind: "pull_request", actions: ["opened"], baseBranches: ["main"] }));
  call(control(pr.tree, "label", "Base branches", "onChange"), []);
  assert.deepEqual((pr.writes[0] as { event: unknown }).event, { kind: "pull_request", actions: ["opened"], futureField: FUTURE });
  call(control(pr.tree, "ariaLabel", "Pull request actions", "onValues"), ["opened", "merged"]);
  assert.deepEqual((pr.writes[1] as { event: unknown }).event, {
    kind: "pull_request",
    actions: ["opened", "merged"],
    baseBranches: ["main"],
    futureField: FUTURE
  });
}

console.log("trigger-settings-edits.check: ok");
