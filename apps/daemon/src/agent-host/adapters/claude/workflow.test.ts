/**
 * Claude `Workflow` runs: the coordinator, its member rows and its agents'
 * transcripts, against captures of CLI 2.1.285 (fixtures 17–19; provenance in
 * test/fixtures/claude/README.md).
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { describe, it } from "node:test";

import type { RuntimeEvent } from "@orquester/api/agent-chat";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { JsonlFileTail } from "../../support/tail-file.ts";
import { classifyToolItemType } from "./classify.ts";
import { CLAUDE_FIXTURES_DIR, countingIds, fixedClock, readClaudeFixture, replayClaudeFixture } from "./fixtures.ts";
import { ClaudeNormalizer } from "./normalize.ts";
import { projectClaudeHistory } from "./project-history.ts";
import {
  readWorkflowHistoryRun,
  workflowLaunchesIn
} from "./workflow-history.ts";
import {
  parseWorkflowLaunch,
  parseWorkflowProgress,
  workflowAgentPromptOf,
  workflowAgentStatus
} from "./workflow.ts";

type TaskEvent = Extract<
  RuntimeEvent,
  { type: "task.started" | "task.progress" | "task.updated" | "task.completed" }
>;

function taskRows(events: readonly RuntimeEvent[], taskId?: string): TaskEvent[] {
  return events.filter(
    (event): event is TaskEvent =>
      event.type.startsWith("task.") &&
      (taskId === undefined || (event.payload as { taskId?: unknown }).taskId === taskId)
  );
}

function rowSummary(event: TaskEvent): string {
  const payload = event.payload as { taskId: string; status?: string };
  return `${event.type} ${payload.taskId}${payload.status !== undefined ? ` ${payload.status}` : ""}`;
}

describe("workflow_progress parsing", () => {
  it("dedupes slots and drops unsafe agent ids", () => {
    const snapshot = parseWorkflowProgress({
      workflow_progress: [
        { type: "workflow_agent", index: 1, label: "old", state: "start" },
        { type: "workflow_agent", index: 1, label: "gather:alpha", state: "progress", agentId: "aebd584875df53fac", attempt: 2 },
        { type: "workflow_agent", index: 2, label: "evil", state: "start", agentId: "../../etc/passwd" },
        { type: "workflow_agent", label: "no index", state: "done" }
      ]
    });
    assert.deepEqual(
      snapshot?.agents.map((agent) => [agent.index, agent.label, agent.agentId]),
      [
        [1, "gather:alpha", "aebd584875df53fac"],
        [2, "evil", undefined]
      ]
    );
  });

  it("maps failed and skipped agents to distinct shared states", () => {
    const status = (entry: object) => workflowAgentStatus({ index: 1, label: "a", state: "", ...entry });
    assert.equal(status({ state: "error" }), "failed");
    assert.equal(status({ state: "error", skipped: true }), "cancelled");
  });

  it("rejects malformed launches and unsafe session URLs", () => {
    const launch = parseWorkflowLaunch({
      status: "async_launched",
      taskId: "wvg2ao9ra",
      runId: "wf_68d12d28-357",
      transcriptDir: "/x/subagents/workflows/wf_68d12d28-357",
      scriptPath: "/x/workflows/scripts/capture-demo-wf_68d12d28-357.js",
      sessionUrl: "javascript:alert(1)"
    });
    assert.equal(launch?.taskId, "wvg2ao9ra");
    assert.equal(launch?.runHandles.sessionUrl, undefined);
    assert.equal(parseWorkflowLaunch({ status: "async_launched" }), undefined);
  });

  it("unwraps an agent's computed task from its transcript's first record", () => {
    const record = {
      type: "user",
      message: {
        role: "user",
        content:
          "[Workflow harness — computed task] The task text below was computed at runtime. The computed task text follows:\n  Line one\n    indented\n  Line three"
      }
    };
    assert.equal(workflowAgentPromptOf(record), "Line one\n  indented\nLine three");
    assert.equal(workflowAgentPromptOf({ type: "user", message: { content: "plain" } }), undefined);
  });
});

describe("the Workflow tool call", () => {
  it("classifies Workflow as a collaboration tool call", () => {
    const script =
      "export const meta = {\n  name: 'capture-demo',\n  description: 'Two-phase capture demo',\n  phases: [{ title: 'Gather' }],\n}\nphase('Gather')";
    assert.equal(classifyToolItemType("Workflow", { script }), "collab_agent_tool_call");
  });
});

describe("fixture 17: a completed two-phase workflow", () => {
  const { events } = replayClaudeFixture("17-workflow.ndjson");

  it("puts the run's handles and phases on the coordinator", () => {
    const coordinator = taskRows(events, "wvg2ao9ra");
    const started = coordinator.find((event) => event.type === "task.started");
    assert.equal(started?.payload.taskType, "local_workflow");
    assert.equal(started?.payload.workflowName, "capture-demo");
    assert.match(String((started?.payload as { prompt?: unknown }).prompt), /^export const meta/);
    const updated = coordinator.find((event) => event.type === "task.updated");
    assert.equal(updated?.payload.runHandles?.runId, "wf_68d12d28-357");
    assert.match(String(updated?.payload.runHandles?.transcriptDir), /subagents\/workflows\/wf_68d12d28-357$/);
    const progress = coordinator.filter((event) => event.type === "task.progress");
    assert.deepEqual(progress[0]?.payload.phases, [
      { index: 1, title: "Gather" },
      { index: 2, title: "Combine" }
    ]);
    // The frame's `last_tool_name` is a member's label, never a tool.
    for (const row of progress) {
      assert.equal((row.payload as { lastToolName?: unknown }).lastToolName, undefined);
      assert.match(String((row.payload as { summary?: unknown }).summary), /^(Gather|Combine): /);
    }
  });

  it("gives every agent slot its own member rows, in order, before the run ends", () => {
    const members = taskRows(events).filter((event) => event.payload.taskId.includes(":wf:"));
    assert.deepEqual(
      members.filter((event) => event.type === "task.completed").map((event) => [event.payload.taskId, event.payload.status]),
      [
        ["wvg2ao9ra:wf:1", "completed"],
        ["wvg2ao9ra:wf:2", "completed"],
        ["wvg2ao9ra:wf:3", "completed"]
      ]
    );
    const starts = members.filter((event) => event.type === "task.started");
    assert.deepEqual(starts.map((event) => event.payload.taskId), ["wvg2ao9ra:wf:1", "wvg2ao9ra:wf:2", "wvg2ao9ra:wf:3"]);
    for (const row of starts) {
      assert.equal(row.payload.parentAgentId, "wvg2ao9ra");
      assert.equal(row.payload.taskType, "workflow_agent");
    }
    const combine = starts.find((event) => event.payload.taskId === "wvg2ao9ra:wf:3");
    assert.equal(combine?.payload.phaseIndex, 2);
    assert.equal(combine?.payload.phaseTitle, "Combine");
    const lastMember = events.lastIndexOf(members.at(-1)!);
    const runEnd = events.findIndex(
      (event) => event.type === "task.completed" && event.payload.taskId === "wvg2ao9ra"
    );
    assert.ok(lastMember < runEnd);
  });
});

describe("fixture 18: a workflow stopped mid-run", () => {
  it("stops every open member ahead of the coordinator", () => {
    const { events } = replayClaudeFixture("18-workflow-stop.ndjson");
    const ends = events
      .filter((event) => event.type === "task.completed" || event.type === "task.updated")
      .map((event) => rowSummary(event as TaskEvent));
    assert.deepEqual(ends.slice(-4), [
      "task.completed w63c5max6:wf:1 stopped",
      "task.completed w63c5max6:wf:2 stopped",
      "task.updated w63c5max6 cancelled",
      "task.completed w63c5max6 stopped"
    ]);
  });
});

describe("fixture 19: a workflow agent's transcript", () => {
  const sessionId = "73710e20-3349-4b51-8911-683bd829bcff";

  it("projects the captured agent's tool call, result and answer into its drill-in once", async () => {
    const { normalizer } = replayClaudeFixture("19-workflow-tools.ndjson");
    const transcript = nodePath.join(
      CLAUDE_FIXTURES_DIR,
      "19-workflow-tools.disk",
      sessionId,
      "subagents", "workflows", "wf_fdfa9e63-30d", "agent-a804d5a6192e9aab8.jsonl"
    );
    const read = await new JsonlFileTail({ path: transcript }).read();
    const memberTaskId = "wokihcb1u:wf:1";
    const events = normalizer.workflowAgentRecords(memberTaskId, read.records);
    const owned = events.filter(
      (event) => (event as { agentId?: unknown }).agentId === "wokihcb1u:wf:1"
    );
    assert.equal(owned.length, events.length);
    const call = events.find(
      (event) => event.type === "item.started" && event.payload.itemType !== "assistant_message"
    );
    assert.equal((call?.payload as { data?: { toolName?: unknown } }).data?.toolName, "Read");
    const completed = events.find(
      (event) => event.type === "item.completed" && event.itemId === call?.itemId
    );
    assert.equal(completed?.type === "item.completed" ? completed.payload.status : undefined, "completed");
    const text = events.find(
      (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text"
    );
    assert.equal(text?.type === "content.delta" ? text.payload.delta : undefined, "alpha");

    // A re-read (a replaced file, a drain after a poll) repeats nothing.
    assert.deepEqual(normalizer.workflowAgentRecords(memberTaskId, read.records), []);
    // An unknown member is not guessed at.
    assert.deepEqual(normalizer.workflowAgentRecords("wokihcb1u:wf:9", read.records), []);
  });
});

describe("JsonlFileTail", () => {
  it("waits for a file and for a line's newline, and survives a replaced file", async () => {
    const dir = await fs.mkdtemp(nodePath.join(tmpdir(), "jsonl-tail-"));
    const path = nodePath.join(dir, "agent-a.jsonl");
    const tail = new JsonlFileTail({ path });
    assert.deepEqual(await tail.read(), { records: [], done: false });

    await fs.writeFile(path, '{"n":1}\n{"n":');
    assert.deepEqual((await tail.read()).records, [{ n: 1 }]);
    await fs.appendFile(path, '2}\nnot json\n{"n":3}\n');
    assert.deepEqual((await tail.read()).records, [{ n: 2 }, { n: 3 }]);

    await fs.writeFile(path, '{"n":9}\n');
    assert.deepEqual((await tail.read()).records, [{ n: 9 }]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("a resumed session's workflow runs", () => {
  const projectsDir = (fixture: string): string => nodePath.join(CLAUDE_FIXTURES_DIR, `${fixture}.disk`);
  const sessionDir = (fixture: string, sessionId: string): string =>
    nodePath.join(projectsDir(fixture), sessionId);
  const launchText = (fixture: string) => {
    const messages = readClaudeFixture(fixture)
      .filter((line) => line.kind === "sdk-message")
      .map((line) => line.data);
    const launches = workflowLaunchesIn(messages);
    assert.equal(launches.length, 1);
    return launches[0]!;
  };

  it("finds each launch by its call and its result text", () => {
    const { toolUseId, launch } = launchText("17-workflow.ndjson");
    assert.equal(toolUseId, "toolu_01DvgoeJ76Kfa7KTjUtk9jrY");
    assert.deepEqual(launch, {
      taskId: "wvg2ao9ra",
      runId: "wf_68d12d28-357",
      summary: "Two-phase capture demo"
    });
    assert.deepEqual(workflowLaunchesIn([
      { message: { content: [{ type: "tool_use", id: "toolu_x", name: "Workflow" }] } },
      { message: { content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "Workflow launched in background. Task ID: x\nRun ID: ../x" }] } }
    ]), []);
  });

  it("falls back to the journal when the run left no snapshot", async () => {
    const source = sessionDir("17-workflow", "97167e25-8c30-431f-b9f7-1cc1b48bd80b");
    const copy = await fs.mkdtemp(nodePath.join(tmpdir(), "wf-history-"));
    await fs.cp(nodePath.join(source, "subagents"), nodePath.join(copy, "subagents"), { recursive: true });
    const { toolUseId, launch } = launchText("17-workflow.ndjson");
    const run = await readWorkflowHistoryRun({ projectsDir: nodePath.dirname(copy), sessionDir: copy, toolUseId, launch });
    assert.equal(run.status, "stopped");
    assert.deepEqual(run.phases, [
      { index: 1, title: "Gather" },
      { index: 2, title: "Combine" }
    ]);
    assert.deepEqual(
      run.agents.map((agent) => [agent.index, agent.label, agent.status, agent.result]),
      [
        [1, "gather:alpha", "completed", "alpha"],
        [2, "gather:beta", "completed", "beta"],
        [3, "combine", "completed", "alpha beta done"]
      ]
    );
    await fs.rm(copy, { recursive: true, force: true });
  });

  it("projects the run's roster and each agent's conversation, owned by its member", async () => {
    const { toolUseId, launch } = launchText("19-workflow-tools.ndjson");
    const run = await readWorkflowHistoryRun({
      projectsDir: projectsDir("19-workflow-tools"),
      sessionDir: sessionDir("19-workflow-tools", "73710e20-3349-4b51-8911-683bd829bcff"),
      toolUseId,
      launch
    });
    const events = projectClaudeHistory(
      {
        threadId: "thread-history",
        turns: [
          {
            id: "turn-1",
            items: [
              { type: "user", uuid: "u1", message: { role: "user", content: "run it" } },
              {
                type: "assistant",
                uuid: "a1",
                message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "Workflow", input: {} }] }
              },
              run
            ]
          }
        ]
      },
      { clock: { now: () => new Date(0), nowIso: () => "1970-01-01T00:00:00.000Z" }, ids: countingIds() }
    );
    assert.deepEqual(
      taskRows(events).map(rowSummary),
      [
        "task.started wokihcb1u",
        "task.started wokihcb1u:wf:1",
        "task.completed wokihcb1u:wf:1 completed",
        "task.completed wokihcb1u completed"
      ]
    );
    const coordinator = taskRows(events, "wokihcb1u")[0]!;
    assert.equal(coordinator.payload.taskType, "local_workflow");
    assert.equal(coordinator.payload.toolUseId, toolUseId);
    const owned = events.filter((event) => (event as { agentId?: unknown }).agentId === "wokihcb1u:wf:1");
    assert.deepEqual(
      owned.filter((event) => event.type === "item.completed").map((event) => (event.payload as { itemType: string }).itemType),
      ["dynamic_tool_call", "assistant_message"]
    );
    const read = owned.find((event) => event.type === "item.completed");
    assert.equal((read?.payload as { data?: { toolName?: unknown } }).data?.toolName, "Read");
    const end = events.find((event) => event.type === "turn.completed");
    assert.equal(end?.type === "turn.completed" ? end.payload.tokenUsage?.hasSubagents : undefined, true);
  });
});

describe("a Workflow result that beats its run's start edge", () => {
  it("keeps the run handles for the coordinator's start row", () => {
    const lines = readClaudeFixture("17-workflow.ndjson");
    const isStart = (data: unknown): boolean =>
      (data as { subtype?: unknown }).subtype === "task_started";
    const isLaunchResult = (data: unknown): boolean =>
      JSON.stringify(data).includes('"tool_use_result":{"status":"async_launched"');
    const start = lines.findIndex((line) => line.kind === "sdk-message" && isStart(line.data));
    const result = lines.findIndex((line) => line.kind === "sdk-message" && isLaunchResult(line.data));
    assert.ok(start !== -1 && result > start);
    const reordered = [...lines];
    const [resultLine] = reordered.splice(result, 1);
    reordered.splice(start, 0, resultLine!);

    const normalizer = new ClaudeNormalizer({ threadId: "t", clock: fixedClock(), ids: countingIds() });
    const events: RuntimeEvent[] = [];
    for (const line of reordered) {
      if (line.kind === "input") {
        const turnId = String((line.data as { uuid?: unknown }).uuid);
        events.push(...normalizer.beginTurn({ turnId, anchorUuid: turnId }));
      } else if (line.kind === "sdk-message") {
        events.push(...normalizer.handleMessage(line.data as SDKMessage));
      }
    }
    const started = taskRows(events, "wvg2ao9ra").find((event) => event.type === "task.started");
    assert.equal(started?.payload.runHandles?.runId, "wf_68d12d28-357");
    assert.equal(started?.payload.taskType, "local_workflow");
  });
});

describe("workflow review regressions", () => {
  const snapshot = (taskId: string, state: string, extra: Record<string, unknown> = {}): SDKMessage =>
    ({
      type: "system",
      subtype: "task_progress",
      task_id: taskId,
      description: "Slow: slow:1",
      usage: { total_tokens: 1, tool_uses: 0, duration_ms: 1 },
      workflow_progress: [
        { type: "workflow_phase", index: 1, title: "Slow" },
        { type: "workflow_agent", index: 1, label: "slow:1", phaseIndex: 1, state, startedAt: 1, agentId: "a1", ...extra }
      ],
      session_id: "s",
      uuid: `u-${state}-${JSON.stringify(extra)}`
    }) as unknown as SDKMessage;

  it("a snapshot after the run ended reopens nothing", () => {
    const { normalizer } = replayClaudeFixture("18-workflow-stop.ndjson");
    const late = normalizer.handleMessage(snapshot("w63c5max6", "progress", { tokens: 99 }));
    assert.deepEqual(
      taskRows(late).filter((event) => event.payload.taskId.includes(":wf:")),
      []
    );
  });

  it("reads in-session history but never follows outside links or journal ids", async () => {
    const temp = await fs.mkdtemp(nodePath.join(tmpdir(), "wf-history-boundary-"));
    const projectsDir = nodePath.join(temp, "projects");
    const sessionDir = nodePath.join(projectsDir, "session");
    const outside = nodePath.join(temp, "outside");
    const runDir = nodePath.join(sessionDir, "subagents", "workflows", "wf_x");
    const snapshot = nodePath.join(sessionDir, "workflows", "wf_x.json");
    const journal = nodePath.join(runDir, "journal.jsonl");
    const transcript = nodePath.join(runDir, "agent-a1.jsonl");
    const input = { projectsDir, sessionDir, toolUseId: "toolu_x", launch: { taskId: "wx", runId: "wf_x" } };
    try {
      await fs.mkdir(nodePath.dirname(snapshot), { recursive: true });
      await fs.mkdir(runDir, { recursive: true });
      await fs.mkdir(outside);
      await fs.writeFile(snapshot, JSON.stringify({ taskId: "wx", status: "completed", workflowName: "inside" }));
      assert.equal((await readWorkflowHistoryRun(input)).workflowName, "inside");

      await fs.writeFile(nodePath.join(outside, "snapshot.json"), JSON.stringify({ taskId: "wx", workflowName: "outside" }));
      await fs.rm(snapshot);
      await fs.symlink(nodePath.join(outside, "snapshot.json"), snapshot);
      assert.equal((await readWorkflowHistoryRun(input)).workflowName, undefined);

      await fs.writeFile(
        nodePath.join(outside, "journal.jsonl"),
        `${JSON.stringify({ type: "started", key: "k", agentId: "a1", label: "outside" })}\n`
      );
      await fs.symlink(nodePath.join(outside, "journal.jsonl"), journal);
      assert.deepEqual((await readWorkflowHistoryRun(input)).agents, []);
      await fs.rm(journal);

      await fs.writeFile(
        journal,
        `${JSON.stringify({ type: "started", key: "k", agentId: "../../../../secret", label: "evil" })}\n` +
          `${JSON.stringify({ type: "started", key: "good", agentId: "a1", label: "inside" })}\n`
      );
      await fs.writeFile(transcript, `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "inside" }] } })}\n`);
      const inBounds = await readWorkflowHistoryRun(input);
      assert.deepEqual(inBounds.agents.map((agent) => agent.label), ["inside"]);
      assert.equal(inBounds.agents[0]?.records.length, 1);

      await fs.writeFile(nodePath.join(outside, "agent.jsonl"), `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "outside" }] } })}\n`);
      await fs.rm(transcript);
      await fs.symlink(nodePath.join(outside, "agent.jsonl"), transcript);
      assert.deepEqual((await readWorkflowHistoryRun(input)).agents[0]?.records, []);

      const linkedSession = nodePath.join(projectsDir, "linked-session");
      await fs.mkdir(nodePath.join(outside, "workflows"));
      await fs.writeFile(nodePath.join(outside, "workflows", "wf_x.json"), JSON.stringify({ taskId: "wx", workflowName: "outside-session" }));
      await fs.symlink(outside, linkedSession);
      assert.equal((await readWorkflowHistoryRun({ ...input, sessionDir: linkedSession })).workflowName, undefined);
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });
});

describe("JsonlFileTail reads", () => {
  it("reads a long line completely across concurrent reads without repeating records", async () => {
    const dir = await fs.mkdtemp(nodePath.join(tmpdir(), "jsonl-tail-long-"));
    const path = nodePath.join(dir, "agent-a.jsonl");
    const big = "x".repeat(600 * 1024);
    await fs.writeFile(path, `${JSON.stringify({ big })}\n{"n":2}\n`);
    const tail = new JsonlFileTail({ path });
    const [first, simultaneous] = await Promise.all([tail.read(), tail.read()]);
    assert.deepEqual(simultaneous.records, first.records);
    const records: unknown[] = [];
    records.push(...first.records);
    for (let read = 0; read < 4; read += 1) {
      records.push(...(await tail.read()).records);
    }
    assert.deepEqual(records, [{ big }, { n: 2 }]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("refuses a link, however it is named", async () => {
    const dir = await fs.mkdtemp(nodePath.join(tmpdir(), "jsonl-tail-link-"));
    const target = nodePath.join(dir, "elsewhere.jsonl");
    await fs.writeFile(target, '{"n":1}\n');
    const link = nodePath.join(dir, "agent-a.jsonl");
    await fs.symlink(target, link);
    assert.deepEqual(await new JsonlFileTail({ path: link }).read(), { records: [], done: true });
    await fs.rm(dir, { recursive: true, force: true });
  });
});
