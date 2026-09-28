import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import type { Clock } from "../contracts.ts";
import { createSandboxRunner } from "../sandbox/sandbox.ts";
import { edge, FakeProjects, flush, InMemoryRunStore, node, workflow } from "../testing/fakes.ts";
import { createHarness } from "../testing/harness.ts";
import { createShellExecutor } from "./shell.ts";

const T = () => node("T", "trigger.manual");

describe("wait", () => {
  test("until HH:MM waits for the next such time in the block's time zone", async () => {
    // 10:00Z is 12:00 in Madrid (CEST): the next 09:00 there is tomorrow 07:00Z.
    const h = createHarness({
      workflows: [workflow("w1", [T(), node("W", "wait", { kind: "until", time: "09:00", timezone: "Europe/Madrid" })], [edge("T", "W")])]
    });
    const { runId } = await h.engine.run("w1", { input: "carry" });
    await flush();
    const block = (await h.runStore.load(runId!))!.blocks.W!;
    assert.equal(block.status, "waiting");
    assert.deepEqual(block.waitingOn, { kind: "timer", until: "2026-09-29T07:00:00.000Z", purpose: "wait" });
    await h.clock.advance(21 * 60 * 60_000 - 1);
    assert.equal((await h.runStore.load(runId!))!.status, "running");
    await h.clock.advance(1);
    const result = await h.engine.waitForRun(runId!);
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.finalOutput, { kind: "manual", input: "carry" });
  });

  test("the workflow's own time zone applies when the block names none", async () => {
    const h = createHarness({
      workflows: [workflow("w1", [T(), node("W", "wait", { kind: "until", time: "10:30" })], [edge("T", "W")], { settings: { timezone: "UTC" } })]
    });
    const { runId } = await h.engine.run("w1", {});
    await flush();
    assert.equal((await h.runStore.load(runId!))!.blocks.W!.waitingUntil, "2026-09-28T10:30:00.000Z");
    await h.engine.cancel(runId!);
    assert.equal((await h.engine.waitForRun(runId!)).status, "cancelled");
  });
});

describe("shell output caps", () => {
  let root: string;
  let projectPath: string;
  const realClock: Clock = {
    now: () => new Date(),
    setTimeout(fn, ms) {
      const timer = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(timer) };
    }
  };
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "orq-wf-shell-"));
    projectPath = join(root, "ws", "app");
    await mkdir(projectPath, { recursive: true });
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("stdout and stderr are the tails within the cap, with a warning; the whole log stays on disk", async () => {
    const projects = new FakeProjects();
    projects.existing.add(projectPath);
    const h = createHarness({
      workflows: [
        workflow(
          "w1",
          [T(), node("S", "shell", { script: "for i in $(seq 1 2000); do echo line-$i; done; echo err-tail >&2" })],
          [edge("T", "S")],
          { project: { kind: "existing", projectPath } }
        )
      ],
      executors: { shell: createShellExecutor({ maxOutputBytes: 8 * 1024 }) },
      runStore: new InMemoryRunStore(join(root, "runs")),
      projects,
      clock: realClock as never,
      sandbox: createSandboxRunner({ pollMs: 20, killGraceMs: 300, appdirTmp: root }) as never
    });
    const { runId } = await h.engine.run("w1", {});
    const result = await h.engine.waitForRun(runId!);
    const run = (await h.engine.getRun(runId!))!;
    assert.equal(result.status, "succeeded");
    const output = run.blocks.S!.output as { stdout: string; stderr: string; exitCode: number };
    assert.ok(Buffer.byteLength(JSON.stringify(output)) <= 8 * 1024);
    assert.ok(output.stdout.endsWith("line-2000\n"), "the tail is kept");
    assert.ok(!output.stdout.includes("line-1\n"), "the head is cut");
    assert.equal(output.stderr, "err-tail\n");
    assert.ok(run.blocks.S!.warnings?.some((warning) => warning.startsWith("stdout was cut")));
    assert.ok((run.blocks.S!.logs?.stdoutBytes ?? 0) > 8 * 1024, "the log itself is whole");
  });
});
