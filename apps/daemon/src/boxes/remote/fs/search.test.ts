import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { onPath } from "../../../archive.ts";
import { FsSearchError } from "../../../search.ts";
import type { BoxProcess } from "../../contracts.ts";
import { BoxProjectFs } from "./project-fs.ts";
import { listBoxProjectFiles, searchBoxProjectFiles } from "./search.ts";
import { boxDiskConnection, type BoxDiskConnection } from "./test-box.ts";

// Cancellation of the box-side listers and searches: the request's signal kills the process IN the box.

const PROJECT = "/ws/acme/engine";

async function setup(t: test.TestContext): Promise<{ fs: BoxProjectFs; connection: BoxDiskConnection }> {
  const disk = await realpath(await mkdtemp(join(tmpdir(), "orq-box-search-")));
  t.after(() => rm(disk, { recursive: true, force: true }));
  const connection = boxDiskConnection({ disk });
  const root = connection.local(PROJECT);
  await mkdir(root, { recursive: true });
  for (let i = 0; i < 50; i += 1) {
    await mkdir(join(root, `dir${i}`), { recursive: true });
    await writeFile(join(root, `dir${i}`, "file.txt"), `needle ${i}\n`.repeat(200));
  }
  return { fs: new BoxProjectFs(connection), connection };
}

/** Abort `controller` the moment `command` starts in the box; answers the processes it saw. */
function abortOnSpawn(connection: BoxDiskConnection, command: string, controller: AbortController): BoxProcess[] {
  const started: BoxProcess[] = [];
  const exec = connection.exec.bind(connection);
  connection.exec = (options) => {
    const proc = exec(options);
    if (options.command === command) {
      started.push(proc);
      // Once the caller has wired its abort listener (right after the spawn returns).
      setImmediate(() => controller.abort());
    }
    return proc;
  };
  return started;
}

async function killed(proc: BoxProcess): Promise<void> {
  if (proc.exitCode === null && proc.signalCode === null) await once(proc, "exit");
  assert.ok(proc.killed || proc.signalCode !== null, "the box process was killed");
}

test("a cancelled search kills ripgrep in the box and answers 499", { skip: !onPath("rg") }, async (t) => {
  const { fs, connection } = await setup(t);
  const controller = new AbortController();
  const started = abortOnSpawn(connection, "rg", controller);
  await assert.rejects(
    searchBoxProjectFiles(fs, PROJECT, { query: "needle", signal: controller.signal }),
    (error: unknown) => error instanceof FsSearchError && error.status === 499 && error.code === "REQUEST_ABORTED"
  );
  assert.equal(started.length, 1);
  await killed(started[0]!);
});

test("a cancelled regex search kills ripgrep too", { skip: !onPath("rg") }, async (t) => {
  const { fs, connection } = await setup(t);
  const controller = new AbortController();
  const started = abortOnSpawn(connection, "rg", controller);
  await assert.rejects(
    searchBoxProjectFiles(fs, PROJECT, { query: "need(le)?\\s+\\d+", regex: true, signal: controller.signal }),
    (error: unknown) => error instanceof FsSearchError && error.status === 499
  );
  await killed(started[0]!);
});

test("a cancelled quick-open listing kills its lister in the box", { skip: !onPath("rg") }, async (t) => {
  const { fs, connection } = await setup(t);
  const controller = new AbortController();
  const started = abortOnSpawn(connection, "rg", controller);
  await assert.rejects(
    listBoxProjectFiles(fs, PROJECT, { signal: controller.signal }),
    (error: unknown) => error instanceof FsSearchError && error.status === 499
  );
  await killed(started[0]!);
});

test("an already-cancelled search starts nothing in the box", async (t) => {
  const { fs, connection } = await setup(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(searchBoxProjectFiles(fs, PROJECT, { query: "needle", signal: controller.signal }), FsSearchError);
  assert.deepEqual(connection.execs, []);
});

test("the max-results cap stops ripgrep early and reports the limit", { skip: !onPath("rg") }, async (t) => {
  const { fs } = await setup(t);
  const result = await searchBoxProjectFiles(fs, PROJECT, { query: "needle", maxResults: 5 });
  assert.equal(result.totalMatches, 5);
  assert.equal(result.limitHit, true);
  assert.equal(result.tool, "rg");
});
