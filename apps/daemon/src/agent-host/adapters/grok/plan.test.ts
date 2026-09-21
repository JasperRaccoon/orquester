/**
 * Plan detection: the `$GROK_HOME` path matcher (T3's `~/.grok` regex cannot
 * match a managed home) and the declared plan-mode discriminant.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  isEnterPlanToolCall,
  isExitPlanToolCall,
  isPlanMarkdownPath,
  nextPlanModeActive,
  planMarkdownFromToolCall,
  planSessionPrefixes,
  type PlanPathHost
} from "./plan.ts";

const GROK_HOME = "/var/lib/orquester/daemon/agent-accounts/grok/b9682f5c/home";
const host: PlanPathHost = { platform: "linux", env: { GROK_HOME, HOME: "/var/lib/orquester" } };

const REAL_PLAN_PATH = `${GROK_HOME}/sessions/%2Fvar%2Flib%2Fworkspace/01a0c1a4-d265-7c63-825d-4896587d488c/plan.md`;

test("the managed account home's session plan matches", () => {
  // T3's canonical regex requires a literal `.grok` component under a real
  // home root; a `GROK_HOME`-bound plan has neither.
  assert.equal(isPlanMarkdownPath(REAL_PLAN_PATH, host), true);
});

test("a workspace plan.md never matches", () => {
  assert.equal(isPlanMarkdownPath("/work/project/docs/plan.md", host), false);
  assert.equal(isPlanMarkdownPath("/work/project/.grok/sessions/a/b/plan.md", host), false);
});

test("a `..` segment is refused outright, not normalised", () => {
  assert.equal(
    isPlanMarkdownPath(`${GROK_HOME}/sessions/x/../../../workspace/plan.md`, host),
    false,
    "otherwise the prefix test becomes a path-confusion write primitive"
  );
});

test("at least one intermediate directory is required", () => {
  assert.equal(isPlanMarkdownPath(`${GROK_HOME}/sessions/plan.md`, host), false);
  assert.equal(isPlanMarkdownPath(`${GROK_HOME}/sessions/a/plan.md`, host), true);
});

test("a non-plan file under the sessions dir does not match", () => {
  assert.equal(isPlanMarkdownPath(`${GROK_HOME}/sessions/a/b/notes.md`, host), false);
  assert.equal(isPlanMarkdownPath(`${GROK_HOME}/sessions/a/b/plan.md.bak`, host), false);
});

test("a `~/.grok` layout still matches, for a system-identity thread", () => {
  const systemHost: PlanPathHost = { platform: "linux", env: { HOME: "/home/dev" } };
  assert.equal(isPlanMarkdownPath("/home/dev/.grok/sessions/a/b/plan.md", systemHost), true);
});

test("matching is case-insensitive only on win32", () => {
  const win: PlanPathHost = { platform: "win32", env: { GROK_HOME: "C:/Users/dev/.grok" } };
  assert.equal(isPlanMarkdownPath("C:\\Users\\Dev\\.grok\\sessions\\a\\b\\PLAN.MD", win), true);
  assert.equal(isPlanMarkdownPath(`${GROK_HOME.toUpperCase()}/sessions/a/b/plan.md`, host), false);
});

test("both GROK_HOME layouts are accepted", () => {
  const prefixes = planSessionPrefixes(host);
  assert.ok(prefixes.includes(`${GROK_HOME}/sessions/`));
  assert.ok(prefixes.includes(`${GROK_HOME}/.grok/sessions/`));
});

test("a non-string path is never a plan", () => {
  assert.equal(isPlanMarkdownPath(undefined, host), false);
  assert.equal(isPlanMarkdownPath(7, host), false);
});

// ---------------------------------------------------------------------------

test("the plan markdown is read from the write tool's rawInput", () => {
  assert.equal(
    planMarkdownFromToolCall({ rawInput: { file_path: REAL_PLAN_PATH, content: "# Plan\n" } }, host),
    "# Plan"
  );
});

test("the plan markdown is read from a diff content entry", () => {
  assert.equal(
    planMarkdownFromToolCall(
      { content: [{ type: "diff", path: REAL_PLAN_PATH, oldText: "", newText: "# Plan\n" }] },
      host
    ),
    "# Plan"
  );
});

test("an empty plan write resets the fallback without proposing anything", () => {
  assert.equal(planMarkdownFromToolCall({ rawInput: { file_path: REAL_PLAN_PATH, content: "  " } }, host), "");
});

test("a write to anything else reports no plan at all", () => {
  assert.equal(
    planMarkdownFromToolCall({ rawInput: { file_path: "/work/notes.txt", content: "x" } }, host),
    undefined
  );
});

// ---------------------------------------------------------------------------

const enterMeta = {
  "x.ai/tool": {
    version: 1,
    name: "enter_plan_mode",
    kind: "enter_plan",
    namespace: "grok_build",
    label: "Enter Plan Mode",
    read_only: true
  }
};
const exitMeta = {
  "x.ai/tool": {
    version: 1,
    name: "exit_plan_mode",
    kind: "exit_plan",
    namespace: "grok_build",
    label: "Exit Plan Mode",
    read_only: true
  }
};

test("plan mode is DECLARED by _meta['x.ai/tool'].kind, not matched on a title", () => {
  assert.equal(isEnterPlanToolCall({ title: "anything at all", meta: enterMeta }), true);
  assert.equal(isExitPlanToolCall({ title: "anything at all", meta: exitMeta }), true);
  // The vendor kind wins over a misleading title.
  assert.equal(isEnterPlanToolCall({ title: "enter_plan_mode", meta: exitMeta }), false);
});

test("the title heuristic is the fallback when no vendor meta is present", () => {
  assert.equal(isEnterPlanToolCall({ title: "Plan: Enter" }), true);
  assert.equal(isEnterPlanToolCall({ title: "plan mode entered" }), true);
  assert.equal(isEnterPlanToolCall({ rawInput: { variant: "EnterPlanMode" } }), true);
  assert.equal(isEnterPlanToolCall({ title: "Write `/tmp/a`" }), false);
});

test("a FAILED enter_plan_mode must not leave the flag stuck on", () => {
  assert.equal(nextPlanModeActive(false, { meta: enterMeta, status: "completed" }), true);
  assert.equal(nextPlanModeActive(true, { meta: enterMeta, status: "failed" }), false);
  assert.equal(nextPlanModeActive(false, { meta: enterMeta, status: "pending" }), false);
  assert.equal(nextPlanModeActive(true, { meta: exitMeta, status: "completed" }), false);
  assert.equal(nextPlanModeActive(true, { title: "Read `/x`" }), true, "an unrelated call changes nothing");
});
