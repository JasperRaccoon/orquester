import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WorkLogEntry } from "./contracts";
import {
  commandProgramName,
  liveWorkEntryLabel,
  normalizeCompactToolLabel,
  omitSupersededLifecycleMarkers,
  summarizeToolGroup,
  toolGroupAction,
  toolGroupSummaryKind,
  workEntryIconName,
  workEntryIndicatesToolNeutralStatus,
  workEntryIsProviderDenial,
  workEntrySeverity,
  workEntryIsActiveTurnActivity,
  nestRowsUnderParentCall,
  showDestructiveRowStyle,
  workLogEntryIsToolLike
} from "./presentation.logic";

const entry = (overrides: Partial<WorkLogEntry> = {}): WorkLogEntry => ({
  id: overrides.id ?? "a1",
  createdAt: "2026-01-01T00:00:00.000Z",
  turnId: overrides.turnId ?? "t1",
  label: overrides.label ?? "Tool",
  tone: overrides.tone ?? "tool",
  ...overrides
});

describe("toolGroupAction", () => {
  it("buckets by the promoted fields alone — nothing branches on the provider", () => {
    assert.equal(toolGroupAction(entry({ requestKind: "file-read" })), "read");
    assert.equal(toolGroupAction(entry({ itemType: "file_change" })), "edit");
    assert.equal(toolGroupAction(entry({ changedFiles: ["/a"] })), "edit");
    assert.equal(toolGroupAction(entry({ command: "ls" })), "command");
    assert.equal(toolGroupAction(entry({ itemType: "web_search" })), "search");
    assert.equal(
      toolGroupAction(entry({ itemType: "web_search", toolTitle: "Grep" })),
      "code-search"
    );
    assert.equal(toolGroupAction(entry({ itemType: "image_view" })), "read");
    assert.equal(toolGroupAction(entry({ tone: "info", label: "note" })), "update");
  });

  it("folds an approval into the update bucket — approvals are never hoisted", () => {
    assert.equal(
      toolGroupAction(entry({ sourceActivityKind: "approval.requested", tone: "info" })),
      "update"
    );
    assert.equal(
      toolGroupAction(entry({ sourceActivityKind: "approval.resolved", tone: "info" })),
      "update"
    );
  });
});

describe("summarizeToolGroup", () => {
  it("counts distinct files for edits and rows for everything else", () => {
    const summary = summarizeToolGroup([
      entry({ id: "1", requestKind: "file-read" }),
      entry({ id: "2", requestKind: "file-read" }),
      entry({ id: "3", requestKind: "file-read" }),
      entry({ id: "4", command: "pnpm test" }),
      entry({ id: "5", command: "pnpm check" })
    ]);
    assert.equal(summary, "Read 3 files and ran 2 commands");
  });

  it("de-duplicates changed files across rows", () => {
    const summary = summarizeToolGroup([
      entry({ id: "1", changedFiles: ["/a.ts", "/b.ts"] }),
      entry({ id: "2", changedFiles: ["/b.ts"] })
    ]);
    assert.equal(summary, "Changed 2 files");
  });

  it("joins three buckets with an Oxford comma", () => {
    const summary = summarizeToolGroup([
      entry({ id: "1", requestKind: "file-read" }),
      entry({ id: "2", command: "ls" }),
      entry({ id: "3", changedFiles: ["/a.ts"] })
    ]);
    assert.equal(summary, "Read 1 file, ran 1 command, and changed 1 file");
  });

  it("drops superseded lifecycle markers before counting", () => {
    const marker = entry({
      id: "start",
      sourceActivityKind: "tool.started",
      itemType: "command_execution",
      label: "Run command"
    });
    const terminal = entry({
      id: "done",
      sourceActivityKind: "tool.completed",
      itemType: "command_execution",
      label: "Run command complete",
      toolLifecycleStatus: "completed",
      command: "ls"
    });
    assert.equal(summarizeToolGroup([marker, terminal]), "Ran 1 command");
  });

  it("keeps an unkeyed marker whose identity has no later terminal row", () => {
    const marker = entry({
      id: "start",
      sourceActivityKind: "tool.started",
      itemType: "command_execution",
      label: "Run command"
    });
    assert.equal(omitSupersededLifecycleMarkers([marker], (value) => value).length, 1);
  });
});

describe("normalizeCompactToolLabel", () => {
  it("makes a completion label equal its start label", () => {
    assert.equal(normalizeCompactToolLabel("Read file complete"), "Read file");
    assert.equal(normalizeCompactToolLabel("Read file"), "Read file");
  });
});

describe("severity", () => {
  it("reserves the destructive treatment for severe failures", () => {
    assert.equal(workEntrySeverity(entry({ sourceActivityKind: "runtime.error" })), "severe");
    assert.equal(
      workEntrySeverity(entry({ sourceActivityKind: "provider.turn.start.failed" })),
      "severe"
    );
  });

  it("gives a warning its own class, distinct from both", () => {
    assert.equal(workEntrySeverity(entry({ sourceActivityKind: "runtime.warning" })), "warning");
    assert.equal(workEntryIconName(entry({ sourceActivityKind: "runtime.warning" })), "circle-alert");
  });

  it("gives a non-zero exit only the muted failure mark", () => {
    assert.equal(
      workEntrySeverity(entry({ command: "false", detail: "exited with exit code 1" })),
      "failure"
    );
  });

  it("is clean when nothing failed", () => {
    assert.equal(workEntrySeverity(entry({ command: "ls", detail: "a\nb" })), "none");
  });
});

describe("CLI-side denials", () => {
  it("reads a tool_use_error result as a denial even with no approval request", () => {
    assert.equal(
      workEntryIsProviderDenial(entry({ detail: "<tool_use_error>not allowed</tool_use_error>" })),
      true
    );
    assert.equal(workEntryIsProviderDenial(entry({ toolLifecycleStatus: "declined" })), true);
    assert.equal(workEntryIsProviderDenial(entry({ detail: "fine" })), false);
  });
});

describe("misc helpers", () => {
  it("classifies tool-likeness from the promoted fields", () => {
    assert.equal(workLogEntryIsToolLike(entry({ tone: "tool" })), true);
    assert.equal(workLogEntryIsToolLike(entry({ tone: "info", label: "note" })), false);
    assert.equal(
      workLogEntryIsToolLike(entry({ tone: "info", itemType: "command_execution" })),
      true
    );
  });

  it("hides a neutral tool row from a collapsed group but never a spawn row", () => {
    const neutral = entry({ tone: "tool", toolLifecycleStatus: "inProgress" });
    assert.equal(workEntryIndicatesToolNeutralStatus(neutral), true);
    assert.equal(
      workEntryIndicatesToolNeutralStatus({
        ...neutral,
        agentSpawn: { workflowId: null, agentTaskIds: ["t1"] }
      }),
      false
    );
  });

  it("narrows the summary kind to the five the row model allows", () => {
    assert.equal(toolGroupSummaryKind([entry({ requestKind: "file-read" })]), "read");
    assert.equal(
      toolGroupSummaryKind([entry({ itemType: "web_search", toolTitle: "Grep" })]),
      "search"
    );
    assert.equal(
      toolGroupSummaryKind([entry({ id: "1", command: "ls" }), entry({ id: "2", changedFiles: ["/a"] })]),
      "other"
    );
  });

  it("names the program a command runs", () => {
    assert.equal(commandProgramName("ls -la"), "ls");
    assert.equal(commandProgramName("FOO=1 sudo /usr/bin/apt-get install x"), "apt-get");
    assert.equal(commandProgramName("   "), null);
  });

  it("labels a live command row in the present tense", () => {
    assert.equal(liveWorkEntryLabel(entry({ command: "pnpm test" }), true), "Running pnpm");
    assert.equal(
      liveWorkEntryLabel(entry({ command: "pnpm test", toolLifecycleStatus: "failed" }), true),
      "Failed pnpm"
    );
  });
});

// ---------------------------------------------------------------------------
// Fix-wave regressions (R7-6: this is the ONE presentation resolver)
// ---------------------------------------------------------------------------

describe("R7-6 — arms absorbed from the deleted second resolver", () => {
  it("buckets an answered question as an update, not as a tool call", () => {
    assert.equal(
      toolGroupAction(entry({ sourceActivityKind: "user-input.requested", tone: "info" })),
      "update"
    );
    assert.equal(
      toolGroupAction(entry({ sourceActivityKind: "user-input.resolved", tone: "info" })),
      "update"
    );
  });

  it("keeps the arms W11 already had", () => {
    assert.equal(
      toolGroupAction(entry({ sourceActivityKind: "approval.requested", tone: "info" })),
      "update"
    );
    assert.equal(
      toolGroupAction(entry({ itemType: "web_search", toolTitle: "Grep" })),
      "code-search"
    );
  });

  it("exposes the live-row predicate the activity group needs", () => {
    assert.equal(
      workEntryIsActiveTurnActivity(entry({ toolLifecycleStatus: "inProgress" })),
      true
    );
    assert.equal(
      workEntryIsActiveTurnActivity(entry({ sourceActivityKind: "task.progress", tone: "thinking" })),
      true
    );
    assert.equal(
      workEntryIsActiveTurnActivity(entry({ toolLifecycleStatus: "completed" })),
      false
    );
  });

  it("reserves the destructive style for severe or non-tool-like failures", () => {
    // A non-zero exit is a failure but not destructive (§7.3).
    assert.equal(
      showDestructiveRowStyle(entry({ command: "false", detail: "exited with exit code 1" })),
      false
    );
    assert.equal(
      showDestructiveRowStyle(entry({ sourceActivityKind: "runtime.error", tone: "error" })),
      true
    );
    assert.equal(showDestructiveRowStyle(entry({ command: "ls", detail: "ok" })), false);
  });
});

describe("R7-10 — parentToolUseId has a reader", () => {
  it("nests a consequence row under the call it happened inside", () => {
    const call = entry({ id: "c1", toolCallId: "tu1", command: "pnpm test" });
    const hook = entry({ id: "h1", parentToolUseId: "tu1", label: "PostToolUse" });
    const sibling = entry({ id: "s1", command: "ls" });
    const nested = nestRowsUnderParentCall([call, hook, sibling]);
    assert.deepEqual(nested.map((node) => node.entry.id), ["c1", "s1"]);
    assert.deepEqual(nested[0]?.children.map((child) => child.id), ["h1"]);
  });

  it("leaves a row whose parent is not in this run at the top level", () => {
    const orphan = entry({ id: "o1", parentToolUseId: "elsewhere" });
    const nested = nestRowsUnderParentCall([orphan]);
    assert.deepEqual(nested.map((node) => node.entry.id), ["o1"]);
  });
});
