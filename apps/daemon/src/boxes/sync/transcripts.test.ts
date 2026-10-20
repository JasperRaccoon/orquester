import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type { BoxPathMap } from "@orquester/api";

import { fakeBoxHub, mappedBoxConnection, type MappedBoxConnection } from "./testing.ts";
import { BoxTranscriptSyncService, claudeProjectDirName, type HostRunner } from "./transcripts.ts";

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}

/** Records every box read (path, offset, length). */
function recordReads(box: MappedBoxConnection): { path: string; offset?: number; length?: number }[] {
  const reads: { path: string; offset?: number; length?: number }[] = [];
  const original = box.readFile.bind(box);
  box.readFile = async (path, options) => {
    reads.push({ path, offset: options?.offset, length: options?.length });
    return original(path, options);
  };
  return reads;
}

async function fixture(options: { paths?: BoxPathMap; realpaths?: (cwd: string) => Record<string, string> } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "orq-transcripts-")));
  const home = join(base, "app", "agent-accounts", "claude", "a1", "home");
  const shared = join(base, "host", ".claude", "projects");
  const cwd = join(base, "w", "proj");
  await mkdir(home, { recursive: true });
  await mkdir(shared, { recursive: true });
  await mkdir(cwd, { recursive: true });
  // Like syncAccountHome: the account's projects/ is the shared one.
  await symlink(shared, join(home, "projects"));
  const box = mappedBoxConnection({ boxId: "b1", boxRoot: join(base, "box"), paths: options.paths, realpaths: options.realpaths?.(cwd) });
  await mkdir(box.local(cwd), { recursive: true });
  const reads = recordReads(box);
  const imports: { args: string[]; cwd: string; content: string }[] = [];
  const runHost: HostRunner = async (command, args, runOptions) => {
    if (args[0] === "export") {
      return { code: 0, stdout: Buffer.from(JSON.stringify({ info: { id: args[1] }, messages: [{ host: true }] })), stderr: "" };
    }
    imports.push({ args, cwd: runOptions.cwd, content: await readFile(args[1]!, "utf8") });
    return { code: 0, stdout: Buffer.alloc(0), stderr: "" };
  };
  const sync = new BoxTranscriptSyncService({ hub: fakeBoxHub({ b1: box }), runHost });
  return { base, home, shared, cwd, box, reads, sync, imports };
}

const signal = (): AbortSignal => new AbortController().signal;
const LINE = (n: number): string => `${JSON.stringify({ type: "user", n, text: "x".repeat(40) })}\n`;

test("Claude: new transcripts and sidecars land at the identical host path, through the shared projects link", async () => {
  const f = await fixture();
  const dir = join(f.home, "projects", claudeProjectDirName(f.cwd));
  await put(f.box.local(join(dir, "s1.jsonl")), LINE(1) + LINE(2));
  await put(f.box.local(join(dir, "s1", "subagents", "agent-a.jsonl")), LINE(9));
  await put(f.box.local(join(dir, "s1", "tool-results", "r1.txt")), "output");
  await put(f.box.local(join(dir, "s1", "tool-results", "token.json")), "never");
  await put(f.box.local(join(dir, "other.jsonl")), LINE(5));
  await f.sync.pullAfterTurn("b1", { agent: "claude", configRoot: f.home, cwd: f.cwd, sessionRef: "s1" }, signal());

  const hostDir = join(f.shared, claudeProjectDirName(f.cwd));
  assert.equal(await readFile(join(hostDir, "s1.jsonl"), "utf8"), LINE(1) + LINE(2));
  assert.equal(await readFile(join(hostDir, "s1", "subagents", "agent-a.jsonl"), "utf8"), LINE(9));
  assert.equal(await readFile(join(hostDir, "s1", "tool-results", "r1.txt"), "utf8"), "output");
  assert.equal(await exists(join(hostDir, "s1", "tool-results", "token.json")), false, "the deny list holds for transcripts too");
  assert.equal(await exists(join(hostDir, "other.jsonl")), false, "only the session's files");
  assert.equal((await lstat(join(f.home, "projects"))).isSymbolicLink(), true);
});

test("append-only transcripts move only their new tail; a rewrite or a shrink moves the whole file", async () => {
  const f = await fixture();
  const rel = join("projects", claudeProjectDirName(f.cwd), "s1.jsonl");
  const boxFile = f.box.local(join(f.home, rel));
  const hostFile = join(f.home, rel);
  const request = { agent: "claude" as const, configRoot: f.home, cwd: f.cwd, sessionRef: "s1" };

  await put(boxFile, LINE(1) + LINE(2));
  await f.sync.pullAfterTurn("b1", request, signal());
  assert.equal(await readFile(hostFile, "utf8"), LINE(1) + LINE(2));

  // Unchanged: nothing is read.
  f.reads.length = 0;
  await f.sync.pullAfterTurn("b1", request, signal());
  assert.equal(f.reads.length, 0);

  // Appended: only the tail.
  await put(boxFile, LINE(1) + LINE(2) + LINE(3));
  await f.sync.pullAfterTurn("b1", request, signal());
  assert.equal(await readFile(hostFile, "utf8"), LINE(1) + LINE(2) + LINE(3));
  const tail = f.reads.filter((read) => read.path === join(f.home, rel));
  assert.deepEqual(tail, [{ path: join(f.home, rel), offset: Buffer.byteLength(LINE(1) + LINE(2)), length: Buffer.byteLength(LINE(3)) }]);

  // Earlier bytes rewritten (and grown): whole file.
  f.reads.length = 0;
  const rewritten = LINE(7) + LINE(2) + LINE(3) + LINE(4);
  await put(boxFile, rewritten);
  await f.sync.pullAfterTurn("b1", request, signal());
  assert.equal(await readFile(hostFile, "utf8"), rewritten);
  assert.equal(f.reads.filter((read) => read.path === join(f.home, rel))[0]?.offset, undefined, "read from the start");

  // Shrunk: whole file.
  await put(boxFile, LINE(7));
  await f.sync.pullAfterTurn("b1", request, signal());
  assert.equal(await readFile(hostFile, "utf8"), LINE(7));

  // Same size, different bytes: whole file.
  await put(boxFile, LINE(8));
  await f.sync.pullAfterTurn("b1", request, signal());
  assert.equal(await readFile(hostFile, "utf8"), LINE(8));
});

test("pushForResume copies the session's files into the box once", async () => {
  const f = await fixture();
  const hostDir = join(f.shared, claudeProjectDirName(f.cwd));
  await put(join(hostDir, "s1.jsonl"), LINE(1));
  await put(join(hostDir, "s1", "subagents", "agent-a.jsonl"), LINE(2));
  await put(join(hostDir, "s2.jsonl"), LINE(3));
  const request = { agent: "claude" as const, configRoot: f.home, cwd: f.cwd, sessionRef: "s1" };
  await f.sync.pushForResume("b1", request, signal());
  const boxDir = f.box.local(join(f.home, "projects", claudeProjectDirName(f.cwd)));
  assert.equal(await readFile(join(boxDir, "s1.jsonl"), "utf8"), LINE(1));
  assert.equal(await readFile(join(boxDir, "s1", "subagents", "agent-a.jsonl"), "utf8"), LINE(2));
  assert.equal(await exists(join(boxDir, "s2.jsonl")), false);
  const writes = f.box.writes.length;
  await f.sync.pushForResume("b1", request, signal());
  assert.equal(f.box.writes.length, writes, "identical files are not sent again");
  // And the pull after the resumed turn moves only what the box appended.
  await put(join(boxDir, "s1.jsonl"), LINE(1) + LINE(4));
  f.reads.length = 0;
  await f.sync.pullAfterTurn("b1", request, signal());
  assert.equal(await readFile(join(hostDir, "s1.jsonl"), "utf8"), LINE(1) + LINE(4));
  assert.equal(f.reads.filter((read) => read.path.endsWith("s1.jsonl"))[0]?.offset, Buffer.byteLength(LINE(1)));
});

test("macOS: a transcript folder named after the box's realpath maps to the host's folder", async () => {
  const f = await fixture({ realpaths: (cwd) => ({ [cwd]: `/private${cwd}` }) });
  const request = { agent: "claude" as const, configRoot: f.home, cwd: f.cwd, sessionRef: "s1" };
  const realDir = join(f.home, "projects", claudeProjectDirName(`/private${f.cwd}`));
  await put(f.box.local(join(realDir, "s1.jsonl")), LINE(1));
  await f.sync.pullAfterTurn("b1", request, signal());
  assert.equal(await readFile(join(f.shared, claudeProjectDirName(f.cwd), "s1.jsonl"), "utf8"), LINE(1));
  assert.equal(await exists(join(f.shared, claudeProjectDirName(`/private${f.cwd}`))), false);
  // A resume pushes into both spellings, so the CLI finds the session whichever it uses.
  await put(join(f.shared, claudeProjectDirName(f.cwd), "s1.jsonl"), LINE(1) + LINE(2));
  await f.sync.pushForResume("b1", request, signal());
  assert.equal(await readFile(f.box.local(join(realDir, "s1.jsonl")), "utf8"), LINE(1) + LINE(2));
  assert.equal(await readFile(f.box.local(join(f.home, "projects", claudeProjectDirName(f.cwd), "s1.jsonl")), "utf8"), LINE(1) + LINE(2));
});

test("Windows: the box's C:\\orq folder name maps back to the host's", async () => {
  const f = await fixture({ paths: { kind: "windows-prefix", prefix: "C:\\orq" } });
  const boxCwd = `C:\\orq${f.cwd.replace(/\//g, "\\")}`;
  const boxDir = join(f.home, "projects", claudeProjectDirName(boxCwd));
  await put(f.box.local(join(boxDir, "s1.jsonl")), LINE(1));
  await f.sync.pullAfterTurn("b1", { agent: "claude", configRoot: f.home, cwd: f.cwd, sessionRef: "s1" }, signal());
  assert.equal(await readFile(join(f.shared, claudeProjectDirName(f.cwd), "s1.jsonl"), "utf8"), LINE(1));
  for (const read of f.reads) assert.ok(read.path.startsWith("C:\\orq\\"), read.path);
});

test("Codex: rollouts of the thread mirror by tail; nothing else under the home moves", async () => {
  const f = await fixture();
  const codexHome = join(f.base, "app", "agent-accounts", "codex", "c1", "home");
  await mkdir(codexHome, { recursive: true });
  const rollout = join(codexHome, "sessions", "2026", "10", "20", "rollout-2026-10-20T01-00-00-th1.jsonl");
  const other = join(codexHome, "sessions", "2026", "10", "20", "rollout-2026-10-20T02-00-00-th2.jsonl");
  await put(f.box.local(rollout), LINE(1));
  await put(f.box.local(other), LINE(2));
  await put(f.box.local(join(codexHome, "state_5.sqlite")), "db");
  const request = { agent: "codex" as const, configRoot: codexHome, cwd: f.cwd, sessionRef: "th1" };
  await f.sync.pullAfterTurn("b1", request, signal());
  assert.equal(await readFile(rollout, "utf8"), LINE(1));
  assert.equal(await exists(other), false);
  assert.equal(await exists(join(codexHome, "state_5.sqlite")), false, "the state DB is never copied");
  await put(f.box.local(rollout), LINE(1) + LINE(3));
  await f.sync.pullAfterTurn("b1", request, signal());
  assert.equal(await readFile(rollout, "utf8"), LINE(1) + LINE(3));
  // Without a session id, every changed rollout comes over.
  await f.sync.pullAfterTurn("b1", { ...request, sessionRef: null }, signal());
  assert.equal(await readFile(other, "utf8"), LINE(2));
});

test("Grok: the session dir under the URI-encoded cwd mirrors whole and by tail", async () => {
  const f = await fixture();
  const grokHome = join(f.base, "app", "agent-accounts", "grok", "g1", "home");
  await mkdir(grokHome, { recursive: true });
  const dir = join(grokHome, "sessions", encodeURIComponent(f.cwd), "g-1");
  await put(f.box.local(join(dir, "summary.json")), '{"generated_title":"A"}');
  await put(f.box.local(join(dir, "updates.jsonl")), LINE(1));
  const request = { agent: "grok" as const, configRoot: grokHome, cwd: f.cwd, sessionRef: "g-1" };
  await f.sync.pullAfterTurn("b1", request, signal());
  assert.equal(await readFile(join(dir, "summary.json"), "utf8"), '{"generated_title":"A"}');
  assert.equal(await readFile(join(dir, "updates.jsonl"), "utf8"), LINE(1));
  await put(f.box.local(join(dir, "summary.json")), '{"generated_title":"B"}');
  await f.sync.pullAfterTurn("b1", request, signal());
  assert.equal(await readFile(join(dir, "summary.json"), "utf8"), '{"generated_title":"B"}');
});

test("OpenCode: sessions travel as export/import in the project's cwd", async () => {
  const f = await fixture();
  const script = join(f.base, "fake-opencode.sh");
  await writeFile(
    script,
    [
      "#!/bin/sh",
      'if [ "$2" = ses_mismatch ]; then printf \'{"info":{"id":"ses_other"},"messages":[]}\'; exit 0; fi',
      'if [ "$1" = export ]; then printf \'{"info":{"id":"%s"},"messages":[{"box":true}]}\' "$2"; exit 0; fi',
      'if [ "$1" = import ]; then cp "$2" "$PWD/imported.json"; exit 0; fi',
      "exit 2"
    ].join("\n")
  );
  await chmod(script, 0o755);
  const sync = new BoxTranscriptSyncService({
    hub: fakeBoxHub({ b1: f.box }),
    opencode: { boxCommand: script },
    runHost: async (command, args, options) => {
      if (args[0] === "export") return { code: 0, stdout: Buffer.from(JSON.stringify({ info: { id: args[1] }, messages: [] })), stderr: "" };
      f.imports.push({ args, cwd: options.cwd, content: await readFile(args[1]!, "utf8") });
      return { code: 0, stdout: Buffer.alloc(0), stderr: "" };
    }
  });
  const request = { agent: "opencode" as const, configRoot: join(f.base, "cfg"), cwd: f.cwd, sessionRef: "ses_1" };
  await sync.pullAfterTurn("b1", request, signal());
  assert.equal(f.imports.length, 1);
  assert.equal(f.imports[0]!.cwd, f.cwd);
  assert.deepEqual(JSON.parse(f.imports[0]!.content), { info: { id: "ses_1" }, messages: [{ box: true }] });

  await sync.pushForResume("b1", request, signal());
  assert.deepEqual(JSON.parse(await readFile(join(f.box.local(f.cwd), "imported.json"), "utf8")), { info: { id: "ses_1" }, messages: [] });

  // An export naming another session is refused, never imported.
  await assert.rejects(sync.pullAfterTurn("b1", { ...request, sessionRef: "ses_mismatch" }, signal()), /another session/);
  assert.equal(f.imports.length, 1);
});
