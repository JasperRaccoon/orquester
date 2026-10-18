import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CODEX_STATE_DB_FILE, codexStateDbPresent, seedCodexHome, type SeedCodexHomeOptions } from "./codex-seed.ts";

const FAKE = fileURLToPath(new URL("./testing/fake-codex-seed.mjs", import.meta.url));

interface LogLine {
  pid: number;
  event: string;
  sessions?: string;
  method?: string;
}

describe("seedCodexHome", () => {
  let root: string;
  let codexHome: string;
  let sessionsTarget: string;
  let logFile: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codex-seed-"));
    codexHome = join(root, "profile-home");
    sessionsTarget = join(root, "account-home", "sessions");
    logFile = join(root, "fake.log");
    await mkdir(codexHome, { recursive: true });
    await mkdir(sessionsTarget, { recursive: true });
    await writeFile(join(sessionsTarget, "rollout-1.jsonl"), "{}\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function options(env: Record<string, string> = {}, extra: Partial<SeedCodexHomeOptions> = {}): SeedCodexHomeOptions {
    return {
      codexHome,
      sessionsTarget,
      codexBin: process.execPath,
      args: [FAKE, "app-server"],
      env: { PATH: process.env.PATH ?? "", HOME: root, FAKE_SEED_LOG: logFile, ...env },
      // The fake is a Node script: generous on a loaded host.
      timeoutMs: 60_000,
      ...extra
    };
  }

  async function events(): Promise<LogLine[]> {
    try {
      return (await readFile(logFile, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LogLine);
    } catch {
      return [];
    }
  }

  async function assertLinked(): Promise<void> {
    const sessions = join(codexHome, "sessions");
    assert.ok((await lstat(sessions)).isSymbolicLink());
    assert.equal(await readlink(sessions), sessionsTarget);
    assert.deepEqual(await readdir(sessions), ["rollout-1.jsonl"]);
  }

  it("seeds a fresh home on an empty real sessions/ directory, then links it", async () => {
    assert.equal(await codexStateDbPresent(codexHome), false);
    assert.deepEqual(await seedCodexHome(options()), { action: "seeded" });
    await assertLinked();
    assert.equal(await codexStateDbPresent(codexHome), true);
    const log = await events();
    assert.equal(log.filter((line) => line.event === "start").length, 1);
    // Codex saw an EMPTY real directory while it built its DB.
    assert.deepEqual(log.find((line) => line.event === "initialize")?.sessions, "empty-dir");
    assert.ok(log.some((line) => line.event === "notification" && line.method === "initialized"));
    // It exited on stdin EOF (a clean shutdown).
    assert.ok(log.some((line) => line.event === "exit"));
    // No staging leftovers.
    assert.deepEqual((await readdir(codexHome)).sort(), [CODEX_STATE_DB_FILE, "sessions"].sort());
  });

  it("does nothing when the home is already seeded and linked", async () => {
    await seedCodexHome(options());
    await unlink(logFile);
    assert.deepEqual(await seedCodexHome(options()), { action: "none" });
    assert.deepEqual(await events(), []);
    await assertLinked();
  });

  it("only relinks (no Codex) when the DB is present but the link is missing or points elsewhere", async () => {
    await writeFile(join(codexHome, CODEX_STATE_DB_FILE), "");
    assert.deepEqual(await seedCodexHome(options()), { action: "linked" });
    await assertLinked();

    const other = join(root, "elsewhere");
    await mkdir(other);
    await unlink(join(codexHome, "sessions"));
    await symlink(other, join(codexHome, "sessions"));
    assert.deepEqual(await seedCodexHome(options()), { action: "linked" });
    await assertLinked();

    // A crashed seed that left the empty real directory behind.
    await unlink(join(codexHome, "sessions"));
    await mkdir(join(codexHome, "sessions"));
    assert.deepEqual(await seedCodexHome(options()), { action: "linked" });
    await assertLinked();
    assert.deepEqual(await events(), []);
  });

  it("re-seeds a linked home whose state DB is missing (a Codex upgrade)", async () => {
    await symlink(sessionsTarget, join(codexHome, "sessions"));
    assert.deepEqual(await seedCodexHome(options()), { action: "seeded" });
    await assertLinked();
    assert.equal((await events()).find((line) => line.event === "initialize")?.sessions, "empty-dir");
    // The shared target was never touched.
    assert.deepEqual(await readdir(sessionsTarget), ["rollout-1.jsonl"]);
  });

  it("runs one Codex for concurrent calls on the same home", async () => {
    const results = await Promise.all([seedCodexHome(options()), seedCodexHome(options()), seedCodexHome(options())]);
    assert.deepEqual(results, [{ action: "seeded" }, { action: "seeded" }, { action: "seeded" }]);
    assert.equal((await events()).filter((line) => line.event === "start").length, 1);
    await assertLinked();
  });

  it("fails when Codex answers without creating the expected DB, leaving an empty sessions/ to retry", async () => {
    await assert.rejects(seedCodexHome(options({ FAKE_SEED_DB: "state_6.sqlite" })), /state_5\.sqlite was not created/);
    const sessions = join(codexHome, "sessions");
    assert.ok((await lstat(sessions)).isDirectory());
    assert.deepEqual(await readdir(sessions), []);
  });

  it("kills a Codex that never answers initialize and reports the deadline", async () => {
    await assert.rejects(seedCodexHome(options({ FAKE_SEED_HANG: "1" }, { timeoutMs: 300 })), /timed out/);
    // Under load the deadline can fire before the fake has even installed its
    // handlers (no "exit" line then), so check the process itself: every child
    // that started must be gone once seeding has rejected.
    const started = (await events()).filter((line) => line.event === "start").map((line) => Number(line.pid));
    for (const pid of started) {
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `child ${pid} is gone`);
    }
    assert.ok((await lstat(join(codexHome, "sessions"))).isDirectory());
  });

  it("kills a Codex that does not exit on stdin EOF and still links", async () => {
    assert.deepEqual(await seedCodexHome(options({ FAKE_SEED_IGNORE_EOF: "1" }, { exitGraceMs: 100 })), { action: "seeded" });
    assert.ok((await events()).some((line) => line.event === "exit"));
    await assertLinked();
  });

  it("reports a binary that cannot be started", async () => {
    await assert.rejects(seedCodexHome(options({}, { codexBin: join(root, "no-such-codex"), args: ["app-server"] })), /Seeding/);
  });

  it("refuses to replace a non-empty real sessions/ directory", async () => {
    await mkdir(join(codexHome, "sessions"));
    await writeFile(join(codexHome, "sessions", "rollout-x.jsonl"), "{}\n");
    await assert.rejects(seedCodexHome(options()), /non-empty directory/);
    assert.deepEqual(await readdir(join(codexHome, "sessions")), ["rollout-x.jsonl"]);
    assert.deepEqual(await events(), []);
  });
});
