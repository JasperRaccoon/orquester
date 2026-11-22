import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { localBoxConnection } from "../../boxes/testing.ts";
import { DirectStreamGate, type GatePlace } from "./machine-gate.ts";

/** A `tailscale` CLI that keeps its serve config in `$FAKE_TS_DIR/serve.json` (and refuses changes while `refuse` exists). */
const FAKE_TAILSCALE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.FAKE_TS_DIR;
const file = path.join(dir, "serve.json");
const read = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };
const args = process.argv.slice(2);
const name = "mac.tail.ts.net";
if (args[0] === "status") { console.log(JSON.stringify({ BackendState: "Running", Self: { DNSName: name + ".", TailscaleIPs: ["100.1.2.3"] }, CertDomains: [name] })); process.exit(0); }
if (args[0] === "debug") { console.log("{}"); process.exit(0); }
if (args[0] === "serve" && args[1] === "status") { console.log(JSON.stringify(read())); process.exit(0); }
if (args[0] === "serve") {
  if (fs.existsSync(path.join(dir, "refuse"))) { console.error("Access denied: serve config denied"); process.exit(1); }
  const port = Number(args.find((arg) => arg.startsWith("--https=")).slice(8));
  const config = read();
  config.TCP = config.TCP || {};
  config.Web = config.Web || {};
  if (args.includes("off")) { delete config.TCP[port]; delete config.Web[name + ":" + port]; }
  else { config.TCP[port] = { HTTPS: true }; config.Web[name + ":" + port] = { Handlers: { "/": { Proxy: args[args.length - 1] } } }; }
  fs.writeFileSync(file, JSON.stringify(config));
  process.exit(0);
}
process.exit(2);
`;
/** No passwordless sudo here. */
const FAKE_SUDO = `#!/bin/sh
echo "sudo: a password is required" >&2
exit 1
`;

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A machine: a device root with a running (fake) hub, the fake CLIs on its PATH, and its box link. */
async function machine() {
  const root = await mkdtemp(join(tmpdir(), "orq-gate-"));
  const bin = join(root, "bin");
  const tsDir = join(root, "ts");
  const hubState = join(root, "hub");
  for (const dir of [bin, tsDir, hubState]) await mkdir(dir, { recursive: true });
  await writeFile(join(bin, "tailscale"), FAKE_TAILSCALE);
  await writeFile(join(bin, "sudo"), FAKE_SUDO);
  await chmod(join(bin, "tailscale"), 0o755);
  await chmod(join(bin, "sudo"), 0o755);

  const hub: Server = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer hub-token") return void res.writeHead(401).end();
    res.writeHead(200, { "content-type": "application/octet-stream" });
    // A stream stays open while it is watched; anything else answers at once.
    if (req.url?.includes("stream.avcc")) res.write("frame");
    else res.end("ok");
  });
  hub.listen(0, "127.0.0.1");
  await once(hub, "listening");
  const hubPort = (hub.address() as AddressInfo).port;
  await writeFile(join(hubState, `server-${hubPort}.json`), JSON.stringify({ pid: process.pid, port: hubPort, token: "hub-token" }), { mode: 0o600 });

  const link = localBoxConnection();
  const place: GatePlace = { nodePath: process.execPath, root, hubStateDir: hubState, env: { PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_TS_DIR: tsDir } };
  const activity = new EventEmitter();
  const gates: DirectStreamGate[] = [];
  const gate = () => {
    const made = new DirectStreamGate({
      hostId: "box:mac",
      machineName: () => "studio",
      machineId: () => "ts:studio",
      connection: () => link,
      activity: { viewers: (_host, device, count) => activity.emit("viewers", device, count), input: (_host, device) => activity.emit("input", device) },
      logger: quiet,
      timing: { pollMs: 20 }
    });
    gates.push(made);
    return made;
  };
  const gatePort = async (): Promise<number> => (JSON.parse(await readFile(join(root, "gate", "state.json"), "utf8")) as { port: number }).port;
  const serveConfig = async (): Promise<{ Web?: Record<string, { Handlers: Record<string, { Proxy: string }> }> }> =>
    JSON.parse(await readFile(join(tsDir, "serve.json"), "utf8").catch(() => "{}"));
  cleanups.push(async () => {
    for (const made of gates) await made.dispose();
    const state = await readFile(join(root, "gate", "state.json"), "utf8").catch(() => null);
    if (state) {
      try {
        process.kill((JSON.parse(state) as { pid: number }).pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    hub.closeAllConnections();
    await new Promise<void>((resolve) => hub.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, tsDir, place, activity, gate, gatePort, serveConfig };
}

const viewersReach = (activity: EventEmitter, device: string, count: number) =>
  new Promise<void>((resolve) => {
    const listener = (seen: string, n: number) => {
      if (seen === device && n === count) {
        activity.off("viewers", listener);
        resolve();
      }
    };
    activity.on("viewers", listener);
  });

test("an own machine's gate: served at its tailnet name next to another app's route, its streams reported, reused after a restart, and only its route removed", async () => {
  const m = await machine();
  // Another app already serves the first port Orquester would try.
  await writeFile(join(m.tsDir, "serve.json"), JSON.stringify({ TCP: { 10043: { HTTPS: true } }, Web: { "mac.tail.ts.net:10043": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } }));

  const first = m.gate();
  await first.ensure(m.place);
  const port = await m.gatePort();
  const direct = first.stream();
  assert.equal(direct?.tailnetUrl, "https://mac.tail.ts.net:10044");
  assert.deepEqual(first.problems(), []);
  const served = await m.serveConfig();
  assert.equal(served.Web?.["mac.tail.ts.net:10043"]?.Handlers["/"]?.Proxy, "http://127.0.0.1:3000");
  assert.equal(served.Web?.["mac.tail.ts.net:10044"]?.Handlers["/"]?.Proxy, `http://127.0.0.1:${port}`);

  // A watched stream on the direct route reaches the hub proxy's counts, and its end too.
  const ticket = direct!.issueTicket({ device: "SIM-1", expiresAt: Date.now() + 60_000, origin: null });
  const watching = viewersReach(m.activity, "SIM-1", 1);
  const abort = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/vendor/serve-sim/helper/SIM-1/stream.avcc?ticket=${encodeURIComponent(ticket)}`, { signal: abort.signal });
  assert.equal(response.status, 200);
  await watching;
  const left = viewersReach(m.activity, "SIM-1", 0);
  abort.abort();
  await left;

  // The daemon restarts: the running gate and its secret are found again (an earlier ticket still opens it).
  await first.dispose();
  const second = m.gate();
  await second.ensure(m.place);
  assert.equal(await m.gatePort(), port);
  assert.equal(second.stream()?.tailnetUrl, "https://mac.tail.ts.net:10044");
  const shot = await fetch(`http://127.0.0.1:${port}/vendor/serve-emu/api/screenshot?device=SIM-1&ticket=${encodeURIComponent(ticket)}`, { method: "POST" });
  assert.equal(shot.status, 200);

  // Idle: the gate stops and Orquester's route goes; the other app's stays.
  await second.stop();
  assert.equal(second.stream(), null);
  const after = await m.serveConfig();
  assert.deepEqual(Object.keys(after.Web ?? {}), ["mac.tail.ts.net:10043"]);
});

test("a machine whose Tailscale refuses serve changes gets no tailnet route and names the operator fix", async () => {
  const m = await machine();
  await writeFile(join(m.tsDir, "refuse"), "");
  const gate = m.gate();
  await gate.ensure(m.place);
  assert.equal(gate.stream()?.tailnetUrl, null);
  const [problem] = gate.problems();
  assert.equal(problem?.code, "tailscale-not-operator");
  assert.match(problem?.fix ?? "", /^On studio: sudo tailscale set --operator=\S+$/);
});
