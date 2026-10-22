import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { BoxListeningPort, SessionSummary } from "@orquester/api";

import type { BoxHostForward } from "../../contracts.ts";
import { localBoxConnection } from "../../testing.ts";
import { BoxDevForwards, loopbackTarget, offerablePorts } from "./dev-forwards.ts";
import { boxRecord, fakeBoxes } from "./testing.ts";

const PROJECT = "/srv/workspaces/acme/app";

function session(status: SessionSummary["status"]): SessionSummary {
  return { id: "s-1", kind: "shell", refId: "bash", title: "Bash", projectPath: PROJECT, cwd: PROJECT, cols: 80, rows: 24, status, order: 0, createdAt: "x" };
}

function rig(options: { ports?: BoxListeningPort[]; fakeForward?: boolean; browserInBox?: boolean; ownPorts?: number[] } = {}) {
  const connection = localBoxConnection({ boxId: "box-1" });
  const forwardCalls: { boxPort: number; hostPort?: number }[] = [];
  const closed: number[] = [];
  if (options.fakeForward) {
    let next = 50_000;
    connection.forwardToHost = async (boxPort, forwardOptions) => {
      forwardCalls.push({ boxPort, ...(forwardOptions?.hostPort !== undefined ? { hostPort: forwardOptions.hostPort } : {}) });
      const hostPort = forwardOptions?.hostPort ?? next++;
      const forward: BoxHostForward = {
        hostPort,
        boxPort,
        close: async () => {
          closed.push(hostPort);
        }
      };
      return forward;
    };
  }
  if (options.ports) {
    const ports = options.ports;
    const request = connection.request.bind(connection);
    connection.request = (async (method: string, params: unknown) =>
      method === "sys.ports" ? ports : (request as (m: string, p: unknown) => Promise<unknown>)(method, params)) as typeof connection.request;
  }
  const boxes = fakeBoxes();
  boxes.add(boxRecord("box-1", { project: { workspace: "acme", name: "app", path: PROJECT } }), connection);
  let sessions: SessionSummary[] = [session("running")];
  let tabs: { projectPath: string; url: string }[] = [];
  const sessionEvents = new EventEmitter();
  const browserEvents = new EventEmitter();
  const forwards = new BoxDevForwards({
    registry: boxes.registry,
    hub: boxes.hub,
    sessions: { list: (projectPath) => sessions.filter((s) => projectPath === undefined || s.projectPath === projectPath), lifecycle: sessionEvents },
    browsers: { list: (projectPath) => tabs.filter((t) => projectPath === undefined || t.projectPath === projectPath), lifecycle: browserEvents },
    ...(options.browserInBox !== undefined ? { browserRunsInBox: (projectPath: string) => options.browserInBox! && boxes.registry.locate(projectPath).kind === "box" } : {}),
    ...(options.ownPorts ? { ownPorts: (boxId: string) => (boxId === "box-1" ? options.ownPorts! : []) } : {})
  });
  return {
    connection,
    boxes,
    forwards,
    forwardCalls,
    closed,
    sessionEvents,
    browserEvents,
    setSessions: (next: SessionSummary[]) => (sessions = next),
    setTabs: (next: { projectPath: string; url: string }[]) => (tabs = next)
  };
}

test("a sniffed box dev server is suggested at its host forward, which really reaches it", async () => {
  const server: Server = createServer((_req, res) => res.end("hello from the box"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const r = rig({ ports: [] });
  try {
    // The local double rejects a taken host port, as a real hub's forward does.
    await assert.rejects(r.connection.forwardToHost(port, { hostPort: port }), { code: "EADDRINUSE" });
    // A port the box names gets a host port the host picks (here the same number is taken anyway).
    const [url, ...rest] = await r.forwards.suggestions(PROJECT, [`http://localhost:${port}`]);
    assert.deepEqual(rest, []);
    const target = loopbackTarget(url!);
    assert.ok(target && target.port !== port);
    // No keep-alive: the forward's listener closes once its connections have.
    const body = await new Promise<string>((resolve, reject) => {
      get(url!, { agent: false }, (res) => {
        let text = "";
        res.on("data", (chunk) => (text += String(chunk)));
        res.on("end", () => resolve(text));
      }).on("error", reject);
    });
    assert.equal(body, "hello from the box");
    // Asking again reuses the forward.
    assert.deepEqual(await r.forwards.suggestions(PROJECT, [`http://localhost:${port}`]), [url]);
    assert.equal(r.forwards.list().length, 1);
  } finally {
    await r.forwards.dispose();
    server.close();
  }
});

test("box listening ports are offered (system daemons and privileged ports left out), each on a host port the host picks", async () => {
  const r = rig({
    fakeForward: true,
    ports: [
      { port: 22, address: "0.0.0.0", pid: 1, command: "sshd" },
      { port: 3000, address: "127.0.0.1", pid: 2, command: "node" },
      { port: 41641, address: "0.0.0.0", pid: 3, command: "/usr/sbin/tailscaled" },
      { port: 8000, address: "::", pid: 4, command: "python3" },
      { port: 9229, address: "10.0.0.5", pid: 5, command: "node" }
    ]
  });
  try {
    const urls = await r.forwards.suggestions(PROJECT, ["https://0.0.0.0:5173", "http://localhost:3000"]);
    // The suggestions point at the forwards; the box never chose a host port (no `hostPort` asked).
    assert.deepEqual(urls, ["https://localhost:50000", "http://localhost:50001", "http://localhost:50002"]);
    assert.deepEqual(r.forwardCalls, [{ boxPort: 5173 }, { boxPort: 3000 }, { boxPort: 8000 }]);
    assert.deepEqual(r.forwards.list().map((forward) => [forward.boxPort, forward.hostPort]), [
      [5173, 50000],
      [3000, 50001],
      [8000, 50002]
    ]);
  } finally {
    await r.forwards.dispose();
  }
});

test("forwards live while the project has sessions or a tab uses them; a destroyed box closes them", async () => {
  const r = rig({ fakeForward: true, ports: [] });
  try {
    const [app] = await r.forwards.suggestions(PROJECT, ["http://localhost:5173", "http://localhost:6006"]);
    assert.equal(app, "http://localhost:50000");
    r.setTabs([{ projectPath: PROJECT, url: `${app}/app` }]);
    await r.forwards.sweep();
    assert.equal(r.forwards.list().length, 2, "an open session keeps every forward");

    r.setSessions([session("exited")]);
    await r.forwards.sweep();
    assert.deepEqual(r.closed, [50001]);
    assert.deepEqual(r.forwards.list().map((f) => f.boxPort), [5173], "the tab's forward stays");

    r.boxes.update("box-1", { state: "destroyed" });
    await r.forwards.dispose();
    assert.deepEqual(r.closed.sort(), [50000, 50001]);
  } finally {
    await r.forwards.dispose();
  }
});

test("a box tab opened on localhost:<port> gets a same-port forward; host projects are untouched", async () => {
  const r = rig({ fakeForward: true, ports: [] });
  try {
    r.browserEvents.emit("created", { projectPath: PROJECT, url: "http://localhost:7000/" });
    await r.forwards.restore();
    assert.deepEqual(r.forwardCalls, [{ boxPort: 7000, hostPort: 7000 }]);
    assert.deepEqual(await r.forwards.suggestions("/srv/workspaces/acme/host-project", ["http://localhost:1234"]), ["http://localhost:1234"]);
    r.connection.setConnected(false);
    assert.deepEqual(await r.forwards.suggestions(PROJECT, ["http://localhost:5173"]), [], "nothing to suggest while the box is away");
  } finally {
    await r.forwards.dispose();
  }
});

test("the VM browser's own debugging port in the box is never offered as a dev server", async () => {
  const r = rig({
    fakeForward: true,
    browserInBox: true,
    ownPorts: [37225],
    ports: [
      { port: 37225, address: "127.0.0.1", pid: 3, command: "chrome" },
      { port: 8000, address: "0.0.0.0", pid: 4, command: "python3" }
    ]
  });
  try {
    assert.deepEqual(await r.forwards.suggestions(PROJECT, ["http://127.0.0.1:37225/json"]), ["http://localhost:8000"]);
  } finally {
    await r.forwards.dispose();
  }
});

test("a box project whose Chromium runs in the box is offered box-local addresses and gets no forward", async () => {
  const r = rig({
    fakeForward: true,
    browserInBox: true,
    ports: [
      { port: 22, address: "0.0.0.0", pid: 1, command: "sshd" },
      { port: 3000, address: "127.0.0.1", pid: 2, command: "node" },
      { port: 8000, address: "::", pid: 4, command: "python3" }
    ]
  });
  try {
    const urls = await r.forwards.suggestions(PROJECT, ["https://0.0.0.0:5173/app", "http://127.0.0.1:3000"]);
    assert.deepEqual(urls, ["https://localhost:5173", "http://localhost:3000", "http://localhost:8000"]);
    // A tab opened or navigated on a box port, and a restore after a reconnect: still no forward.
    r.setTabs([{ projectPath: PROJECT, url: "http://localhost:7000/" }]);
    r.browserEvents.emit("created", { projectPath: PROJECT, url: "http://localhost:7000/" });
    r.browserEvents.emit("updated", { projectPath: PROJECT, url: "http://localhost:3000/" });
    await r.forwards.restore();
    assert.deepEqual(r.forwardCalls, []);
    assert.deepEqual(r.forwards.list(), []);
    // Host projects are untouched either way; nothing is offered while the box is away.
    assert.deepEqual(await r.forwards.suggestions("/srv/workspaces/acme/host-project", ["http://localhost:1234"]), ["http://localhost:1234"]);
    r.connection.setConnected(false);
    assert.deepEqual(await r.forwards.suggestions(PROJECT, ["http://localhost:5173"]), []);
  } finally {
    await r.forwards.dispose();
  }
});

test("a box project whose Chromium stays on the host keeps the forwards", async () => {
  const r = rig({ fakeForward: true, browserInBox: false, ports: [] });
  try {
    assert.deepEqual(await r.forwards.suggestions(PROJECT, ["http://localhost:5173"]), ["http://localhost:50000"]);
    r.browserEvents.emit("created", { projectPath: PROJECT, url: "http://localhost:7000/" });
    await r.forwards.restore();
    assert.deepEqual(r.forwardCalls, [{ boxPort: 5173 }, { boxPort: 7000, hostPort: 7000 }]);
  } finally {
    await r.forwards.dispose();
  }
});

test("loopbackTarget and offerablePorts", () => {
  assert.deepEqual(loopbackTarget("http://127.0.0.1:5173"), { scheme: "http", port: 5173 });
  assert.deepEqual(loopbackTarget("https://localhost"), { scheme: "https", port: 443 });
  assert.equal(loopbackTarget("http://example.com:5173"), null);
  assert.equal(loopbackTarget("file:///etc/passwd"), null);
  assert.deepEqual(offerablePorts([{ port: 5432, address: "127.0.0.1", pid: null, command: null }, { port: 80, address: "0.0.0.0", pid: null, command: "nginx" }]), [5432]);
});
