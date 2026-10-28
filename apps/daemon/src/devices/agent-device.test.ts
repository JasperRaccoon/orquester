import assert from "node:assert/strict";
import { readFileSync, watch } from "node:fs";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { StoredDeviceLease } from "@orquester/config";

import {
  agentDeviceData,
  AgentDeviceError,
  agentDeviceSession,
  createAgentDeviceClient,
  type AgentDeviceResult
} from "./agent-device.ts";
import { isDeviceError } from "./errors.ts";
import { FakeDeviceHost } from "./testing.ts";
import type { DeviceToolchain } from "./toolchain/index.ts";

function fixture(name: string): AgentDeviceResult {
  const stdout = readFixture(name);
  const json = JSON.parse(stdout) as { success?: boolean };
  return { exitCode: json?.success === false ? 1 : 0, stdout, stderr: "", json };
}

function readFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/agent-device/${name}.json`, import.meta.url), "utf8");
}

function lease(overrides: Partial<StoredDeviceLease> = {}): StoredDeviceLease {
  return {
    id: "lease-1",
    threadId: "thread-1",
    hostId: "local",
    deviceId: "emulator-5554",
    platform: "android",
    profile: "pixel-9",
    name: "Pixel 9",
    osVersion: "Android 15",
    state: "ready",
    controller: "agent",
    openedBy: "agent",
    createdAt: "2026-10-27T00:00:00.000Z",
    lastUsedAt: "2026-10-27T00:00:00.000Z",
    ...overrides
  };
}

test("automation sessions stay stable per chat, host and device without colliding across chats or hosts", () => {
  const session = agentDeviceSession("thread-1", "local", "emulator-5554");
  assert.equal(session, agentDeviceSession("thread-1", "local", "emulator-5554"));
  assert.notEqual(session, agentDeviceSession("thread-2", "local", "emulator-5554"));
  assert.notEqual(session, agentDeviceSession("thread-1", "box:a", "emulator-5554"));
});

test("batch (type/wait text through stdin): the step's data and the step's own refusal", () => {
  const ok = { exitCode: 0, stdout: "", stderr: "", json: { success: true, data: { total: 1, executed: 1, results: [{ command: "wait", data: { waitedMs: 120, text: "Done" } }] } } };
  assert.deepEqual(agentDeviceData(ok, "batch"), { waitedMs: 120, text: "Done" });
  assert.deepEqual(agentDeviceData({ ...ok, json: { success: true, data: { results: [{ ok: true }] } } }, "batch"), { ok: true });
  assert.deepEqual(agentDeviceData({ ...ok, json: { success: true, data: {} } }, "batch"), {});
  // Observed (0.21.31): a one-step batch's refusal keeps the step's code; the prefix goes.
  const failed = { exitCode: 1, stdout: "", stderr: "", json: { success: false, error: { code: "SESSION_NOT_FOUND", message: "Batch failed at step 1 (type): No active session. Run open first.", details: { step: 1, command: "type" } } } };
  const error = catchError(() => agentDeviceData(failed, "batch"));
  assert.equal(error.cliCode, "SESSION_NOT_FOUND");
  assert.match(error.message, /^No active session/);
});

test("output: data from real answers; refusals become DeviceErrors that name the next call, without host paths", () => {
  const click = agentDeviceData(fixture("click-settle"), "click");
  assert.equal(click.x, 360);
  assert.equal(click.refLabel, "Google search");
  assert.equal((agentDeviceData(fixture("devices"), "devices").devices as unknown[]).length, 2);

  const stale = catchError(() => agentDeviceData(fixture("err-ref"), "click"));
  assert.equal(stale.code, "INVALID_ARGUMENT");
  assert.match(stale.message, /Take a new snapshot/);
  assert.equal(stale.reason, "plain_ref_requires_complete_frame");

  const unknown = catchError(() => agentDeviceData(fixture("err-cmd"), "bogus"));
  assert.equal(unknown.code, "INVALID_ARGUMENT");
  assert.equal(unknown.cliCode, "INVALID_ARGS");

  const session = catchError(() => agentDeviceData(fixture("home3"), "home"));
  assert.equal(session.cliCode, "SESSION_NOT_FOUND");
  assert.match(session.message, /open_app/);
  assert.doesNotMatch(session.message, /\/tmp\/orq-smoke/);

  const crashed = catchError(() => agentDeviceData({ exitCode: 2, stdout: "", stderr: "boom at /var/lib/x/y.js:1\n" }, "snapshot"));
  assert.equal(crashed.code, "UNAVAILABLE");
  assert.ok(crashed.message.includes("boom") && !crashed.message.includes("/var/lib/x/y.js"));
  const path = catchError(() => agentDeviceData({ exitCode: 2, stdout: "", stderr: "see https://example.com/a/b and /home/u/.agent-device/x.log" }, "snapshot"));
  assert.ok(path.message.includes("https://example.com/a/b"));
  assert.ok(!path.message.includes("/home/u/.agent-device/x.log"));
});

function catchError(run: () => unknown): AgentDeviceError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof AgentDeviceError, String(error));
    return error;
  }
  throw new Error("expected a refusal");
}

async function fakeCli(script: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "orq-ad-cli-"));
  const path = join(dir, "agent-device.mjs");
  await writeFile(path, script);
  await chmod(path, 0o700);
  return { dir, path };
}

const toolchain = (bin: string | null): DeviceToolchain => ({
  tools: async () => [],
  ensureTool: async () => "",
  toolBin: () => bin,
  androidStatus: async () => ({ packages: [], avds: [] }),
  ensureAndroid: async () => undefined
});

test("the runner: the toolchain's CLI under this Node, the host's config, no token in argv, stdin, scrubbed env", async (t) => {
  const cli = await fakeCli(
    `let input = ""; process.stdin.on("data", (d) => (input += d)).on("end", () => {
      const env = process.env;
      console.log("preliminary CLI diagnostic");
      console.log(JSON.stringify({ success: true, data: { argv: process.argv.slice(2), input, env } }));
    });`
  );
  t.after(() => rm(cli.dir, { recursive: true, force: true }));
  const host = new FakeDeviceHost();
  host.agentDeviceConfigPath = () => "/state/agent-device/local.json";
  const client = createAgentDeviceClient({ toolchain: toolchain(cli.path), env: { PATH: process.env.PATH, HOME: "/home/device-test", LANG: "en_US.UTF-8", AGENT_DEVICE_DAEMON_AUTH_TOKEN: "leak", AGENT_DEVICE_CONFIG: "/evil", ANTHROPIC_API_KEY: "secret-provider", NODE_OPTIONS: "--require /tmp/evil.js" } });
  const result = await client.run({ host, lease: lease() }, "fill", ["@e3", "--text-stdin", "--settle"], { signal: new AbortController().signal, stdin: "secret words" });
  const data = agentDeviceData(result, "fill") as { argv: string[]; input: string; env: Record<string, string> };
  assert.deepEqual(data.argv, [
    "--config",
    "/state/agent-device/local.json",
    "--session",
    agentDeviceSession("thread-1", "local", "emulator-5554"),
    "--platform",
    "android",
    "--serial",
    "emulator-5554",
    "--json",
    "fill",
    "@e3",
    "--text-stdin",
    "--settle"
  ]);
  assert.equal(data.input, "secret words");
  assert.equal(data.env.HOME, "/home/device-test");
  assert.equal(data.env.LANG, "en_US.UTF-8");
  for (const key of ["AGENT_DEVICE_DAEMON_AUTH_TOKEN", "AGENT_DEVICE_CONFIG", "ANTHROPIC_API_KEY", "NODE_OPTIONS"]) assert.equal(data.env[key], undefined, key);
  host.agentDeviceCommand = () => ({ command: process.execPath, args: [cli.path], env: { HOME: "/host/home", AGENT_DEVICE_HOME: "/host/state" } });
  const ios = await client.run({ host, lease: lease({ platform: "ios", deviceId: "UDID" }) }, "snapshot", ["-i"], { signal: new AbortController().signal });
  const iosData = (ios.json as { data: { argv: string[]; env: Record<string, string> } }).data;
  const iosArgv = iosData.argv;
  assert.equal(iosData.env.HOME, "/host/home");
  assert.equal(iosData.env.AGENT_DEVICE_HOME, "/host/state");
  assert.deepEqual(iosArgv.slice(4), ["--platform", "ios", "--udid", "UDID", "--json", "snapshot", "-i"]);
  assert.ok(!data.argv.some((arg) => arg.includes("secret") || arg.includes("leak")));
});

test("the runner: a one-step batch reads its steps from /dev/stdin", async (t) => {
  const cli = await fakeCli(`import { readFileSync } from "node:fs"; console.log(JSON.stringify({ success: true, data: { steps: readFileSync("/dev/stdin", "utf8") } }));`);
  t.after(() => rm(cli.dir, { recursive: true, force: true }));
  const host = new FakeDeviceHost();
  host.agentDeviceConfigPath = () => "/state/agent-device/local.json";
  const client = createAgentDeviceClient({ toolchain: toolchain(cli.path), env: process.env });
  const steps = JSON.stringify([{ command: "type", input: { text: " saver" } }]);
  const result = await client.run({ host, lease: lease() }, "batch", ["--steps-file", "/dev/stdin"], { signal: new AbortController().signal, stdin: steps });
  assert.equal((result.json as { data: { steps: string } }).data.steps, steps);
});

test("the runner: a host's own command wins; missing config, missing CLI, timeouts and aborts refuse", async (t) => {
  const slow = await fakeCli(`import { writeFileSync } from "node:fs";
    writeFileSync(new URL("./started", import.meta.url), "ready");
    setTimeout(() => console.log("{}"), 30_000);`);
  t.after(() => rm(slow.dir, { recursive: true, force: true }));
  const host = new FakeDeviceHost();
  const client = createAgentDeviceClient({ toolchain: toolchain(null), env: process.env });
  const signal = new AbortController().signal;

  host.agentDeviceCommand = () => ({ command: process.execPath, args: ["-e", "console.log(JSON.stringify({ success: true, data: {} }))", "--"], env: {} });
  const noConfig = await client.run({ host, lease: lease() }, "snapshot", [], { signal }).catch((error: unknown) => error);
  assert.ok(isDeviceError(noConfig) && noConfig.code === "UNAVAILABLE");
  delete host.agentDeviceCommand;
  host.agentDeviceConfigPath = () => "/c.json";
  const noCli = await client.run({ host, lease: lease() }, "snapshot", [], { signal }).catch((error: unknown) => error);
  assert.ok(isDeviceError(noCli) && /not installed/.test(noCli.message));

  host.agentDeviceCommand = () => ({ command: process.execPath, args: [slow.path], env: {} });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timeoutWatcher = watch(slow.dir);
  const started = once(timeoutWatcher, "change");
  const waiting = client.run({ host, lease: lease() }, "snapshot", [], { signal, timeoutMs: 200 }).catch((error: unknown) => error);
  await started;
  timeoutWatcher.close();
  t.mock.timers.tick(200);
  const timedOut = await waiting;
  t.mock.timers.reset();
  assert.ok(isDeviceError(timedOut) && /timed out/.test(timedOut.message), String(timedOut));

  const abort = new AbortController();
  t.after(() => abort.abort());
  const watcher = watch(slow.dir);
  t.after(() => watcher.close());
  const launched = once(watcher, "change");
  const pending = client.run({ host, lease: lease() }, "snapshot", [], { signal: abort.signal });
  await Promise.race([launched, pending.then(() => { throw new Error("the stalled fixture exited before cancellation"); })]);
  watcher.close();
  abort.abort();
  const cancelled = await pending.catch((error: unknown) => error);
  assert.ok(isDeviceError(cancelled) && cancelled.code === "CANCELLED");

  const starting = await client.run({ host, lease: lease({ deviceId: null }) }, "snapshot", [], { signal }).catch((error: unknown) => error);
  assert.ok(isDeviceError(starting) && /still starting/.test(starting.message));
});
