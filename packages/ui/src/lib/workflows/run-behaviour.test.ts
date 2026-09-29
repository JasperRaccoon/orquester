import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { movedTimeoutPatch, nodeTimeout, projectLabel, retryText, runBehaviourSummary, takesProjectOverride } from "./run-behaviour.ts";
import { node } from "./testing.ts";

describe("nodeTimeout", () => {
  it("Run workflow: the block-level limit is the one to edit, set or not", () => {
    assert.deepEqual(nodeTimeout(node("w", "workflow")), { kind: "editable", minutes: undefined, max: 1440 });
    assert.deepEqual(nodeTimeout(node("w", "workflow", {}, { timeoutMinutes: 90 })), { kind: "editable", minutes: 90, max: 1440 });
  });

  it("nothing to show when no block-level limit is set on any other type", () => {
    for (const type of ["agent", "code", "shell", "http", "if", "wait", "trigger.manual"] as const) {
      assert.deepEqual(nodeTimeout(node("n", type)), { kind: "none" }, type);
    }
  });

  it("Code / Shell: the block-level value is in effect until Limits has its own", () => {
    const legacy = nodeTimeout(node("c", "code", {}, { timeoutMinutes: 10 }));
    assert.equal(legacy.kind, "in-effect");
    assert.deepEqual(legacy.kind === "in-effect" ? legacy.own : null, {
      field: "config.timeoutMinutes",
      section: "Limits",
      value: null,
      fallback: "30 min"
    });
    const overridden = nodeTimeout(node("s", "shell", { timeoutMinutes: 5 }, { timeoutMinutes: 10 }));
    assert.equal(overridden.kind, "overridden");
    assert.equal(overridden.kind === "overridden" ? overridden.own.value : null, "5 min");
  });

  it("HTTP: its own seconds win; the default is 5 min", () => {
    const legacy = nodeTimeout(node("h", "http", {}, { timeoutMinutes: 2 }));
    assert.equal(legacy.kind, "in-effect");
    assert.deepEqual(legacy.kind === "in-effect" ? [legacy.own.field, legacy.own.section, legacy.own.fallback] : null, [
      "config.timeoutSeconds",
      "Response",
      "5 min"
    ]);
    const overridden = nodeTimeout(node("h", "http", { timeoutSeconds: 90 }, { timeoutMinutes: 2 }));
    assert.equal(overridden.kind === "overridden" ? overridden.own.value : null, "1 min 30 s");
  });

  it("Agent, flow blocks, Wait and triggers never read it", () => {
    for (const type of ["agent", "if", "switch", "merge", "stop", "wait", "trigger.schedule"] as const) {
      assert.deepEqual(nodeTimeout(node("n", type, {}, { timeoutMinutes: 120 })), { kind: "unused", minutes: 120 }, type);
    }
  });
});

describe("movedTimeoutPatch", () => {
  it("moves the value as the daemon applies it, capped at the type's maximum", () => {
    assert.deepEqual(movedTimeoutPatch(node("c", "code", {}, { timeoutMinutes: 10 })), { timeoutMinutes: 10 });
    assert.deepEqual(movedTimeoutPatch(node("c", "shell", {}, { timeoutMinutes: 5000 })), { timeoutMinutes: 1440 });
    assert.deepEqual(movedTimeoutPatch(node("h", "http", {}, { timeoutMinutes: 2 })), { timeoutSeconds: 120 });
    assert.deepEqual(movedTimeoutPatch(node("h", "http", {}, { timeoutMinutes: 600 })), { timeoutSeconds: 3600 });
  });

  it("has nothing to move for other types or without a value", () => {
    assert.equal(movedTimeoutPatch(node("a", "agent", {}, { timeoutMinutes: 10 })), null);
    assert.equal(movedTimeoutPatch(node("c", "code")), null);
  });
});

describe("retryText", () => {
  it("reads the retry setting in words", () => {
    assert.equal(retryText(undefined), "No retries");
    assert.equal(retryText({ maxTries: 3, delaySeconds: 30 }), "Up to 3 tries, 30 s apart");
    assert.equal(retryText({ maxTries: 5, delaySeconds: 120 }), "Up to 5 tries, 2 min apart");
    assert.equal(retryText({ maxTries: 2, delaySeconds: 0 }), "Up to 2 tries, no pause");
    assert.equal(retryText({ maxTries: 1, delaySeconds: 30 }), "1 try (no retries)");
  });
});

describe("runBehaviourSummary", () => {
  it("summarises an executable block", () => {
    assert.equal(runBehaviourSummary(node("c", "code")), "No retries");
    assert.equal(
      runBehaviourSummary(
        node("a", "agent", {}, { disabled: true, retry: { maxTries: 3, delaySeconds: 30 }, projectOverride: "/w/ws/other/", notes: "why" })
      ),
      "Disabled · Up to 3 tries, 30 s apart · Runs in other · Has notes"
    );
    assert.equal(runBehaviourSummary(node("w", "workflow")), "No retries · No time limit");
    assert.equal(runBehaviourSummary(node("w", "workflow", {}, { timeoutMinutes: 240 })), "No retries · Time limit 4 h");
    assert.equal(runBehaviourSummary(node("c", "code", {}, { timeoutMinutes: 10 })), "No retries · Time limit 10 min (older setting)");
    assert.equal(runBehaviourSummary(node("a", "agent", {}, { timeoutMinutes: 10 })), "No retries · Unused time limit");
  });

  it("summarises a trigger: on or off, and notes", () => {
    assert.equal(runBehaviourSummary(node("t", "trigger.manual")), "Enabled");
    assert.equal(runBehaviourSummary(node("t", "trigger.git", {}, { disabled: true, notes: " x " })), "Disabled — never fires · Has notes");
  });

  it("ignores blank notes", () => {
    assert.equal(runBehaviourSummary(node("c", "code", {}, { notes: "   " })), "No retries");
  });
});

describe("takesProjectOverride / projectLabel", () => {
  it("only blocks that work in a project folder take another project", () => {
    assert.deepEqual(
      (["agent", "code", "shell", "http", "workflow", "if"] as const).map(takesProjectOverride),
      [true, true, true, false, false, false]
    );
  });

  it("names a project by its folder", () => {
    assert.equal(projectLabel("/w/ws/app"), "app");
    assert.equal(projectLabel("/w/ws/app/"), "app");
    assert.equal(projectLabel("app"), "app");
  });
});
