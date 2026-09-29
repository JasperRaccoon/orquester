import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkflowSummary } from "@orquester/api";

import { problemsHoverText, returnFocusToProblemsChip, WorkflowCard, type WorkflowCardProps } from "./WorkflowCard.tsx";

const opus = { severity: "error" as const, code: "unknown_model", message: 'NightlyTask: claude has no model "opus" (it has default, opus[1m])', nodeId: "a" };

function summary(over: Partial<WorkflowSummary> = {}): WorkflowSummary {
  return {
    id: "wf-1",
    name: "Nightly agent task",
    enabled: false,
    revision: 1,
    project: { kind: "existing", projectPath: "/w/ws/app" },
    triggers: [],
    nodeCount: 2,
    errorCount: 0,
    activeRuns: [],
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    ...over
  };
}

function render(workflow: WorkflowSummary): string {
  const noop = () => {};
  const props: WorkflowCardProps = {
    workflow,
    variant: "docked",
    now: Date.parse("2026-09-29T01:00:00.000Z"),
    expanded: false,
    runs: null,
    starting: false,
    editDisabledReason: null,
    onToggleExpanded: noop,
    onToggleEnabled: noop,
    onRun: noop,
    onEdit: noop,
    onOpenRun: noop,
    onDuplicate: noop,
    onDelete: noop,
    onRetryRuns: noop
  };
  return renderToStaticMarkup(h(WorkflowCard, props));
}

describe("the problems chip", () => {
  it("says what the problems are on hover, and what it leaves out", () => {
    assert.equal(problemsHoverText({ errorCount: 1, errors: [opus] }), opus.message);
    assert.equal(problemsHoverText({ errorCount: 8, errors: [opus, { ...opus, message: "B: second" }], errorsOmitted: 6 }), `${opus.message}\nB: second\n+6 more`);
    // An older daemon: the count alone.
    assert.match(problemsHoverText({ errorCount: 2 }), /^2 problems — open the editor/);
  });

  it("is a real button that opens a dialog, named for its workflow", () => {
    const markup = render(summary({ errorCount: 1, errors: [opus] }));
    assert.match(markup, /<button[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"[^>]*aria-label="1 problem in Nightly agent task — show them"/);
    assert.ok(markup.includes("title=\"NightlyTask: claude has no model &quot;opus&quot; (it has default, opus[1m])\""));
    assert.ok(markup.includes(">1 problem</button>"));
  });

  it("is absent with no errors", () => {
    assert.equal(render(summary()).includes("aria-haspopup=\"dialog\""), false);
  });

  it("gives focus back to the chip only when dismissed with focus gone down with the panel", () => {
    assert.equal(returnFocusToProblemsChip("dismiss", true), true);
    assert.equal(returnFocusToProblemsChip("dismiss", false), false, "a press outside already moved focus");
    assert.equal(returnFocusToProblemsChip("edit", true), false, "the editor takes over");
  });
});
