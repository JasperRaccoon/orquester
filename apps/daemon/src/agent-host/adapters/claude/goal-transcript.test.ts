/**
 * Reading `goal_status` rows out of the CLI's own transcript (goals §6.1.4-5):
 * where the file is, incremental offsets that never re-read a row, the set
 * point, the restore scan, and every way a read can come up empty without
 * throwing at the session.
 *
 * Real files in a temp dir; the rows are shaped like the live ones (a
 * `goal_status` attachment between ordinary conversation rows).
 */

import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { after, before, describe, it } from "node:test";

import type { ClaudeGoalStatusRow } from "./goal.ts";
import {
  ClaudeGoalTranscript,
  claudeProjectDirName,
  locateClaudeTranscript
} from "./goal-transcript.ts";

const SESSION = "08f59265-4b3e-4a3f-9864-7f582e330b2e";

/**
 * Every row the transcript gained, read the way the session reads it: one
 * committed chunk per `readNew`, again while it says there is `more`.
 */
async function readAll(
  transcript: ClaudeGoalTranscript,
  sessionId: string
): Promise<ClaudeGoalStatusRow[] | undefined> {
  const rows: ClaudeGoalStatusRow[] = [];
  for (let calls = 0; calls < 10_000; calls += 1) {
    const chunk = await transcript.readNew(sessionId);
    if (chunk === undefined) {
      return calls === 0 ? undefined : rows;
    }
    rows.push(...chunk.rows);
    if (!chunk.more) {
      return rows;
    }
  }
  throw new Error("readNew never caught up");
}

function line(row: Record<string, unknown>): string {
  return `${JSON.stringify(row)}\n`;
}

function goalRow(attachment: Record<string, unknown>): string {
  return line({
    type: "attachment",
    uuid: `u-${Math.random().toString(16).slice(2)}`,
    parentUuid: null,
    sessionId: SESSION,
    attachment: { type: "goal_status", ...attachment }
  });
}

function userRow(text: string): string {
  return line({
    type: "user",
    uuid: `u-${Math.random().toString(16).slice(2)}`,
    sessionId: SESSION,
    message: { role: "user", content: text }
  });
}

describe("claude goal transcript — locating the file", () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(nodePath.join(tmpdir(), "orq-claude-goal-locate-"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("names the project dir the way the CLI does", () => {
    assert.equal(
      claudeProjectDirName("/var/lib/orquester/workspaces/jaspersito/MatsSmile"),
      "-var-lib-orquester-workspaces-jaspersito-MatsSmile"
    );
    assert.equal(claudeProjectDirName("/srv/VAS SAAS/app.v2"), "-srv-VAS-SAAS-app-v2");
  });

  it("finds a transcript under the exact dir, and nothing that is not there", async () => {
    const configDir = nodePath.join(root, "exact");
    const dir = nodePath.join(configDir, "projects", "-work-project");
    await mkdir(dir, { recursive: true });
    await writeFile(nodePath.join(dir, `${SESSION}.jsonl`), userRow("hi"));
    assert.equal(
      await locateClaudeTranscript({ configDir, cwd: "/work/project", sessionId: SESSION }),
      nodePath.join(dir, `${SESSION}.jsonl`)
    );
    assert.equal(
      await locateClaudeTranscript({ configDir, cwd: "/work/project", sessionId: "other" }),
      undefined
    );
    assert.equal(
      await locateClaudeTranscript({ configDir: nodePath.join(root, "none"), cwd: "/x", sessionId: SESSION }),
      undefined
    );
  });

  it("finds a long project path's dir by its prefix (its hash is the CLI's own)", async () => {
    const configDir = nodePath.join(root, "long");
    const cwd = `/work/${"deep/".repeat(60)}project`;
    const name = claudeProjectDirName(cwd);
    assert.ok(name.length > 200, "a name past the SDK's limit");
    const dir = nodePath.join(configDir, "projects", `${name.slice(0, 200)}-1x2y3z`);
    await mkdir(dir, { recursive: true });
    await writeFile(nodePath.join(dir, `${SESSION}.jsonl`), userRow("hi"));
    assert.equal(
      await locateClaudeTranscript({ configDir, cwd, sessionId: SESSION }),
      nodePath.join(dir, `${SESSION}.jsonl`)
    );
  });

  it("falls back to the cwd's real path when the CLI resolved a symlink", async () => {
    const configDir = nodePath.join(root, "real");
    const realProject = nodePath.join(root, "real-project");
    const linkedProject = nodePath.join(root, "linked-project");
    await mkdir(realProject, { recursive: true });
    await symlink(realProject, linkedProject);
    const dir = nodePath.join(configDir, "projects", claudeProjectDirName(realProject));
    await mkdir(dir, { recursive: true });
    await writeFile(nodePath.join(dir, `${SESSION}.jsonl`), userRow("hi"));
    assert.equal(
      await locateClaudeTranscript({ configDir, cwd: linkedProject, sessionId: SESSION }),
      nodePath.join(dir, `${SESSION}.jsonl`)
    );
  });
});

describe("claude goal transcript — reading goal_status rows", () => {
  let root: string;
  let seq = 0;
  before(async () => {
    root = await mkdtemp(nodePath.join(tmpdir(), "orq-claude-goal-read-"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function fixture(
    content: string,
    options: { maxReadBytes?: number } = {}
  ): Promise<{ transcript: ClaudeGoalTranscript; file: string }> {
    seq += 1;
    const configDir = nodePath.join(root, `c${seq}`);
    const dir = nodePath.join(configDir, "projects", "-work-project");
    await mkdir(dir, { recursive: true });
    const file = nodePath.join(dir, `${SESSION}.jsonl`);
    await writeFile(file, content);
    return {
      transcript: new ClaudeGoalTranscript({ configDir, cwd: "/work/project", ...options }),
      file
    };
  }

  it("reads only rows it has not read before", async () => {
    const { transcript, file } = await fixture(
      userRow("/goal ship it") + goalRow({ met: false, sentinel: true, condition: "ship it" })
    );
    const first = await readAll(transcript, SESSION);
    assert.deepEqual(first, [{ met: false, sentinel: true, failed: false, condition: "ship it" }]);
    assert.deepEqual(await readAll(transcript, SESSION), [], "nothing new, nothing returned");

    await appendFile(
      file,
      userRow("more work") +
        goalRow({ met: true, condition: "ship it", reason: "done", iterations: 2, durationMs: 60_000, tokens: 900 })
    );
    assert.deepEqual(await readAll(transcript, SESSION), [
      {
        met: true,
        sentinel: false,
        failed: false,
        condition: "ship it",
        reason: "done",
        iterations: 2,
        durationMs: 60_000,
        tokens: 900
      }
    ]);
  });

  it("reads a failed row", async () => {
    const { transcript } = await fixture(
      goalRow({ met: false, failed: true, condition: "ship it", reason: "no such repo", iterations: 1 })
    );
    assert.deepEqual(await readAll(transcript, SESSION), [
      { met: false, sentinel: false, failed: true, condition: "ship it", reason: "no such repo", iterations: 1 }
    ]);
  });

  it("leaves a line still being written for the next read", async () => {
    const complete = goalRow({ met: false, sentinel: true, condition: "a" });
    const partial = goalRow({ met: true, condition: "a" });
    const { transcript, file } = await fixture(complete + partial.slice(0, 20));
    assert.equal((await readAll(transcript, SESSION))?.length, 1);
    await appendFile(file, partial.slice(20));
    assert.deepEqual(
      (await readAll(transcript, SESSION))?.map((row) => row.met),
      [true],
      "the torn row is read once, whole, when it is finished"
    );
  });

  it("walks the file in bounded reads, rows split across reads included", async () => {
    let content = "";
    for (let index = 0; index < 20; index += 1) {
      content += userRow(`turn ${index} ${"x".repeat(index * 7)}`);
      content += goalRow({ met: false, condition: "a", reason: `check ${index}` });
    }
    // Longer than any one line here (the longest is ~260 bytes), shorter than
    // two: nearly every read ends inside a row, which the next read re-reads
    // from its start.
    const { transcript } = await fixture(content, { maxReadBytes: 300 });
    const rows = await readAll(transcript, SESSION);
    assert.deepEqual(
      rows?.map((row) => row.reason),
      Array.from({ length: 20 }, (_, index) => `check ${index}`)
    );
  });

  it("skips a line longer than one whole read — a goal row never is", async () => {
    const huge = userRow(`"goal_status" ${"y".repeat(5_000)}`);
    const { transcript } = await fixture(
      huge + goalRow({ met: true, condition: "a" }) + huge + goalRow({ met: false, condition: "a" }),
      { maxReadBytes: 1_024 }
    );
    assert.deepEqual(
      (await readAll(transcript, SESSION))?.map((row) => row.met),
      [true, false]
    );
  });

  it("ignores rows that only mention goal_status", async () => {
    const { transcript } = await fixture(
      userRow('a tool result quoting {"type":"goal_status"}') +
        line({ type: "assistant", attachment: { type: "goal_status", met: true, condition: "a" } }) +
        "not json at all \"goal_status\"\n"
    );
    assert.deepEqual(await readAll(transcript, SESSION), []);
  });

  it("starts a goal set in this session at its set point, never at an older row", async () => {
    const { transcript, file } = await fixture(
      goalRow({ met: false, sentinel: true, condition: "a" }) +
        goalRow({ met: true, sentinel: true, condition: "a" })
    );
    assert.equal(await transcript.markSetPoint(SESSION), true);
    await appendFile(file, goalRow({ met: false, sentinel: true, condition: "a" }));
    assert.deepEqual(
      (await readAll(transcript, SESSION))?.map((row) => [row.met, row.sentinel]),
      [[false, true]],
      "the clear of the goal's previous run is behind the set point"
    );
  });

  it("finds the LAST goal_status row and leaves the position at the end", async () => {
    const { transcript, file } = await fixture(
      goalRow({ met: false, sentinel: true, condition: "first" }) +
        goalRow({ met: true, condition: "first", iterations: 1 }) +
        userRow("later") +
        goalRow({ met: false, sentinel: true, condition: "second" }) +
        userRow("even later")
    );
    const last = await transcript.readLast(SESSION);
    assert.deepEqual(last, {
      row: { met: false, sentinel: true, failed: false, condition: "second" }
    });
    assert.deepEqual(await readAll(transcript, SESSION), [], "the scan consumed the file");
    await appendFile(file, goalRow({ met: true, condition: "second" }));
    assert.deepEqual(
      (await readAll(transcript, SESSION))?.map((row) => row.condition),
      ["second"]
    );
  });

  it("anchors an unplaced position at the tail, never before an older run's rows", async () => {
    const { transcript, file } = await fixture(
      goalRow({ met: false, sentinel: true, condition: "a" }) + goalRow({ met: true, condition: "a" })
    );
    assert.equal(await transcript.anchorAtTail(SESSION), true);
    await appendFile(file, goalRow({ met: false, condition: "a", reason: "new run" }));
    assert.deepEqual(
      (await readAll(transcript, SESSION))?.map((row) => row.reason),
      ["new run"],
      "the old run's met row stays behind the anchor"
    );
  });

  it("keeps a position the resume scan placed: rows written after the scan are read", async () => {
    const { transcript, file } = await fixture(goalRow({ met: false, sentinel: true, condition: "a" }));
    await transcript.readLast(SESSION);
    await appendFile(file, goalRow({ met: true, condition: "a" }));
    assert.equal(await transcript.anchorAtTail(SESSION), true);
    assert.deepEqual(
      (await readAll(transcript, SESSION))?.map((row) => row.met),
      [true],
      "the row that landed between the scan and the anchor is not skipped"
    );
  });

  it("reports a transcript with no goal rows as such", async () => {
    const { transcript } = await fixture(userRow("hello") + userRow("bye"));
    assert.deepEqual(await transcript.readLast(SESSION), { row: undefined });
  });

  it("answers undefined, never throws, for a transcript that does not exist", async () => {
    const transcript = new ClaudeGoalTranscript({
      configDir: nodePath.join(root, "missing"),
      cwd: "/work/project"
    });
    assert.equal(await readAll(transcript, SESSION), undefined);
    assert.equal(await transcript.readLast(SESSION), undefined);
    assert.equal(await transcript.markSetPoint(SESSION), false);
  });

  it("follows a new session id to its own file, from its start", async () => {
    const { transcript, file } = await fixture(goalRow({ met: false, sentinel: true, condition: "a" }));
    await readAll(transcript, SESSION);
    const forked = nodePath.join(nodePath.dirname(file), "forked-session.jsonl");
    await writeFile(forked, goalRow({ met: true, condition: "a" }));
    assert.deepEqual(
      (await readAll(transcript, "forked-session"))?.map((row) => row.met),
      [true]
    );
  });

  it("starts over when the file shrank under it", async () => {
    const { transcript, file } = await fixture(
      userRow("x".repeat(400)) + goalRow({ met: false, sentinel: true, condition: "a" })
    );
    await readAll(transcript, SESSION);
    await writeFile(file, goalRow({ met: true, condition: "a" }));
    assert.deepEqual(
      (await readAll(transcript, SESSION))?.map((row) => row.met),
      [true]
    );
  });

  it("commits every chunk: a delta bigger than one read is walked in pieces, each one kept", async () => {
    let content = "";
    for (let index = 0; index < 12; index += 1) {
      content += goalRow({ met: false, condition: "a", reason: `check ${index}` });
    }
    const { transcript } = await fixture(content, { maxReadBytes: 400 });
    const first = await transcript.readNew(SESSION);
    assert.ok(first !== undefined && first.more, "one read's worth, and more to come");
    assert.ok(first.rows.length >= 1 && first.rows.length < 12, `a partial chunk: ${first.rows.length}`);
    const second = await transcript.readNew(SESSION);
    assert.equal(
      second?.rows[0]?.reason,
      `check ${first.rows.length}`,
      "the next call starts where the last one committed, never at the start again"
    );
    const rest = await readAll(transcript, SESSION);
    assert.deepEqual(
      [...first.rows, ...(second?.rows ?? []), ...(rest ?? [])].map((row) => row.reason),
      Array.from({ length: 12 }, (_, index) => `check ${index}`),
      "every row exactly once"
    );
  });

  it("a chunk that is abandoned loses nothing an earlier chunk committed", async () => {
    let content = "";
    for (let index = 0; index < 6; index += 1) {
      content += goalRow({ met: false, condition: "a", reason: `check ${index}` });
    }
    const { transcript } = await fixture(content, { maxReadBytes: 400 });
    const first = await transcript.readNew(SESSION);
    assert.ok(first !== undefined && first.more, "a first chunk, committed");
    const stuck = transcript.readNew(SESSION);
    transcript.abandonPending();
    const abandoned = await stuck;
    const again = await transcript.readNew(SESSION);
    assert.deepEqual(
      again?.rows.map((row) => row.reason),
      abandoned?.rows.map((row) => row.reason),
      "the abandoned chunk is read again, from where the first one ended"
    );
    assert.notEqual(again?.rows[0]?.reason, first.rows[0]?.reason);
  });

  it("says there is no more once only a line still being written is left", async () => {
    const complete = goalRow({ met: false, sentinel: true, condition: "a" });
    const { transcript } = await fixture(complete + goalRow({ met: true, condition: "a" }).slice(0, 30));
    assert.deepEqual(await transcript.readNew(SESSION), {
      rows: [{ met: false, sentinel: true, failed: false, condition: "a" }],
      more: false
    });
  });

  it("an abandoned read never moves the position", async () => {
    const { transcript } = await fixture(goalRow({ met: true, condition: "a" }));
    const pending = transcript.readNew(SESSION);
    transcript.abandonPending();
    await pending;
    assert.deepEqual(
      (await readAll(transcript, SESSION))?.map((row) => row.met),
      [true],
      "the next read starts where the abandoned one did"
    );
  });
});
