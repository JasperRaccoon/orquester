import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  caseLabelNote,
  caseOutputName,
  incomingBlockNames,
  mergeOutputExample,
  rulesSummary,
  timeZoneLabel,
  waitConfigForKind,
  type WaitConfig
} from "./flow-settings.ts";
import { edge, node, workflow } from "./testing.ts";

describe("rulesSummary", () => {
  it("reads one rule as written, several as a count and how they combine", () => {
    assert.equal(rulesSummary("all", [{ left: "{{ input.status }}", op: "equals", right: "done" }]), 'input.status = "done"');
    assert.equal(rulesSummary("all", [{ left: "{{ input.items | length }}", op: "gt", right: "0" }]), "input.items | length > 0");
    assert.equal(rulesSummary("any", [{ left: "{{ input.ok }}", op: "isTrue" }]), "input.ok is true");
    const two = [
      { left: "{{ input.a }}", op: "isEmpty" as const },
      { left: "{{ input.b }}", op: "exists" as const }
    ];
    assert.equal(rulesSummary("all", two), "2 rules · all must hold");
    assert.equal(rulesSummary("any", two), "2 rules · any one is enough");
    assert.equal(rulesSummary("all", []), "No rules");
  });
});

describe("Switch case labels", () => {
  it("names an output by its label, else by its number", () => {
    assert.equal(caseOutputName(" bug ", 0), "bug");
    assert.equal(caseOutputName("  ", 1), "case 2");
  });

  it("notes an empty label and warns on a repeated one", () => {
    const labels = ["bug", "", "Bug ", "feature"];
    assert.deepEqual(caseLabelNote(labels, 1), { hint: "No label — its output is called “case 2”.", warning: null });
    assert.deepEqual(caseLabelNote(labels, 0), {
      hint: null,
      warning: "Case 3 has the same label, so their outputs look alike on the canvas."
    });
    assert.match(caseLabelNote(labels, 2).warning!, /^Case 1 /);
    assert.deepEqual(caseLabelNote(labels, 3), { hint: null, warning: null });
  });
});

describe("Merge", () => {
  it("lists the blocks wired into it once each, and shows its output by their names", () => {
    const wf = workflow(
      [node("t", "trigger.manual"), node("a", "http", {}, { name: "Fetch" }), node("b", "code", {}, { name: "Review" }), node("m", "merge")],
      [edge("t", "a"), edge("t", "b"), edge("a", "m"), edge("b", "m"), edge("a", "m", "error")]
    );
    assert.deepEqual(incomingBlockNames(wf, "m"), ["Fetch", "Review"]);
    assert.equal(mergeOutputExample(incomingBlockNames(wf, "m")), '{ "Fetch": …, "Review": … }');
    assert.equal(mergeOutputExample([]), '{ "BlockA": …, "BlockB": … }');
  });
});

describe("waitConfigForKind", () => {
  it("drops the other kind's fields and keeps unknown ones", () => {
    const duration = { kind: "duration", minutes: 30, note: "kept" } as WaitConfig;
    assert.deepEqual(waitConfigForKind(duration, "until"), { kind: "until", time: "09:00", note: "kept" });
    const until = { kind: "until", time: "18:30", timezone: "Europe/Madrid", note: "kept" } as WaitConfig;
    assert.deepEqual(waitConfigForKind(until, "duration"), { kind: "duration", minutes: 5, note: "kept" });
    assert.equal(waitConfigForKind(until, "until"), until, "the same kind is left as is");
  });
});

describe("timeZoneLabel", () => {
  it("reads underscores as spaces", () => {
    assert.equal(timeZoneLabel("America/New_York"), "America/New York");
    assert.equal(timeZoneLabel("UTC"), "UTC");
  });
});
