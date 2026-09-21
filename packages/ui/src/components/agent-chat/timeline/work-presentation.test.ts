import assert from "node:assert/strict";
import { test } from "node:test";

import {
  commandProgramName,
  formatWorkspaceRelativePath,
  liveWorkEntryLabel,
  normalizeCompactToolLabel,
  omitSupersededLifecycleMarkers,
  showDestructiveRowStyle,
  summarizeToolGroup,
  summarizeToolGroupKind,
  toolDetailTextLooksLikeFailure,
  toolGroupAction,
  toolGroupActionCount,
  workEntryDisplayIndicatesToolFailure,
  workEntryDisplayLabel,
  workEntryIconName,
  workEntryIsActiveTurnActivity,
  workEntryIsVisibleInGroup,
  workEntrySignalsSevereFailure,
  type WorkPresentationEntry
} from "./work-presentation";

function entry(over: Partial<WorkPresentationEntry> = {}): WorkPresentationEntry {
  return { label: "Tool", tone: "tool", turnId: "t1", ...over };
}

test("normalizeCompactToolLabel drops a trailing completion word", () => {
  assert.equal(normalizeCompactToolLabel("Read file completed"), "Read file");
  assert.equal(normalizeCompactToolLabel("Read file complete  "), "Read file");
  assert.equal(normalizeCompactToolLabel("Completed migration"), "Completed migration");
});

test("commandProgramName skips env assignments, wrappers and flags", () => {
  assert.equal(commandProgramName("npm run build"), "npm");
  assert.equal(commandProgramName("CI=1 sudo /usr/bin/apt-get install -y tmux"), "apt-get");
  assert.equal(commandProgramName("  'git' status "), "git");
  assert.equal(commandProgramName("--version"), null);
  assert.equal(commandProgramName(""), null);
});

test("formatWorkspaceRelativePath keeps the project folder as the first segment", () => {
  assert.equal(
    formatWorkspaceRelativePath("/home/me/proj/src/a.ts", "/home/me/proj"),
    "proj/src/a.ts"
  );
  assert.equal(formatWorkspaceRelativePath("/home/me/proj/src/a.ts", "/home/me/proj/"), "proj/src/a.ts");
  assert.equal(formatWorkspaceRelativePath("/elsewhere/a.ts", "/home/me/proj"), "/elsewhere/a.ts");
  assert.equal(formatWorkspaceRelativePath("./src/a.ts", undefined), "src/a.ts");
  assert.equal(formatWorkspaceRelativePath("src\\a.ts", undefined), "src/a.ts");
});

test("toolDetailTextLooksLikeFailure spots the common provider phrasings", () => {
  assert.ok(toolDetailTextLooksLikeFailure("bash: fooo: command not found"));
  assert.ok(toolDetailTextLooksLikeFailure("<exited with exit code 2>"));
  assert.ok(toolDetailTextLooksLikeFailure("ENOENT: no such file or directory"));
  assert.ok(!toolDetailTextLooksLikeFailure("exit code 0"));
  assert.ok(!toolDetailTextLooksLikeFailure("all good"));
});

test("a non-zero command exit is a failure but NOT the destructive style", () => {
  const exited = entry({
    itemType: "command_execution",
    command: "npm test",
    detail: "<exited with exit code 1>",
    toolLifecycleStatus: "completed",
    sourceActivityKind: "tool.completed"
  });
  assert.ok(workEntryDisplayIndicatesToolFailure(exited));
  assert.ok(!workEntrySignalsSevereFailure(exited));
  assert.ok(!showDestructiveRowStyle(exited));
});

test("a runtime.error and a *.failed lifecycle DO get the destructive style", () => {
  const runtimeError = entry({ tone: "error", sourceActivityKind: "runtime.error" });
  const lifecycleFailed = entry({
    tone: "error",
    sourceActivityKind: "provider.turn.start.failed"
  });
  assert.ok(workEntrySignalsSevereFailure(runtimeError));
  assert.ok(showDestructiveRowStyle(runtimeError));
  assert.ok(workEntrySignalsSevereFailure(lifecycleFailed));
  assert.ok(showDestructiveRowStyle(lifecycleFailed));
});

test("toolGroupAction buckets by request kind, item type and payload shape", () => {
  assert.equal(toolGroupAction(entry({ requestKind: "file-read" })), "read");
  assert.equal(toolGroupAction(entry({ itemType: "image_view" })), "read");
  assert.equal(toolGroupAction(entry({ changedFiles: ["a.ts"] })), "edit");
  assert.equal(toolGroupAction(entry({ itemType: "file_change" })), "edit");
  assert.equal(toolGroupAction(entry({ command: "ls" })), "command");
  assert.equal(toolGroupAction(entry({ itemType: "web_search" })), "search");
  assert.equal(toolGroupAction(entry({ itemType: "mcp_tool_call" })), "other");
  assert.equal(toolGroupAction(entry({ tone: "info", sourceActivityKind: "approval.requested" })), "update");
  assert.equal(toolGroupAction(entry({ tone: "info", label: "note" })), "update");
});

test("toolGroupActionCount counts distinct files for edits", () => {
  const edits = [
    entry({ changedFiles: ["a.ts", "b.ts"] }),
    entry({ changedFiles: ["a.ts"] }),
    entry({ itemType: "file_change" })
  ];
  assert.equal(toolGroupActionCount("edit", edits), 3);
  assert.equal(toolGroupActionCount("command", edits), 3);
});

test("summarizeToolGroup joins clauses with an Oxford comma and lower-cases the tail", () => {
  const entries = [
    entry({ requestKind: "file-read" }),
    entry({ requestKind: "file-read" }),
    entry({ requestKind: "file-read" }),
    entry({ command: "ls" }),
    entry({ command: "pwd" })
  ];
  assert.equal(summarizeToolGroup(entries), "Read 3 files and ran 2 commands");

  const three = [...entries, entry({ changedFiles: ["x.ts"] })];
  assert.equal(summarizeToolGroup(three), "Read 3 files, ran 2 commands, and changed 1 file");

  assert.equal(summarizeToolGroup([]), "");
  assert.equal(summarizeToolGroup([entry({ command: "ls" })]), "Ran 1 command");
});

test("summarizeToolGroup drops a superseded unkeyed start frame", () => {
  const started = entry({
    label: "Read file",
    sourceActivityKind: "tool.started",
    requestKind: "file-read"
  });
  const completed = entry({
    label: "Read file completed",
    sourceActivityKind: "tool.completed",
    requestKind: "file-read",
    toolLifecycleStatus: "completed"
  });
  assert.equal(summarizeToolGroup([started, completed]), "Read 1 file");
});

test("omitSupersededLifecycleMarkers keeps a keyed start frame", () => {
  const started = entry({
    label: "Read file",
    sourceActivityKind: "tool.started",
    toolCallId: "call-1"
  });
  const completed = entry({
    label: "Read file",
    sourceActivityKind: "tool.completed",
    toolLifecycleStatus: "completed"
  });
  const kept = omitSupersededLifecycleMarkers([started, completed], (value) => value);
  assert.equal(kept.length, 2);
});

test("omitSupersededLifecycleMarkers does not collapse across turns", () => {
  const a = entry({ label: "Read file", sourceActivityKind: "tool.started", turnId: "t1" });
  const b = entry({
    label: "Read file",
    sourceActivityKind: "tool.completed",
    toolLifecycleStatus: "completed",
    turnId: "t2"
  });
  assert.equal(omitSupersededLifecycleMarkers([a, b], (value) => value).length, 2);
});

test("summarizeToolGroupKind is the single kind or 'other'", () => {
  assert.equal(summarizeToolGroupKind([entry({ command: "ls" }), entry({ command: "pwd" })]), "command");
  assert.equal(summarizeToolGroupKind([entry({ command: "ls" }), entry({ requestKind: "file-read" })]), "other");
  assert.equal(summarizeToolGroupKind([]), "other");
});

test("workEntryDisplayLabel prefers command, then detail, then changed files", () => {
  assert.equal(workEntryDisplayLabel(entry({ command: "ls -la", detail: "x" }), undefined), "ls -la");
  assert.equal(workEntryDisplayLabel(entry({ detail: "src/a.ts" }), undefined), "src/a.ts");
  assert.equal(
    workEntryDisplayLabel(entry({ changedFiles: ["/p/a.ts", "/p/b.ts"] }), "/p"),
    "p/a.ts +1 more"
  );
  assert.equal(workEntryDisplayLabel(entry({ label: "read file" }), undefined), "Read file");
});

test("liveWorkEntryLabel uses the running verb only while active", () => {
  const running = entry({ command: "npm run build", toolLifecycleStatus: "inProgress" });
  assert.equal(liveWorkEntryLabel(running, undefined, true), "Running npm");
  const done = entry({ command: "npm run build", toolLifecycleStatus: "completed" });
  assert.equal(liveWorkEntryLabel(done, undefined, false), "Ran npm");
  assert.equal(liveWorkEntryLabel(done, undefined, true), "Running npm");
  const failed = entry({ command: "npm run build", toolLifecycleStatus: "failed" });
  assert.equal(liveWorkEntryLabel(failed, undefined, true), "Failed npm");
});

test("workEntryIsVisibleInGroup hides a neutral tool row unless the group is expanded", () => {
  const neutral = entry({ itemType: "command_execution", toolLifecycleStatus: "inProgress" });
  assert.ok(!workEntryIsVisibleInGroup(neutral));
  assert.ok(workEntryIsVisibleInGroup(neutral, true));
  const settled = entry({ itemType: "command_execution", toolLifecycleStatus: "completed" });
  assert.ok(workEntryIsVisibleInGroup(settled));
});

test("workEntryIsActiveTurnActivity", () => {
  assert.ok(workEntryIsActiveTurnActivity(entry({ toolLifecycleStatus: "inProgress" })));
  assert.ok(workEntryIsActiveTurnActivity(entry({ sourceActivityKind: "task.progress" })));
  assert.ok(!workEntryIsActiveTurnActivity(entry({ toolLifecycleStatus: "completed" })));
});

test("workEntryIconName follows the fallback chain", () => {
  assert.equal(workEntryIconName(entry({ agentSpawn: { workflowId: null, agentTaskIds: [] } })), "bot");
  assert.equal(
    workEntryIconName(entry({ questionAnswer: { requestId: "r", answers: {} } })),
    "message-circle"
  );
  assert.equal(workEntryIconName(entry({ requestKind: "file-read" })), "eye");
  assert.equal(workEntryIconName(entry({ command: "ls" })), "terminal");
  assert.equal(workEntryIconName(entry({ itemType: "mcp_tool_call" })), "wrench");
  assert.equal(workEntryIconName(entry({ taskId: "1" })), "bot");
  assert.equal(workEntryIconName(entry({ tone: "thinking" })), "brain");
  assert.equal(workEntryIconName(entry({ sourceActivityKind: "model.rerouted", tone: "info" })), "shuffle");
});
