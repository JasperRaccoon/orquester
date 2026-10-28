/**
 * The temporary-box backend (Ephemeral AI VMs spec §13): the ownership rule on every operation,
 * create and destroy over the box service seam, the readiness wait, foreground exec with capped
 * tails, background jobs, streamed file and directory transfers with host-side containment, port
 * forwards closed with their box, and the chat-close cleanup — over `localBoxConnection()` and an
 * in-memory box service, with a manual clock (no sleeps).
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, watch, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createServer, connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";

import type { CallerPrincipal } from "@orquester/api/agent-chat";
import type { StoredBox } from "@orquester/config";

import type { BoxProcess, BoxRegistry } from "../contracts.ts";
import { boxDiskConnection, fakeBoxRegistry, type BoxDiskConnection } from "../remote/fs/test-box.ts";
import { localBoxConnection, type LocalBoxConnection } from "../testing.ts";
import { ProjectBoxForwards } from "./project-forwards.ts";
import { boxSummary, FakeForwardingHub, FakeTemporaryBoxes, ManualClock } from "./testing.ts";
import { boxPathFor, EXEC_STDOUT_TAIL_BYTES, KILL_GRACE_MS, shellArgv, TemporaryBoxTools } from "./tools.ts";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "boxes-temporary-")));
const PROJECT = join(ROOT, "workspaces", "acme", "game");
const OTHER = join(ROOT, "workspaces", "acme", "other");
const BOX = join(ROOT, "box");
for (const dir of [PROJECT, OTHER, BOX]) mkdirSync(dir, { recursive: true });
/** Every process a test started in the local "box": anything still running is killed at the end. */
const started: BoxProcess[] = [];
test.after(() => {
  for (const process of started) process.kill("SIGKILL");
  rmSync(ROOT, { recursive: true, force: true });
});

const agent = (threadId = "chat-a", projectPath = PROJECT): CallerPrincipal => ({ kind: "agent", threadId, projectPath, agent: "claude", title: "Game" });
const USER: CallerPrincipal = { kind: "user" };

interface World {
  boxes: FakeTemporaryBoxes;
  tools: TemporaryBoxTools;
  clock: ManualClock;
  connection: LocalBoxConnection;
  open: Set<string>;
}

function world(options: { connect?: boolean; registry?: Pick<BoxRegistry, "locate"> } = {}): World {
  const boxes = new FakeTemporaryBoxes()
    .add(boxSummary({ id: "box-a", threadId: "chat-a" }))
    .add(boxSummary({ id: "box-b", threadId: "chat-b" }))
    .add(boxSummary({ id: "box-p", purpose: "project", threadId: null }));
  const clock = new ManualClock();
  const connection = localBoxConnection({ boxId: "box-a", sys: { home: BOX } });
  const exec = connection.exec.bind(connection);
  connection.exec = (options) => {
    const process = exec(options);
    started.push(process);
    return process;
  };
  const open = new Set(["chat-a", "chat-b"]);
  let next = 0;
  const tools = new TemporaryBoxTools({ clock, isChatOpen: (id) => open.has(id), newId: () => `id${(next += 1)}`, logger: { warn: () => {}, error: () => {} } });
  if (options.connect !== false) {
    tools.connect({
      boxes,
      hub: { get: (boxId) => (boxId === "box-a" || boxId === "box-b" ? connection : undefined) },
      ...(options.registry ? { registry: options.registry } : {})
    });
  }
  return { boxes, tools, clock, connection, open };
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

test("ownership: a chat reaches only its own temporary boxes; a person reaches all; external callers none", async () => {
  const { tools } = world();
  const listed = tools.list(agent());
  assert.ok(listed.ok);
  assert.deepEqual(listed.value.map((box) => box.id), ["box-a"]);
  const all = tools.list(USER);
  assert.ok(all.ok);
  assert.deepEqual(all.value.map((box) => box.id), ["box-a", "box-b"], "project boxes are never temporary boxes");
  const filtered = tools.list(USER, "chat-b");
  assert.ok(filtered.ok && filtered.value.length === 1 && filtered.value[0]!.id === "box-b");
  assert.equal(tools.list({ kind: "external" }).ok, false);

  // Another chat's box, a project box and an unknown id read the same.
  for (const id of ["box-b", "box-p", "nope"]) {
    const got = tools.get(agent(), id);
    assert.ok(!got.ok && got.code === "BOX_NOT_FOUND" && got.status === 404, id);
    const exec = await tools.exec(id, { command: "true", timeoutSeconds: 5, background: false }, { principal: agent() });
    assert.ok(!exec.ok && exec.code === "BOX_NOT_FOUND", id);
    const destroyed = await tools.destroy(agent(), id);
    assert.ok(!destroyed.ok && destroyed.code === "BOX_NOT_FOUND", id);
    const forward = await tools.forwardPort(id, 80, { principal: agent() });
    assert.ok(!forward.ok && forward.code === "BOX_NOT_FOUND", id);
    const output = await tools.jobOutput(id, "job-x", 0, { principal: agent() });
    assert.ok(!output.ok && output.code === "BOX_NOT_FOUND", id);
  }
  assert.ok(tools.get(USER, "box-b").ok);
  const external = tools.get({ kind: "external" }, "box-a");
  assert.ok(!external.ok && external.code === "PERMISSION_DENIED");
});

test("until the box service connects, everything answers BOXES_DISABLED and the tools are not available", async () => {
  const { tools, boxes } = world({ connect: false });
  assert.equal(tools.available(), false);
  const listed = tools.list(agent());
  assert.ok(!listed.ok && listed.code === "BOXES_DISABLED" && listed.status === 503);
  let changes = 0;
  tools.onAvailabilityChange(() => (changes += 1));
  const disconnect = tools.connect({ boxes, hub: { get: () => undefined } });
  assert.equal(tools.available(), true);
  disconnect();
  assert.equal(tools.available(), false);
  assert.equal(changes, 2);
  assert.equal(boxes.listenerCount(), 0, "the disconnect unsubscribes from box changes");
});

// ---------------------------------------------------------------------------
// Create, destroy, readiness
// ---------------------------------------------------------------------------

const createBody = { kind: "linux", provider: "hetzner", size: "cx22", region: "fsn1", lifetimeMinutes: 120, purposeNote: "build on Linux" };

test("create: agent principals only, validated, owned by the calling chat", async () => {
  const { tools, boxes } = world();
  const byUser = await tools.create(USER, createBody);
  assert.ok(!byUser.ok && byUser.status === 403);
  const bad = await tools.create(agent(), { ...createBody, lifetimeMinutes: 5 });
  assert.ok(!bad.ok && bad.code === "BOX_INVALID_REQUEST");
  const badProvider = await tools.create(agent(), { ...createBody, provider: "aws" });
  assert.ok(!badProvider.ok && badProvider.code === "BOX_INVALID_REQUEST");
  const created = await tools.create(agent(), createBody);
  assert.ok(created.ok);
  assert.equal(created.value.threadId, "chat-a");
  assert.deepEqual(boxes.created.at(-1), { threadId: "chat-a", kind: "linux", provider: "hetzner", size: "cx22", region: "fsn1", lifetimeMinutes: 120, purposeNote: "build on Linux" });
  // A service refusal with a box error code passes its message through; anything else is generic.
  boxes.createError = Object.assign(new Error("Hetzner is not set up."), { code: "BOX_PROVIDER_NOT_CONFIGURED" });
  const refused = await tools.create(agent(), createBody);
  assert.ok(!refused.ok && refused.code === "BOX_PROVIDER_NOT_CONFIGURED" && refused.message === "Hetzner is not set up." && refused.status === 409);
  boxes.createError = new Error("socket hang up at /secret/path");
  const failed = await tools.create(agent(), createBody);
  assert.ok(!failed.ok && failed.code === "INTERNAL" && !failed.message.includes("/secret/path"));
});

test("create: a closed chat gets no box; a chat closing while its box is created has it destroyed (chat-closed)", async () => {
  const { tools, boxes, open } = world();
  open.delete("chat-b");
  const closed = await tools.create(agent("chat-b"), createBody);
  assert.ok(!closed.ok && closed.code === "THREAD_NOT_FOUND");
  assert.equal(boxes.created.length, 0);
  boxes.onCreate = () => open.delete("chat-a");
  const raced = await tools.create(agent(), createBody);
  assert.ok(!raced.ok && raced.code === "THREAD_NOT_FOUND");
  assert.deepEqual(boxes.destroyed, [{ boxId: "tmp-1", reason: "chat-closed" }]);
});

test("destroy: waits for the service, idempotent, and the reason is the agent's", async () => {
  const { tools, boxes } = world();
  const gone = await tools.destroy(agent(), "box-a");
  assert.ok(gone.ok && gone.value.state === "destroyed");
  assert.deepEqual(boxes.destroyed, [{ boxId: "box-a", reason: "agent" }]);
  const again = await tools.destroy(agent(), "box-a");
  assert.ok(again.ok);
  assert.equal(boxes.destroyed.length, 1, "an already destroyed box is not destroyed again");
});

test("waitReady: resolves on the change that makes the box ready; fails on destroy, the deadline, or abort", async () => {
  const { tools, boxes, clock } = world();
  const created = await tools.create(agent(), createBody);
  assert.ok(created.ok);
  const id = created.value.id;
  const waiting = tools.waitReady(id, 60_000, { principal: agent() });
  boxes.update(id, { state: "provisioning", stateReason: "Connecting…" });
  boxes.update(id, { state: "ready", connected: true });
  const ready = await waiting;
  assert.ok(ready.ok && ready.value.state === "ready");
  assert.equal(clock.pending().length, 0, "the deadline timer is cleared");

  const second = await tools.create(agent(), createBody);
  assert.ok(second.ok);
  const failing = tools.waitReady(second.value.id, 60_000, { principal: agent() });
  boxes.update(second.value.id, { state: "destroyed", stateReason: "Vultr refused the image" });
  const failed = await failing;
  assert.ok(!failed.ok && failed.code === "BOX_PROVISIONING_FAILED" && failed.message.includes("Vultr refused the image"));

  // The teardown's state reason ("Destroying…") is no reason: the failed step's message is.
  const stock = await tools.create(agent(), createBody);
  assert.ok(stock.ok);
  const outOfStock = tools.waitReady(stock.value.id, 60_000, { principal: agent() });
  boxes.update(stock.value.id, {
    state: "destroying",
    stateReason: "Destroying…",
    setup: [
      { id: "create", label: "Create the machine", state: "failed", startedAt: null, finishedAt: null, message: "RunPod: There are no longer any instances available." },
      { id: "connect", label: "Wait for orq-agent to connect", state: "pending", startedAt: null, finishedAt: null, message: null }
    ]
  });
  const stockFailed = await outOfStock;
  assert.ok(!stockFailed.ok);
  assert.equal(stockFailed.message, "The box did not start: Create the machine: RunPod: There are no longer any instances available.");

  const third = await tools.create(agent(), createBody);
  assert.ok(third.ok);
  const timing = tools.waitReady(third.value.id, 60_000, { principal: agent() });
  clock.advance(60_000);
  const timedOut = await timing;
  assert.ok(!timedOut.ok && timedOut.code === "BOX_NOT_READY");

  const controller = new AbortController();
  const aborting = tools.waitReady(third.value.id, 60_000, { principal: agent(), signal: controller.signal });
  controller.abort();
  const aborted = await aborting;
  assert.ok(!aborted.ok && aborted.code === "CANCELLED");
  // Another chat cannot wait on it.
  const foreign = await tools.waitReady(third.value.id, 60_000, { principal: agent("chat-b") });
  assert.ok(!foreign.ok && foreign.code === "BOX_NOT_FOUND");
});

test("operations need a ready, connected box", async () => {
  const { tools, boxes, connection } = world();
  boxes.update("box-a", { state: "unreachable" });
  const unreachable = await tools.exec("box-a", { command: "true", timeoutSeconds: 5, background: false }, { principal: agent() });
  assert.ok(!unreachable.ok && unreachable.code === "BOX_NOT_READY" && unreachable.message.includes("unreachable"));
  boxes.update("box-a", { state: "ready" });
  connection.setConnected(false);
  const offline = await tools.exec("box-a", { command: "true", timeoutSeconds: 5, background: false }, { principal: agent() });
  assert.ok(!offline.ok && offline.code === "BOX_NOT_READY");
});

// ---------------------------------------------------------------------------
// Exec
// ---------------------------------------------------------------------------

test("shells: bash by default on Linux and macOS, PowerShell on Windows; cmd only on Windows", () => {
  assert.deepEqual(shellArgv("bash", "linux", "make"), { command: "bash", args: ["-lc", "make"] });
  assert.deepEqual(shellArgv("sh", "darwin", "ls"), { command: "sh", args: ["-c", "ls"] });
  const ps = shellArgv("powershell", "win32", "dir")!;
  assert.equal(ps.command, "powershell.exe");
  assert.ok(ps.args.at(-1)!.endsWith("; dir"));
  assert.equal(shellArgv("powershell", "linux", "dir")!.command, "pwsh");
  assert.deepEqual(shellArgv("cmd", "win32", "dir"), { command: "cmd.exe", args: ["/d", "/s", "/c", "dir"] });
  assert.equal(shellArgv("cmd", "linux", "dir"), null);
  assert.equal(boxPathFor({ os: "linux", home: "/root" }, "work/x"), "/root/work/x");
  assert.equal(boxPathFor({ os: "linux", home: "/root" }, "~/a"), "/root/a");
  assert.equal(boxPathFor({ os: "linux", home: "/root" }, "/opt/a"), "/opt/a");
  assert.equal(boxPathFor({ os: "win32", home: "C:\\Users\\orq" }, "work/x"), "C:\\Users\\orq\\work\\x");
  assert.equal(boxPathFor({ os: "win32", home: "C:\\Users\\orq" }, "D:\\build"), "D:\\build");
  assert.equal(boxPathFor({ os: "linux", home: "/root" }, undefined), "/root");
  assert.equal(boxPathFor({ os: "linux", home: "/root" }, "a\0b"), null);
});

test("foreground exec: exit code, both streams, cwd in the box", async () => {
  const { tools } = world();
  mkdirSync(join(BOX, "work"), { recursive: true });
  const result = await tools.exec("box-a", { command: "pwd; echo out; echo err >&2; exit 3", shell: "sh", cwd: "work", timeoutSeconds: 30, background: false }, { principal: agent() });
  assert.ok(result.ok, result.ok ? "" : result.message);
  assert.ok(!result.value.background);
  if (result.value.background) return;
  assert.equal(result.value.exitCode, 3);
  assert.equal(result.value.stdout.text, `${join(BOX, "work")}\nout\n`);
  assert.equal(result.value.stderr.text, "err\n");
  assert.equal(result.value.timedOut, false);
  assert.equal(result.value.connectionLost, false);
});

test("foreground exec: the returned output is capped on a UTF-8 boundary with the total byte count", async () => {
  const { tools } = world();
  const result = await tools.exec("box-a", { command: 'awk \'BEGIN { for (i=0; i<50000; i++) printf "é"; printf "END" }\'', shell: "sh", timeoutSeconds: 30, background: false }, { principal: agent() });
  assert.ok(result.ok && !result.value.background);
  if (result.value.background) return;
  assert.equal(result.value.stdout.bytes, 100_003);
  assert.equal(result.value.stdout.truncated, true);
  // The 24 KiB cut falls inside a two-byte é, so its continuation byte is discarded.
  assert.equal(Buffer.byteLength(result.value.stdout.text), EXEC_STDOUT_TAIL_BYTES - 1);
  assert.match(result.value.stdout.text, /^é+END$/);
});

test("foreground exec: the timeout stops the command (SIGTERM, then SIGKILL after a grace)", async () => {
  const { tools, clock } = world();
  const running = tools.exec("box-a", { command: "trap '' TERM; echo started; while :; do :; done", shell: "sh", timeoutSeconds: 7, background: false }, { principal: agent() });
  assert.deepEqual(clock.pending(), [7_000]);
  // The trap is set once it printed.
  await once(started.at(-1)!.stdout, "data");
  clock.fire(7_000);
  // The trap ignores SIGTERM: the grace timer's SIGKILL ends it.
  assert.deepEqual(clock.pending(), [KILL_GRACE_MS]);
  clock.fire(KILL_GRACE_MS);
  const result = await running;
  assert.ok(result.ok && !result.value.background);
  if (result.value.background) return;
  assert.equal(result.value.timedOut, true);
  assert.equal(result.value.signal, "SIGKILL");
});

test("foreground exec: aborting the call stops the command", async () => {
  const { tools } = world();
  const controller = new AbortController();
  const running = tools.exec("box-a", { command: "exec sleep 600", shell: "sh", timeoutSeconds: 700, background: false }, { principal: agent(), signal: controller.signal });
  controller.abort();
  const result = await running;
  assert.ok(!result.ok && result.code === "CANCELLED");
});

test("foreground exec: a shell that does not exist in the box is a clear refusal", async () => {
  const { tools } = world();
  const missing = await tools.exec("box-a", { command: "dir", shell: "cmd", timeoutSeconds: 5, background: false }, { principal: agent() });
  assert.ok(!missing.ok && missing.code === "INVALID_ARGUMENT");
});

// ---------------------------------------------------------------------------
// Background jobs
// ---------------------------------------------------------------------------

test("background jobs: a job id at once, output and exit read later (event-driven wait), the box buffer released", async () => {
  const { tools, connection } = world();
  const started = await tools.exec("box-a", { command: "echo one; echo two >&2; exit 4", shell: "sh", timeoutSeconds: 600, background: true }, { principal: agent() });
  assert.ok(started.ok && started.value.background);
  if (!started.value.background) return;
  const jobId = started.value.jobId;
  assert.match(jobId, /^job-/);
  const finished = await tools.jobOutput("box-a", jobId, 600_000, { principal: agent() });
  assert.ok(finished.ok);
  assert.equal(finished.value.running, false);
  assert.equal(finished.value.exitCode, 4);
  assert.ok(finished.value.output.text.includes("one\n") && finished.value.output.text.includes("two\n"));
  assert.equal(finished.value.output.bytes, 8);
  assert.ok(connection.calls.some((call) => call.method === "proc.release" && (call.params as { procId: string }).procId === jobId));
  // Another chat cannot read it; an unknown job id is refused.
  const foreign = await tools.jobOutput("box-a", jobId, 0, { principal: agent("chat-b") });
  assert.ok(!foreign.ok && foreign.code === "BOX_NOT_FOUND");
  const unknown = await tools.jobOutput("box-a", "job-unknown", 0, { principal: agent() });
  assert.ok(!unknown.ok && unknown.code === "JOB_NOT_FOUND");
});

test("background jobs: a job is forgotten when its box is destroyed", async () => {
  const { tools, boxes } = world();
  const started = await tools.exec("box-a", { command: "exec sleep 600", shell: "sh", timeoutSeconds: 600, background: true }, { principal: agent() });
  assert.ok(started.ok && started.value.background);
  if (!started.value.background) return;
  const waiting = tools.jobOutput("box-a", started.value.jobId, 600_000, { principal: agent() });
  await tools.destroy(agent(), "box-a");
  const result = await waiting;
  assert.ok(result.ok);
  assert.equal(result.value.running, false);
  assert.equal(result.value.lost, "The box was destroyed.");
  assert.equal(boxes.get("box-a")!.state, "destroyed");
  // The local double runs real processes: the one left behind is killed at the end (`started`).
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

test("upload: a file streamed to the box (mode kept, parents made), a directory as its contents", async () => {
  const { tools } = world();
  writeFileSync(join(PROJECT, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  const file = await tools.upload("box-a", { localPath: join(PROJECT, "run.sh"), remotePath: "in/run.sh" }, { principal: agent() });
  assert.ok(file.ok, file.ok ? "" : file.message);
  assert.deepEqual(file.value, { kind: "file", bytes: 18, localPath: join(PROJECT, "run.sh"), remotePath: join(BOX, "in", "run.sh") });
  assert.equal(readFileSync(join(BOX, "in", "run.sh"), "utf8"), "#!/bin/sh\necho hi\n");
  assert.equal(statSync(join(BOX, "in", "run.sh")).mode & 0o777, 0o755);

  mkdirSync(join(PROJECT, "src", "deep"), { recursive: true });
  writeFileSync(join(PROJECT, "src", "a.txt"), "A");
  writeFileSync(join(PROJECT, "src", "deep", "b.txt"), "B");
  const dir = await tools.upload("box-a", { localPath: join(PROJECT, "src"), remotePath: join(BOX, "copy") }, { principal: agent() });
  assert.ok(dir.ok, dir.ok ? "" : dir.message);
  assert.equal(dir.value.kind, "directory");
  assert.ok(dir.value.bytes > 0);
  assert.equal(readFileSync(join(BOX, "copy", "a.txt"), "utf8"), "A");
  assert.equal(readFileSync(join(BOX, "copy", "deep", "b.txt"), "utf8"), "B");
});

test("files move only between the box and the calling chat's own project (after realpath)", async () => {
  const { tools } = world();
  writeFileSync(join(OTHER, "secret.txt"), "x");
  const outside = await tools.upload("box-a", { localPath: join(OTHER, "secret.txt"), remotePath: "s" }, { principal: agent() });
  assert.ok(!outside.ok && outside.code === "PERMISSION_DENIED");
  const climbing = await tools.upload("box-a", { localPath: join(PROJECT, "..", "other", "secret.txt"), remotePath: "s" }, { principal: agent() });
  assert.ok(!climbing.ok && climbing.code === "PERMISSION_DENIED");
  symlinkSync(join(OTHER, "secret.txt"), join(PROJECT, "link.txt"));
  const linked = await tools.upload("box-a", { localPath: join(PROJECT, "link.txt"), remotePath: "s" }, { principal: agent() });
  assert.ok(!linked.ok && linked.code === "PERMISSION_DENIED", "a symlink out of the project is refused");
  const download = await tools.download("box-a", { remotePath: "/etc/hostname", localPath: join(OTHER, "x") }, { principal: agent() });
  assert.ok(!download.ok && download.code === "PERMISSION_DENIED");
  const projectItself = await tools.download("box-a", { remotePath: BOX, localPath: PROJECT }, { principal: agent() });
  assert.ok(!projectItself.ok && projectItself.code === "INVALID_ARGUMENT");
  const noProject = await tools.upload("box-a", { localPath: "/etc/hostname", remotePath: "s" }, { principal: agent("chat-a", "") });
  assert.ok(!noProject.ok && noProject.code === "NO_PROJECT");
  const byUser = await tools.upload("box-a", { localPath: join(PROJECT, "run.sh"), remotePath: "s" }, { principal: USER });
  assert.ok(!byUser.ok && byUser.code === "PERMISSION_DENIED");
});

// A box project: its files live only on its box's disk (`DISK`); the host stub at its path is never
// created, so every byte moved proves it went through the project box's link.
const DISK = join(ROOT, "project-box-disk");

function boxProjectWorld(name: string): World & { project: string; projectBox: BoxDiskConnection; inBox(...segments: string[]): string } {
  const project = join(ROOT, "workspaces", "acme", name);
  const projectBox = boxDiskConnection({ disk: DISK, boxId: "box-project" });
  mkdirSync(projectBox.local(project), { recursive: true });
  return {
    ...world({ registry: fakeBoxRegistry({ projectPath: project, connection: projectBox }) }),
    project,
    projectBox,
    inBox: (...segments) => projectBox.local(join(project, ...segments))
  };
}

test("box project: upload relays a file and a directory's contents from the project box into the temporary box", async () => {
  const { tools, project, inBox } = boxProjectWorld("boxed-up");
  writeFileSync(inBox("run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  mkdirSync(inBox("src", "deep"), { recursive: true });
  writeFileSync(inBox("src", "a.txt"), "A");
  writeFileSync(inBox("src", "deep", "b.txt"), "B");
  const principal = agent("chat-a", project);

  const file = await tools.upload("box-a", { localPath: join(project, "run.sh"), remotePath: "boxed-in/run.sh" }, { principal });
  assert.ok(file.ok, file.ok ? "" : file.message);
  assert.deepEqual(file.value, { kind: "file", bytes: 18, localPath: join(project, "run.sh"), remotePath: join(BOX, "boxed-in", "run.sh") });
  assert.equal(readFileSync(join(BOX, "boxed-in", "run.sh"), "utf8"), "#!/bin/sh\necho hi\n");
  assert.equal(statSync(join(BOX, "boxed-in", "run.sh")).mode & 0o777, 0o755);

  const dir = await tools.upload("box-a", { localPath: join(project, "src"), remotePath: join(BOX, "boxed-copy") }, { principal });
  assert.ok(dir.ok, dir.ok ? "" : dir.message);
  assert.equal(dir.value.kind, "directory");
  assert.ok(dir.value.bytes > 0);
  // The directory's contents land in remote_path, as from a host project.
  assert.deepEqual(readdirSync(join(BOX, "boxed-copy")).sort(), ["a.txt", "deep"]);
  assert.equal(readFileSync(join(BOX, "boxed-copy", "deep", "b.txt"), "utf8"), "B");

  const missing = await tools.upload("box-a", { localPath: join(project, "nope"), remotePath: "x" }, { principal });
  assert.ok(!missing.ok && missing.code === "NOT_FOUND");
  assert.equal(existsSync(project), false, "nothing was read from the host stub");
});

test("box project: download writes a file and a directory into the project box, with the host's rules", async () => {
  const { tools, project, inBox } = boxProjectWorld("boxed-down");
  mkdirSync(join(BOX, "bp-out", "logs", "nested"), { recursive: true });
  writeFileSync(join(BOX, "bp-out", "app"), "BINARY", { mode: 0o755 });
  writeFileSync(join(BOX, "bp-out", "logs", "build.log"), "ok\n");
  writeFileSync(join(BOX, "bp-out", "logs", "nested", "n.txt"), "n");
  writeFileSync(inBox("app"), "old");
  const principal = agent("chat-a", project);

  const file = await tools.download("box-a", { remotePath: join(BOX, "bp-out", "app"), localPath: join(project, "app") }, { principal });
  assert.ok(file.ok, file.ok ? "" : file.message);
  assert.deepEqual(file.value, { kind: "file", bytes: 6, localPath: join(project, "app"), remotePath: join(BOX, "bp-out", "app") });
  assert.equal(readFileSync(inBox("app"), "utf8"), "BINARY");
  assert.equal(statSync(inBox("app")).mode & 0o111, 0o111);

  const dir = await tools.download("box-a", { remotePath: join(BOX, "bp-out", "logs"), localPath: join(project, "artifacts", "logs-copy") }, { principal });
  assert.ok(dir.ok, dir.ok ? "" : dir.message);
  assert.equal(dir.value.kind, "directory");
  assert.equal(readFileSync(inBox("artifacts", "logs-copy", "build.log"), "utf8"), "ok\n");
  assert.equal(readFileSync(inBox("artifacts", "logs-copy", "nested", "n.txt"), "utf8"), "n");

  const again = await tools.download("box-a", { remotePath: join(BOX, "bp-out", "logs"), localPath: join(project, "artifacts", "logs-copy") }, { principal });
  assert.ok(!again.ok && again.code === "ALREADY_EXISTS");
  const projectItself = await tools.download("box-a", { remotePath: join(BOX, "bp-out", "logs"), localPath: project }, { principal });
  assert.ok(!projectItself.ok && projectItself.code === "INVALID_ARGUMENT");
  assert.deepEqual(readdirSync(inBox("artifacts")), ["logs-copy"], "nothing half-written is left beside the target");
  assert.deepEqual(readdirSync(inBox()).sort(), ["app", "artifacts"]);
  assert.equal(existsSync(project), false, "nothing was written to the host stub");
});

test("box project: transfers stay inside the project after realpath in its box, and never write git metadata there", async () => {
  const { tools, project, inBox, projectBox } = boxProjectWorld("boxed-git");
  const outside = projectBox.local(join(ROOT, "workspaces", "acme", "boxed-other"));
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "x");
  symlinkSync("../boxed-other/secret.txt", inBox("leak.txt"));
  symlinkSync("../boxed-other", inBox("leak-dir"));
  const principal = agent("chat-a", project);
  for (const localPath of [join(project, "..", "boxed-other", "secret.txt"), join(project, "leak.txt")]) {
    const upload = await tools.upload("box-a", { localPath, remotePath: "s" }, { principal });
    assert.ok(!upload.ok && upload.code === "PERMISSION_DENIED", `upload ${localPath} is refused`);
  }
  mkdirSync(join(BOX, "bp-evil"), { recursive: true });
  writeFileSync(join(BOX, "bp-evil", "pre-commit"), "#!/bin/sh\ntouch /tmp/pwned\n", { mode: 0o755 });
  const escaped = await tools.download("box-a", { remotePath: join(BOX, "bp-evil", "pre-commit"), localPath: join(project, "leak-dir", "x") }, { principal });
  assert.ok(!escaped.ok && escaped.code === "PERMISSION_DENIED", "a download through a symlink out of the project is refused");
  assert.deepEqual(readdirSync(outside), ["secret.txt"]);

  // A repo, a bare repository and a link into a .git, all in the project box.
  mkdirSync(inBox("repo", ".git", "hooks"), { recursive: true });
  mkdirSync(inBox("repo", ".git", "objects"));
  mkdirSync(inBox("repo", ".git", "refs"));
  writeFileSync(inBox("repo", ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(inBox("mirror.git", "objects"), { recursive: true });
  mkdirSync(inBox("mirror.git", "refs"));
  writeFileSync(inBox("mirror.git", "HEAD"), "ref: refs/heads/main\n");
  symlinkSync("repo/.git", inBox("meta-link"));
  // Git follows symlinked objects/refs: still a git directory.
  mkdirSync(inBox("linked.git", "o"), { recursive: true });
  mkdirSync(inBox("linked.git", "r"));
  writeFileSync(inBox("linked.git", "HEAD"), "ref: refs/heads/main\n");
  symlinkSync("o", inBox("linked.git", "objects"));
  symlinkSync("r", inBox("linked.git", "refs"));
  for (const localPath of [
    join(project, "repo", ".GIT", "hooks", "pre-commit"),
    join(project, "meta-link", "hooks", "pre-commit"),
    join(project, "mirror.git", "hooks", "post-update"),
    join(project, "linked.git", "config")
  ]) {
    const result = await tools.download("box-a", { remotePath: join(BOX, "bp-evil", "pre-commit"), localPath }, { principal });
    assert.ok(!result.ok && result.code === "PERMISSION_DENIED", `${localPath} is refused`);
  }
  assert.deepEqual(readdirSync(inBox("repo", ".git", "hooks")), []);
  assert.equal(existsSync(inBox("mirror.git", "hooks")), false);

  // A directory that carries a .git, or is itself a git directory.
  mkdirSync(join(BOX, "bp-nested", "pkg", ".git"), { recursive: true });
  writeFileSync(join(BOX, "bp-nested", "pkg", ".git", "config"), "[core]\n\tfsmonitor = /tmp/x\n");
  mkdirSync(join(BOX, "bp-bare", "objects"), { recursive: true });
  mkdirSync(join(BOX, "bp-bare", "refs"));
  writeFileSync(join(BOX, "bp-bare", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(BOX, "bp-linked", "o"), { recursive: true });
  mkdirSync(join(BOX, "bp-linked", "r"));
  writeFileSync(join(BOX, "bp-linked", "HEAD"), "ref: refs/heads/main\n");
  symlinkSync("o", join(BOX, "bp-linked", "objects"));
  symlinkSync("r", join(BOX, "bp-linked", "refs"));
  mkdirSync(inBox("downloads"));
  for (const remote of ["bp-nested", "bp-bare", "bp-linked"]) {
    const result = await tools.download("box-a", { remotePath: join(BOX, remote), localPath: join(project, "downloads", remote) }, { principal });
    assert.ok(!result.ok && result.code === "PERMISSION_DENIED", `${remote} is refused`);
  }
  assert.deepEqual(readdirSync(inBox("downloads")), [], "nothing was moved in, no staging left");
  assert.equal(existsSync(inBox("linked.git", "config")), false);
});

test("box project: download staging the project box could not remove is retried on its reconnect and next transfer, named in a refusal, and forgotten with that box", async () => {
  const { tools, boxes, project, inBox, projectBox, connection } = boxProjectWorld("boxed-leftover");
  boxes.add(boxSummary({ id: "box-project", purpose: "project", threadId: null }));
  const principal = agent("chat-a", project);
  mkdirSync(join(BOX, "bp-left", "sub"), { recursive: true });
  writeFileSync(join(BOX, "bp-left", "sub", "f"), "f");
  mkdirSync(join(BOX, "bp-left-git", "pkg", ".git"), { recursive: true });
  writeFileSync(join(BOX, "bp-left-git", "pkg", ".git", "config"), "[core]\n\tfsmonitor = /tmp/x\n");
  const removals: Promise<unknown>[] = [];
  let busy = false;
  const request = projectBox.request;
  projectBox.request = ((method: string, params: never, options?: never) => {
    if (method !== "fs.rm") return request(method as "fs.rm", params, options);
    // A busy or locked file (Windows): the box stays connected but refuses the removal.
    const removal = busy ? Promise.reject(Object.assign(new Error("Device or resource busy"), { code: "EBUSY" })) : request(method, params, options);
    removals.push(removal.catch(() => undefined));
    return removal;
  }) as typeof projectBox.request;

  // The project box's link drops mid-download: its staging cannot be removed then.
  const readTar = connection.readTar;
  connection.readTar = async () =>
    Readable.from((async function* () {
      projectBox.setConnected(false);
      yield* [];
      throw new Error("the link dropped");
    })());
  const dropped = await tools.download("box-a", { remotePath: join(BOX, "bp-left"), localPath: join(project, "drop", "copy") }, { principal });
  assert.ok(!dropped.ok && dropped.code === "BOX_NOT_READY", dropped.ok ? "" : dropped.message);
  assert.deepEqual(readdirSync(inBox("drop")), [".orq-download-id1"]);
  projectBox.setConnected(true);
  assert.equal(removals.length, 1, "the reconnect removes it");
  await Promise.all(removals);
  assert.deepEqual(readdirSync(inBox("drop")), []);

  // The box refuses to remove a refused download's unscanned tree: the refusal says where it is,
  // and the next transfer into that project box removes it.
  connection.readTar = readTar;
  busy = true;
  const refused = await tools.download("box-a", { remotePath: join(BOX, "bp-left-git"), localPath: join(project, "refused", "copy") }, { principal });
  assert.ok(!refused.ok && refused.code === "PERMISSION_DENIED", refused.ok ? "" : refused.message);
  assert.ok(refused.message.includes(join(project, "refused", ".orq-download-id2")), refused.message);
  assert.deepEqual(readdirSync(inBox("refused")), [".orq-download-id2"]);
  busy = false;
  writeFileSync(inBox("a.txt"), "a");
  const next = await tools.upload("box-a", { localPath: join(project, "a.txt"), remotePath: "a.txt" }, { principal });
  assert.ok(next.ok, next.ok ? "" : next.message);
  assert.deepEqual(readdirSync(inBox("refused")), []);

  // Once the project box is destroyed, nothing is retried in it.
  busy = true;
  const gone = await tools.download("box-a", { remotePath: join(BOX, "bp-left-git"), localPath: join(project, "gone", "copy") }, { principal });
  assert.ok(!gone.ok && gone.code === "PERMISSION_DENIED");
  busy = false;
  const sent = removals.length;
  boxes.update("box-project", { state: "destroyed" });
  projectBox.setConnected(false);
  projectBox.setConnected(true);
  assert.equal(removals.length, sent, "no removal is sent to a destroyed project box");
});

test("box project on macOS: a directory upload's tar runs with COPYFILE_DISABLE (no AppleDouble ._ entries)", async () => {
  const { tools, project, inBox, projectBox } = boxProjectWorld("boxed-mac");
  Object.defineProperty(projectBox, "sys", { value: { ...projectBox.sys, os: "darwin" } });
  mkdirSync(inBox("src"));
  writeFileSync(inBox("src", "a.txt"), "A");
  const envs: (Record<string, string> | undefined)[] = [];
  const exec = projectBox.exec;
  projectBox.exec = (options) => {
    envs.push(options.env);
    return exec(options);
  };
  const dir = await tools.upload("box-a", { localPath: join(project, "src"), remotePath: join(BOX, "mac-copy") }, { principal: agent("chat-a", project) });
  assert.ok(dir.ok, dir.ok ? "" : dir.message);
  assert.deepEqual(envs.map((env) => env?.COPYFILE_DISABLE), ["1"]);
});

test("box project: a project box that is not connected is a BOX_NOT_READY refusal about the project's box", async () => {
  const { tools, project, projectBox } = boxProjectWorld("boxed-offline");
  projectBox.setConnected(false);
  const principal = agent("chat-a", project);
  const upload = await tools.upload("box-a", { localPath: join(project, "a.txt"), remotePath: "a.txt" }, { principal });
  const download = await tools.download("box-a", { remotePath: join(BOX, "a.txt"), localPath: join(project, "a.txt") }, { principal });
  for (const result of [upload, download]) {
    assert.ok(!result.ok && result.code === "BOX_NOT_READY", result.ok ? "" : result.message);
    assert.match(result.message, /box-project/);
  }
});

test("download: a file replaces a file atomically (exec bit kept); a directory lands at local_path; an existing directory is refused", async () => {
  const { tools } = world();
  mkdirSync(join(BOX, "out", "logs", "nested"), { recursive: true });
  writeFileSync(join(BOX, "out", "app"), "BINARY", { mode: 0o755 });
  writeFileSync(join(BOX, "out", "logs", "build.log"), "ok\n");
  writeFileSync(join(BOX, "out", "logs", "nested", "n.txt"), "n");

  writeFileSync(join(PROJECT, "app"), "old");
  const file = await tools.download("box-a", { remotePath: join(BOX, "out", "app"), localPath: join(PROJECT, "app") }, { principal: agent() });
  assert.ok(file.ok, file.ok ? "" : file.message);
  assert.deepEqual(file.value, { kind: "file", bytes: 6, localPath: join(PROJECT, "app"), remotePath: join(BOX, "out", "app") });
  assert.equal(readFileSync(join(PROJECT, "app"), "utf8"), "BINARY");
  assert.equal(statSync(join(PROJECT, "app")).mode & 0o111, 0o111);

  const dir = await tools.download("box-a", { remotePath: join(BOX, "out", "logs"), localPath: join(PROJECT, "artifacts", "logs-copy") }, { principal: agent() });
  assert.ok(dir.ok, dir.ok ? "" : dir.message);
  assert.equal(dir.value.kind, "directory");
  assert.equal(readFileSync(join(PROJECT, "artifacts", "logs-copy", "build.log"), "utf8"), "ok\n");
  assert.equal(readFileSync(join(PROJECT, "artifacts", "logs-copy", "nested", "n.txt"), "utf8"), "n");

  const again = await tools.download("box-a", { remotePath: join(BOX, "out", "logs"), localPath: join(PROJECT, "artifacts", "logs-copy") }, { principal: agent() });
  assert.ok(!again.ok && again.code === "ALREADY_EXISTS");
  const missing = await tools.download("box-a", { remotePath: join(BOX, "nope"), localPath: join(PROJECT, "nope") }, { principal: agent() });
  assert.ok(!missing.ok && missing.code === "NOT_FOUND");
  // Nothing half-written is left beside the targets.
  assert.deepEqual(readdirSync(join(PROJECT, "artifacts")), ["logs-copy"]);
});

test("download: a file is read with a length (the stat's size), never until the box stops sending", async () => {
  const { tools, connection } = world();
  mkdirSync(join(BOX, "out"), { recursive: true });
  writeFileSync(join(BOX, "out", "sized.bin"), "0123456789");
  const reads: { offset?: number; length?: number }[] = [];
  const readFile = connection.readFile.bind(connection);
  connection.readFile = (path, options) => {
    reads.push({ ...(options?.offset !== undefined ? { offset: options.offset } : {}), ...(options?.length !== undefined ? { length: options.length } : {}) });
    return readFile(path, options);
  };
  const file = await tools.download("box-a", { remotePath: join(BOX, "out", "sized.bin"), localPath: join(PROJECT, "sized.bin") }, { principal: agent() });
  assert.ok(file.ok, file.ok ? "" : file.message);
  assert.deepEqual(reads, [{ length: 10 }]);
  assert.equal(readFileSync(join(PROJECT, "sized.bin"), "utf8"), "0123456789");
});

test("download: tar can close its input before the box finishes; the entire source still decides success", async (t) => {
  const lookup = spawnSync("/bin/sh", ["-c", "command -v tar"], { encoding: "utf8" });
  assert.equal(lookup.status, 0, lookup.stderr);
  const realTar = realpathSync(lookup.stdout.trim());
  const remote = join(BOX, "early-tar");
  mkdirSync(remote);
  writeFileSync(join(remote, "payload.txt"), "payload");
  const packed = spawnSync(realTar, ["-cf", "-", "-C", remote, "."]);
  assert.equal(packed.status, 0, packed.stderr.toString());

  for (const scenario of ["success", "source-error", "cancel", "too-large", "tar-error"] as const) {
    await t.test(scenario, async (t) => {
      const bin = mkdtempSync(join(ROOT, `early-tar-${scenario}-`));
      const tar = join(bin, "tar");
      const receipt = join(ROOT, `early-tar-${scenario}.closed`);
      // Real tar reads the archive's end markers, then the wrapper closes fd 0 BEFORE the
      // source releases its tail. The watched receipt makes the ordering deterministic.
      writeFileSync(tar, `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { closeSync, writeFileSync } = require("node:fs");
const child = spawnSync(${JSON.stringify(realTar)}, process.argv.slice(2), { stdio: ["inherit", "ignore", "inherit"] });
closeSync(0);
writeFileSync(${JSON.stringify(receipt)}, "closed");
process.exit(child.status ?? 1);
`, { mode: 0o755 });
      let closed!: () => void;
      const inputClosed = new Promise<void>((resolve) => { closed = resolve; });
      const watcher = watch(ROOT, (_event, name) => {
        if (name?.toString() === basename(receipt)) closed();
      });
      t.after(() => { closed(); watcher.close(); });
      const previousPath = process.env.PATH;
      t.after(() => {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      });
      process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
      const controller = new AbortController();
      const { tools, connection } = world();
      const padding = Buffer.alloc(1024);
      const invalidArchive = Buffer.alloc(10240);
      invalidArchive.fill(1, 0, 512);
      connection.readTar = async () => Readable.from((async function* () {
        yield scenario === "tar-error" ? invalidArchive : packed.stdout;
        await inputClosed;
        if (scenario === "source-error") throw new Error("the box failed after the archive");
        if (scenario === "cancel") controller.abort();
        if (scenario === "too-large") {
          // Reuse one chunk: exercise the byte cap after tar exits without allocating 4 GiB.
          const chunk = Buffer.alloc(1024 * 1024);
          for (let bytes = 0; bytes <= 4 * 1024 ** 3; bytes += chunk.length) yield chunk;
        } else {
          yield padding;
        }
      })());
      const target = join(PROJECT, `early-tar-${scenario}`);
      const result = await tools.download("box-a", { remotePath: remote, localPath: target }, { principal: agent(), signal: controller.signal });
      if (scenario === "success") {
        assert.ok(result.ok, result.ok ? "" : result.message);
        assert.equal(result.value.bytes, packed.stdout.length + padding.length);
        assert.equal(readFileSync(join(target, "payload.txt"), "utf8"), "payload");
      } else {
        assert.ok(!result.ok);
        const code = scenario === "cancel" ? "CANCELLED" : scenario === "too-large" ? "TOO_LARGE" : "BOX_TRANSFER_FAILED";
        assert.equal(result.code, code, result.message);
        if (scenario === "source-error") assert.match(result.message, /the box failed after the archive/);
        if (scenario === "tar-error") assert.match(result.message, /tar could not unpack the directory/);
        assert.throws(() => statSync(target), { code: "ENOENT" });
      }
      assert.deepEqual(readdirSync(PROJECT).filter((name) => name.startsWith(".orq-download-")), []);
    });
  }
});

test("download: a directory whose only entry has its own name keeps its shape", async () => {
  const { tools } = world();
  mkdirSync(join(BOX, "same", "same"), { recursive: true });
  writeFileSync(join(BOX, "same", "same", "f"), "f");
  const dir = await tools.download("box-a", { remotePath: join(BOX, "same"), localPath: join(PROJECT, "same-copy") }, { principal: agent() });
  assert.ok(dir.ok, dir.ok ? "" : dir.message);
  assert.equal(readFileSync(join(PROJECT, "same-copy", "same", "f"), "utf8"), "f");
});

test("download: never into git metadata — a .git path (any spelling), through a symlink, inside a git directory, or a directory carrying one", async () => {
  const { tools } = world();
  const repo = join(PROJECT, "repo");
  mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(repo, ".git", "objects"), { recursive: true });
  mkdirSync(join(repo, ".git", "refs"), { recursive: true });
  writeFileSync(join(repo, ".git", "config"), "[core]\n");
  // A bare repository elsewhere in the project, and a link that leads into a .git.
  mkdirSync(join(PROJECT, "mirror.git", "objects"), { recursive: true });
  mkdirSync(join(PROJECT, "mirror.git", "refs"), { recursive: true });
  writeFileSync(join(PROJECT, "mirror.git", "HEAD"), "ref: refs/heads/main\n");
  symlinkSync(join(repo, ".git"), join(PROJECT, "meta-link"));
  // Git follows symlinked objects/refs: still a git directory.
  mkdirSync(join(PROJECT, "linked.git", "o"), { recursive: true });
  mkdirSync(join(PROJECT, "linked.git", "r"));
  writeFileSync(join(PROJECT, "linked.git", "HEAD"), "ref: refs/heads/main\n");
  symlinkSync("o", join(PROJECT, "linked.git", "objects"));
  symlinkSync("r", join(PROJECT, "linked.git", "refs"));
  mkdirSync(join(BOX, "evil"), { recursive: true });
  writeFileSync(join(BOX, "evil", "pre-commit"), "#!/bin/sh\ntouch /tmp/pwned\n", { mode: 0o755 });
  writeFileSync(join(BOX, "evil", "config"), "[core]\n\tfsmonitor = /tmp/x\n");

  for (const localPath of [
    join(repo, ".git", "config"),
    join(repo, ".git", "hooks", "pre-commit"),
    join(repo, ".GIT", "hooks", "post-checkout"),
    join(repo, ".git. ", "config"),
    join(repo, ".git"),
    "repo/.git/hooks/pre-push",
    join(PROJECT, "meta-link", "hooks", "pre-commit"),
    join(PROJECT, "mirror.git", "config"),
    join(PROJECT, "mirror.git", "hooks", "post-update"),
    join(PROJECT, "linked.git", "config")
  ]) {
    const result = await tools.download("box-a", { remotePath: join(BOX, "evil", "pre-commit"), localPath: localPath.startsWith("/") ? localPath : join(PROJECT, localPath) }, { principal: agent() });
    assert.ok(!result.ok && result.code === "PERMISSION_DENIED", `${localPath} is refused`);
  }
  assert.equal(readFileSync(join(repo, ".git", "config"), "utf8"), "[core]\n", "nothing was written");
  assert.deepEqual(readdirSync(join(repo, ".git", "hooks")), []);

  // A directory download that carries a .git (a nested repo), or is itself a git directory.
  mkdirSync(join(BOX, "nested", "pkg", ".git", "hooks"), { recursive: true });
  writeFileSync(join(BOX, "nested", "pkg", ".git", "config"), "[core]\n\tfsmonitor = /tmp/x\n");
  writeFileSync(join(BOX, "nested", "pkg", "index.js"), "1");
  mkdirSync(join(BOX, "bare", "objects"), { recursive: true });
  mkdirSync(join(BOX, "bare", "refs"), { recursive: true });
  writeFileSync(join(BOX, "bare", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(BOX, "linked", "o"), { recursive: true });
  mkdirSync(join(BOX, "linked", "r"));
  writeFileSync(join(BOX, "linked", "HEAD"), "ref: refs/heads/main\n");
  symlinkSync("o", join(BOX, "linked", "objects"));
  symlinkSync("r", join(BOX, "linked", "refs"));
  for (const remote of ["nested", "bare", "linked"]) {
    const result = await tools.download("box-a", { remotePath: join(BOX, remote), localPath: join(PROJECT, "downloads", remote) }, { principal: agent() });
    assert.ok(!result.ok && result.code === "PERMISSION_DENIED", `${remote} is refused`);
  }
  assert.deepEqual(readdirSync(join(PROJECT, "downloads")), [], "nothing was moved in, no staging left");

  // Ordinary files next to a repo still download.
  const ok = await tools.download("box-a", { remotePath: join(BOX, "evil", "config"), localPath: join(repo, "config.example") }, { principal: agent() });
  assert.ok(ok.ok, ok.ok ? "" : ok.message);
});

test("download: a git directory is never built piece by piece — HEAD, commondir, objects and refs count as written, partial layouts are refused (host and box project)", async () => {
  const { tools, project, inBox } = boxProjectWorld("boxed-pieces");
  const pieces = join(BOX, "pieces");
  mkdirSync(join(pieces, "empty"), { recursive: true });
  writeFileSync(join(pieces, "config"), "[core]\n\tfsmonitor = /tmp/x\n");
  writeFileSync(join(pieces, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(pieces, "commondir"), "../bar\n");
  // Trees with a partial layout below their top, and one with a mere file named HEAD.
  for (const [tree, name, text] of [
    ["lone-head", "HEAD", "0123456789abcdef0123456789abcdef01234567\n"],
    ["lone-commondir", "commondir", "../../bar\n"],
    ["notes", "HEAD", "What is on top of the stack.\n"]
  ] as const) {
    mkdirSync(join(pieces, tree, "sub"), { recursive: true });
    writeFileSync(join(pieces, tree, "sub", name), text);
  }
  for (const [root, principal, local] of [
    [join(PROJECT, "pieces"), agent(), (...segments: string[]) => join(PROJECT, "pieces", ...segments)],
    [join(project, "pieces"), agent("chat-a", project), (...segments: string[]) => inBox("pieces", ...segments)]
  ] as const) {
    const download = async (remote: string, localPath: string, written: boolean): Promise<void> => {
      const result = await tools.download("box-a", { remotePath: join(pieces, remote), localPath: join(root, localPath) }, { principal });
      if (written) assert.ok(result.ok, result.ok ? "" : `${localPath}: ${result.message}`);
      else assert.ok(!result.ok && result.code === "PERMISSION_DENIED", `${localPath} is refused`);
    };
    // Config and objects for a directory a commondir could name, but not the refs completing it.
    await download("config", "bar/config", true);
    await download("empty", "bar/objects", true);
    await download("empty", "bar/refs", false);
    // A HEAD or a commondir (any spelling) is never written: either starts a git directory.
    await download("HEAD", "foo/HEAD", false);
    await download("commondir", "foo/CommonDir.", false);
    await download("lone-head", "tree-head", false);
    await download("lone-commondir", "tree-commondir", false);
    await download("notes", "tree-notes", true);
    // A mere file named HEAD blocks nothing beside it; a HEAD git reads as one does.
    mkdirSync(local("notes"));
    writeFileSync(local("notes", "HEAD"), "What is on top of the stack.\n");
    await download("config", "notes/config.txt", true);
    mkdirSync(local("half"));
    writeFileSync(local("half", "HEAD"), "ref: refs/heads/main\n");
    await download("config", "half/config", false);
    assert.deepEqual(readdirSync(local()).sort(), ["bar", "half", "notes", "tree-notes"]);
    assert.deepEqual(readdirSync(local("bar")).sort(), ["config", "objects"]);
    assert.deepEqual(readdirSync(local("half")), ["HEAD"]);
  }
});

test("download: a remote_path that is a symlink to a directory is refused, nothing followed or installed (host and box project)", async () => {
  const { tools, project, inBox, projectBox } = boxProjectWorld("boxed-dir-link");
  mkdirSync(join(BOX, "real-dir"), { recursive: true });
  writeFileSync(join(BOX, "real-dir", "f"), "f");
  symlinkSync(join(BOX, "real-dir"), join(BOX, "dir-link"));
  // The link's target exists in the project box too, so it could be walked and installed there.
  mkdirSync(projectBox.local(join(BOX, "real-dir")), { recursive: true });
  for (const [localPath, principal, local] of [
    [join(PROJECT, "dir-link-copy"), agent(), join(PROJECT, "dir-link-copy")],
    [join(project, "dir-link-copy"), agent("chat-a", project), inBox("dir-link-copy")]
  ] as const) {
    const result = await tools.download("box-a", { remotePath: join(BOX, "dir-link"), localPath }, { principal });
    assert.ok(!result.ok && result.code === "INVALID_ARGUMENT", result.ok ? `${localPath} was written` : result.message);
    assert.throws(() => lstatSync(local), { code: "ENOENT" });
  }
  assert.deepEqual(readdirSync(PROJECT).filter((name) => name.startsWith(".orq-download-")), []);
  assert.deepEqual(readdirSync(inBox()), []);
});

test("download: a directory in place succeeds even when its emptied staging directory cannot be removed", async (t) => {
  const { tools } = world();
  mkdirSync(join(BOX, "kept", "sub"), { recursive: true });
  writeFileSync(join(BOX, "kept", "sub", "f"), "f");
  const rm = fsPromises.rm;
  t.mock.method(fsPromises, "rm", async (path: string, options?: Parameters<typeof rm>[1]) => {
    if (basename(String(path)).startsWith(".orq-download-")) throw Object.assign(new Error("Device or resource busy"), { code: "EBUSY" });
    return rm(path, options);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const result = await tools.download("box-a", { remotePath: join(BOX, "kept"), localPath: join(PROJECT, "kept-dir", "copy") }, { principal: agent() });
  assert.ok(result.ok, result.ok ? "" : result.message);
  assert.equal(readFileSync(join(PROJECT, "kept-dir", "copy", "sub", "f"), "utf8"), "f");
});

// ---------------------------------------------------------------------------
// Port forwards
// ---------------------------------------------------------------------------

test("forwards: a host loopback URL to the box port, reused for the same port, closed when the box is destroyed", async (t) => {
  const { tools, connection } = world();
  const forwardToHost = connection.forwardToHost.bind(connection);
  connection.forwardToHost = async (port, options) => {
    const relay = await forwardToHost(port, options);
    t.after(() => relay.close());
    return relay;
  };
  const server = createServer((socket) => socket.end("hello from the box"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const boxPort = (server.address() as AddressInfo).port;
  const forward = await tools.forwardPort("box-a", boxPort, { principal: agent() });
  assert.ok(forward.ok, forward.ok ? "" : forward.message);
  assert.equal(forward.value.url, `http://127.0.0.1:${forward.value.hostPort}/`);
  assert.equal(forward.value.boxPort, boxPort);
  const read = (port: number) =>
    new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1");
      let text = "";
      socket.on("data", (chunk) => (text += chunk.toString()));
      socket.on("end", () => resolve(text));
      socket.on("error", reject);
    });
  assert.equal(await read(forward.value.hostPort!), "hello from the box");
  const same = await tools.forwardPort("box-a", boxPort, { principal: agent() });
  assert.ok(same.ok && same.value.hostPort === forward.value.hostPort);
  await tools.destroy(agent(), "box-a");
  await assert.rejects(read(forward.value.hostPort!), /ECONNREFUSED/);
});

test("forwards: a box destroyed while its host forward opens gets no URL, and the host port is closed", async (t) => {
  const { tools, connection } = world();
  let opened!: (hostPort: number) => void;
  const relayed = new Promise<number>((resolve) => (opened = resolve));
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => (answer = resolve));
  const forwardToHost = connection.forwardToHost.bind(connection);
  connection.forwardToHost = async (port, options) => {
    const relay = await forwardToHost(port, options);
    t.after(() => relay.close());
    opened(relay.hostPort);
    await answered;
    return relay;
  };
  const forwarding = tools.forwardPort("box-a", 4321, { principal: agent() });
  const hostPort = await relayed;
  const destroyed = tools.destroy(agent(), "box-a");
  answer();
  const [forward] = await Promise.all([forwarding, destroyed]);
  assert.ok(!forward.ok && forward.code === "BOX_NOT_READY", "no URL for a destroyed box");
  await assert.rejects(fetchPort(hostPort), /ECONNREFUSED/);
});

/** A chat whose project (PROJECT) runs in its own box `box-p`, played on this machine by a {@link FakeForwardingHub}. */
function forwardingProjectWorld(
  t: TestContext,
  browserRunsInBox: boolean
): World & {
  hub: FakeForwardingHub;
  projectBox: LocalBoxConnection;
  setProjectBoxState: (state: StoredBox["state"]) => void;
  changeProjectBox: (change: Partial<StoredBox>) => void;
} {
  const w = world({ connect: false });
  const projectBox = localBoxConnection({ boxId: "box-p" });
  const hub = new FakeForwardingHub("box-p", projectBox);
  const record = { id: "box-p", purpose: "project", state: "ready", project: GAME } as StoredBox;
  const registryListeners = new Set<(boxId: string) => void>();
  const owner = new ProjectBoxForwards({
    hub,
    registry: {
      get: (boxId) => (boxId === "box-p" ? record : undefined),
      onChange: (listener) => {
        registryListeners.add(listener);
        return () => registryListeners.delete(listener);
      }
    }
  });
  w.tools.connect({
    boxes: w.boxes,
    hub: { get: (boxId) => (boxId === "box-a" ? w.connection : undefined) },
    // As the registry's index: a project path maps to the box only while its record is that project's box.
    registry: {
      locate: (path) =>
        path === PROJECT && record.purpose === "project" && record.project?.path === PROJECT ? { kind: "box", boxId: "box-p", record, connection: projectBox } : { kind: "host" }
    },
    projectForwards: owner,
    browserRunsInBox: () => browserRunsInBox
  });
  t.after(async () => {
    await w.tools.shutdown();
    hub.close();
  });
  const changeProjectBox = (change: Partial<StoredBox>): void => {
    Object.assign(record, change);
    for (const listener of [...registryListeners]) listener("box-p");
  };
  return { ...w, hub, projectBox, setProjectBoxState: (state) => changeProjectBox({ state }), changeProjectBox };
}

const GAME = { workspace: "acme", name: "game", path: PROJECT };

/** A dev server in the temporary box (this machine): answers `text` and ends. */
async function devServer(t: TestContext, text: string): Promise<number> {
  const server = createServer((socket) => socket.end(text));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return (server.address() as AddressInfo).port;
}

/** Everything a socket receives until it closes. */
function received(socket: Socket): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    socket.on("data", (chunk) => (text += chunk.toString()));
    socket.on("error", () => undefined);
    socket.once("close", () => resolve(text));
  });
}

/** What a client on this machine's `port` receives; rejects when nothing listens there. */
function fetchPort(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("error", reject);
    socket.once("connect", () => resolve(received(socket)));
  });
}

test("forwards in a box project: url listens in the project's box and pipes to the box port; browser_url on the host for a host Browser tab; closed with the box", async (t) => {
  const { tools, hub } = forwardingProjectWorld(t, false);
  const boxPort = await devServer(t, "hello from the box");
  const forward = await tools.forwardPort("box-a", boxPort, { principal: agent() });
  assert.ok(forward.ok, forward.ok ? "" : forward.message);
  const { url, browserUrl, projectBoxPort, hostPort } = forward.value;
  assert.equal(url, `http://127.0.0.1:${projectBoxPort}/`);
  assert.deepEqual(hub.ports(), [projectBoxPort], "the project box listens on that port");
  assert.equal(await fetchPort(projectBoxPort!), "hello from the box", "project box → daemon → box port");
  assert.equal(browserUrl, `http://127.0.0.1:${hostPort}/`);
  assert.equal(await fetchPort(hostPort!), "hello from the box", "the host Browser tab's URL");
  const same = await tools.forwardPort("box-a", boxPort, { principal: agent() });
  assert.ok(same.ok);
  assert.deepEqual(same.value, forward.value, "the same forward again");

  await tools.destroy(agent(), "box-a");
  assert.deepEqual(hub.lists.at(-1), [], "the project box's list no longer has it");
  await assert.rejects(fetchPort(projectBoxPort!), /ECONNREFUSED/);
  await assert.rejects(fetchPort(hostPort!), /ECONNREFUSED/);
});

test("forwards in a box project whose Browser tab runs in its box: one URL, no host port; refused while the project box is away", async (t) => {
  const { tools, hub, projectBox } = forwardingProjectWorld(t, true);
  const boxPort = await devServer(t, "hello from the box");
  projectBox.setConnected(false);
  const away = await tools.forwardPort("box-a", boxPort, { principal: agent() });
  assert.ok(!away.ok && away.code === "BOX_NOT_READY", "no URL the chat could not open");
  assert.deepEqual(hub.ports(), []);

  projectBox.setConnected(true);
  const forward = await tools.forwardPort("box-a", boxPort, { principal: agent() });
  assert.ok(forward.ok, forward.ok ? "" : forward.message);
  assert.equal(forward.value.browserUrl, undefined);
  assert.equal(forward.value.hostPort, undefined);
  assert.equal(await fetchPort(forward.value.projectBoxPort!), "hello from the box");
});

test("forwards in a box project: a host-tcp channel is served only for its own project box and a live target", async (t) => {
  const { tools, hub } = forwardingProjectWorld(t, true);
  const boxPort = await devServer(t, "private page");
  const forward = await tools.forwardPort("box-a", boxPort, { principal: agent() });
  assert.ok(forward.ok, forward.ok ? "" : forward.message);
  const [spec] = hub.lists.at(-1)!;
  assert.equal(await received(await hub.openAs("box-p", spec!)), "private page");
  assert.equal(await received(await hub.openAs("box-other", spec!)), "", "another box naming the target is closed");
  assert.equal(await received(await hub.openAs("box-p", { ...spec!, target: "fwd-guessed" })), "", "an unknown target is closed");
  assert.equal(await received(await hub.openAs("box-p", { ...spec!, boxPort: spec!.boxPort + 1 })), "", "the target from another port is closed");
});

test("forwards in a box project: a project box port is never a privileged one; a preferred port the box refuses for any reason falls back", async (t) => {
  const { tools, hub } = forwardingProjectWorld(t, true);
  const privileged = await tools.forwardPort("box-a", 80, { principal: agent() });
  assert.ok(privileged.ok, privileged.ok ? "" : privileged.message);
  assert.ok(
    hub.lists.every((list) => list.every((spec) => spec.boxPort >= 1024)),
    "port 80 was never listened on in the project box"
  );

  const boxPort = await devServer(t, "hello from the box");
  // A Windows project box answers a reserved port (Hyper-V exclusions) with INTERNAL, not EACCES.
  hub.refusing.set(boxPort, "INTERNAL");
  const forward = await tools.forwardPort("box-a", boxPort, { principal: agent() });
  assert.ok(forward.ok, forward.ok ? "" : forward.message);
  assert.notEqual(forward.value.projectBoxPort, boxPort);
  assert.equal(await fetchPort(forward.value.projectBoxPort!), "hello from the box");
});

test("forwards in a box project: a box destroyed while its forward is made gets no URL, and nothing is left listening for it", async (t) => {
  const { tools, hub, projectBox } = forwardingProjectWorld(t, true);
  // The project box answers the forward's port survey only when the test says so.
  let surveyed!: () => void;
  const asked = new Promise<void>((resolve) => (surveyed = resolve));
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => (answer = resolve));
  let surveys = 0;
  const request = projectBox.request.bind(projectBox);
  projectBox.request = (async (method: string, params: never, options?: object) => {
    if (method === "sys.ports") {
      surveys += 1;
      surveyed();
      await answered;
    }
    return request(method as never, params, options);
  }) as typeof projectBox.request;
  const boxPort = await devServer(t, "hello from the box");
  const first = tools.forwardPort("box-a", boxPort, { principal: agent() });
  const second = tools.forwardPort("box-a", boxPort, { principal: agent() });
  await asked;
  const destroyed = tools.destroy(agent(), "box-a");
  answer();
  const [one, two] = await Promise.all([first, second, destroyed]);
  assert.ok(!one.ok && one.code === "BOX_NOT_READY", "no URL for a destroyed box");
  assert.ok(!two.ok && two.code === "BOX_NOT_READY", "nor for a call that waited on the first");
  assert.deepEqual(hub.ports(), [], "nothing listens in the project box for it");
  assert.equal(surveys, 1, "only the first call made a forward in the project box");
});

test("forwards in a box project: after a reconnect, one the project box could not listen on again is made anew; the others are kept", async (t) => {
  const { tools, hub } = forwardingProjectWorld(t, true);
  const lostPort = await devServer(t, "hello from the box");
  const keptPort = await devServer(t, "the other page");
  const lost = await tools.forwardPort("box-a", lostPort, { principal: agent() });
  const kept = await tools.forwardPort("box-a", keptPort, { principal: agent() });
  assert.ok(lost.ok && kept.ok);
  hub.drop();
  // Another process takes the port while the project box is away: its welcome's listen fails unseen.
  const squatter = createServer((socket) => socket.end("someone else"));
  await new Promise<void>((resolve) => squatter.listen(lost.value.projectBoxPort!, "127.0.0.1", resolve));
  t.after(() => squatter.close());
  await hub.welcome();

  const again = await tools.forwardPort("box-a", lostPort, { principal: agent() });
  assert.ok(again.ok, again.ok ? "" : again.message);
  assert.notEqual(again.value.projectBoxPort, lost.value.projectBoxPort);
  assert.equal(await fetchPort(again.value.projectBoxPort!), "hello from the box", "not the other process");
  const same = await tools.forwardPort("box-a", keptPort, { principal: agent() });
  assert.ok(same.ok);
  assert.equal(same.value.projectBoxPort, kept.value.projectBoxPort);
  assert.equal(await fetchPort(same.value.projectBoxPort!), "the other page");
});

test("forwards in a box project: a destroyed project box's forwards are dropped; a later call listens anew", async (t) => {
  const { tools, hub, setProjectBoxState } = forwardingProjectWorld(t, true);
  const boxPort = await devServer(t, "hello from the box");
  const first = await tools.forwardPort("box-a", boxPort, { principal: agent() });
  assert.ok(first.ok);
  const [old] = hub.lists.at(-1)!;
  setProjectBoxState("destroyed");
  // Its listeners went with it.
  hub.close();
  assert.equal(await received(await hub.openAs("box-p", old!)), "", "its target is served no more");

  // The project's box is made again.
  setProjectBoxState("ready");
  const next = await tools.forwardPort("box-a", boxPort, { principal: agent() });
  assert.ok(next.ok, next.ok ? "" : next.message);
  assert.equal(await fetchPort(next.value.projectBoxPort!), "hello from the box");
});

test("forwards in a box project: a project box being destroyed or destroyed is a BOX_DESTROYED refusal, nothing listened", async (t) => {
  const { tools, hub, projectBox, setProjectBoxState } = forwardingProjectWorld(t, true);
  const boxPort = await devServer(t, "hello from the box");
  setProjectBoxState("destroying");
  const destroying = await tools.forwardPort("box-a", boxPort, { principal: agent() });
  assert.ok(!destroying.ok && destroying.code === "BOX_DESTROYED" && destroying.status === 410, destroying.ok ? "" : destroying.code);
  setProjectBoxState("destroyed");
  projectBox.setConnected(false);
  const destroyed = await tools.forwardPort("box-a", boxPort, { principal: agent() });
  assert.ok(!destroyed.ok && destroyed.code === "BOX_DESTROYED", destroyed.ok ? "" : destroyed.code);
  assert.deepEqual(hub.ports(), []);
});

test("forwards in a box project: a bring-your-own project box given back stops listening its forwards; lent again, the old one is not handed back", async (t) => {
  const { tools, hub, changeProjectBox } = forwardingProjectWorld(t, true);
  const boxPort = await devServer(t, "hello from the box");
  const first = await tools.forwardPort("box-a", boxPort, { principal: agent() });
  assert.ok(first.ok, first.ok ? "" : first.message);
  const [old] = hub.lists.at(-1)!;
  const setForwards = hub.setForwards.bind(hub);
  const unlistened = new Promise<void>((resolve) => {
    hub.setForwards = async (boxId, next, options) => {
      const outcomes = await setForwards(boxId, next, options);
      if (next.length === 0) resolve();
      return outcomes;
    };
  });
  // "Destroying" a bring-your-own project box releases it: an idle machine, still ready and connected, never revoked.
  changeProjectBox({ purpose: "machine", project: null });
  assert.equal(await received(await hub.openAs("box-p", old!)), "", "its target is served no more");
  await unlistened;
  assert.deepEqual(hub.ports(), [], "the machine listens for it no more");

  // Lent to the project again: a forward made anew, not the one dropped with the release.
  changeProjectBox({ purpose: "project", project: GAME });
  const again = await tools.forwardPort("box-a", boxPort, { principal: agent() });
  assert.ok(again.ok, again.ok ? "" : again.message);
  const [made] = hub.lists.at(-1)!;
  assert.notEqual(made!.target, old!.target);
  assert.equal(await fetchPort(again.value.projectBoxPort!), "hello from the box");
});

// ---------------------------------------------------------------------------
// Chat close
// ---------------------------------------------------------------------------

test("chat close destroys that chat's live temporary boxes with reason chat-closed, and nothing else", async () => {
  const { tools, boxes } = world();
  boxes.add(boxSummary({ id: "box-a2", threadId: "chat-a", state: "provisioning" }));
  boxes.add(boxSummary({ id: "box-a3", threadId: "chat-a", state: "destroyed", destroyedReason: "agent" }));
  tools.chatClosed("chat-a");
  // The service seam is async: its destroy calls were made synchronously.
  assert.deepEqual(
    boxes.destroyed.map((entry) => `${entry.boxId}:${entry.reason}`).sort(),
    ["box-a2:chat-closed", "box-a:chat-closed"]
  );
  assert.equal(boxes.get("box-b")!.state, "ready");
  assert.equal(boxes.get("box-p")!.state, "ready");
});

test("chat close destroys the chat's boxes with the box tools disconnected (plugin off), through the cleanup seam", async () => {
  const { tools, boxes } = world({ connect: false });
  tools.chatClosed("chat-a");
  assert.equal(boxes.destroyed.length, 0, "nothing to reach before the cleanup seam is set");
  tools.setCleanup(boxes);
  assert.equal(tools.available(), false, "the cleanup seam does not advertise the box tools");
  const listed = tools.list(USER);
  assert.ok(!listed.ok && listed.code === "BOXES_DISABLED", "nor does it open the tools' operations");
  tools.chatClosed("chat-a");
  assert.deepEqual(
    boxes.destroyed.map((entry) => `${entry.boxId}:${entry.reason}`),
    ["box-a:chat-closed"]
  );
  // Connected then disconnected again (the plugin turned on and off): the cleanup still reaches the boxes.
  const disconnect = tools.connect({ boxes, hub: { get: () => undefined } });
  disconnect();
  tools.chatClosed("chat-b");
  assert.deepEqual(
    boxes.destroyed.map((entry) => `${entry.boxId}:${entry.reason}`),
    ["box-a:chat-closed", "box-b:chat-closed"]
  );
});
