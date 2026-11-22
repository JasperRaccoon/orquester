import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { TailnetChangedPayload } from "@orquester/api";

import { createLocalTailscale, type CommandRunner } from "../boxes/tailscale/local.ts";
import { createTailnetService, TailnetError, TAILNET_CHECK_INTERVAL_MS, type TailnetServiceDeps } from "./service.ts";

const NAME = "ryzen7700.taila64f1b.ts.net";
const USER = "orquester";

const denied = (stderr: string): Error => Object.assign(new Error(`Command failed\n${stderr}`), { code: 1, stderr, stdout: "" });

/** `tailscale` and `sudo` on a fake machine: serve routes by port, the operator, what sudo -n may run. */
class FakeTailscale {
  routes = new Map<number, string>();
  operator: string | null = USER;
  /** `sudo -n` runs these without a password (a prefix of the command after `sudo -n`). */
  sudoAllows: string[] = [];
  calls: string[] = [];

  private status(): string {
    return JSON.stringify({ BackendState: "Running", Self: { DNSName: `${NAME}.`, TailscaleIPs: ["100.80.44.62"] }, CertDomains: [NAME] });
  }

  private serveStatus(): string {
    const TCP: Record<string, unknown> = {};
    const Web: Record<string, unknown> = {};
    for (const [port, target] of this.routes) {
      TCP[String(port)] = { HTTPS: true };
      Web[`${NAME}:${port}`] = { Handlers: { "/": { Proxy: target } } };
    }
    return JSON.stringify(this.routes.size > 0 ? { TCP, Web } : {});
  }

  private tailscale(args: string[], root: boolean): string {
    const line = args.join(" ");
    if (line === "status --json") return this.status();
    if (line === "serve status --json") return this.serveStatus();
    if (line === "debug prefs") return JSON.stringify(this.operator ? { OperatorUser: this.operator } : {});
    const set = /^set --operator=(\S+)$/.exec(line);
    if (set) {
      if (!root) throw denied("Access denied: prefs write access denied");
      this.operator = set[1]!;
      return "";
    }
    if (!root && this.operator !== USER) throw denied("Access denied: serve config denied. Use 'sudo tailscale set --operator=$USER'");
    const serve = /^serve --bg --https=(\d+) (\S+)$/.exec(line);
    if (serve) {
      this.routes.set(Number(serve[1]), serve[2]!);
      return "";
    }
    const off = /^serve --https=(\d+) off$/.exec(line);
    if (off) {
      this.routes.delete(Number(off[1]));
      return "";
    }
    throw denied(`unexpected: tailscale ${line}`);
  }

  run: CommandRunner = async (file, args) => {
    const line = [file, ...args].join(" ");
    this.calls.push(line);
    if (file === "tailscale") return { stdout: this.tailscale([...args], false), stderr: "" };
    const command = args.slice(1).join(" ");
    if (args[0] !== "-n" || !this.sudoAllows.some((allowed) => command.startsWith(allowed))) throw denied("sudo: a password is required");
    if (command === "true") return { stdout: "", stderr: "" };
    return { stdout: this.tailscale(args.slice(2), true), stderr: "" };
  };
}

interface Harness {
  ts: FakeTailscale;
  service: ReturnType<typeof createTailnetService>;
  /** Ports something listens on (127.0.0.1, unless listed in `onlyV6`). */
  listening: Set<number>;
  onlyV6: Set<number>;
  daemon: { host: string; port: number } | null;
  events: TailnetChangedPayload[];
  /** The next published event that satisfies `match`. */
  nextEvent(match: (payload: TailnetChangedPayload) => boolean): Promise<TailnetChangedPayload>;
  file: string;
}

async function harness(t: TestContext, options: { setup?: (ts: FakeTailscale) => void; deps?: Partial<TailnetServiceDeps> } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "orq-tailnet-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ts = new FakeTailscale();
  options.setup?.(ts);
  const waiters: { match: (payload: TailnetChangedPayload) => boolean; resolve: (payload: TailnetChangedPayload) => void }[] = [];
  const h: Harness = {
    ts,
    listening: new Set([47831]),
    onlyV6: new Set(),
    daemon: { host: "127.0.0.1", port: 47831 },
    events: [],
    file: join(dir, "tailnet.json"),
    nextEvent: (match) => new Promise((resolve) => waiters.push({ match, resolve })),
    service: null as unknown as Harness["service"]
  };
  const local = createLocalTailscale({ daemonHttp: () => h.daemon ?? { host: "127.0.0.1", port: 47831 }, run: ts.run, user: () => USER, isRoot: () => false });
  h.service = createTailnetService({
    local,
    file: h.file,
    writeJson: (file, value) => writeFile(file, JSON.stringify(value)),
    listening: () => h.daemon,
    probe: async ({ host, port }) => h.listening.has(port) && (h.onlyV6.has(port) ? host === "::1" : host === "127.0.0.1"),
    publish: (payload) => {
      h.events.push(payload);
      for (const waiter of waiters.splice(0)) {
        if (waiter.match(payload)) waiter.resolve(payload);
        else waiters.push(waiter);
      }
    },
    ...options.deps
  });
  t.after(() => h.service.stop());
  return h;
}

const problemOf = (error: unknown): string | undefined => (error instanceof TailnetError ? error.problem?.code : undefined);

test("every 30 s the route is recreated when deleted, repointed when the daemon moved, and never taken from another app", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness(t);
  await h.service.start();
  assert.equal((await h.service.httpsStatus()).serveState, "off");

  const enabled = await h.service.enableHttps();
  assert.equal(enabled.serveState, "serving");
  assert.equal(enabled.url, `https://${NAME}:10000`);
  assert.equal(h.ts.routes.get(10000), "http://127.0.0.1:47831");

  // Someone deletes the route: the next check recreates it.
  h.ts.routes.delete(10000);
  const repaired = h.nextEvent((payload) => payload.https.serveState === "serving");
  t.mock.timers.tick(TAILNET_CHECK_INTERVAL_MS);
  await repaired;
  assert.equal(h.ts.routes.get(10000), "http://127.0.0.1:47831");
  assert.ok(h.events.some((payload) => payload.https.serveState === "repairing"));
  await h.service.check();

  // The daemon now listens on another port; its old one is dead: Orquester's own route follows it.
  h.daemon = { host: "127.0.0.1", port: 47900 };
  h.listening = new Set([47900]);
  const moved = h.nextEvent((payload) => payload.https.serveState === "serving");
  t.mock.timers.tick(TAILNET_CHECK_INTERVAL_MS);
  await moved;
  assert.equal(h.ts.routes.get(10000), "http://127.0.0.1:47900");
  await h.service.check();

  // Another live app took the port: left alone, and the problem says how to fix it.
  h.ts.routes.set(10000, "http://127.0.0.1:3000");
  h.listening.add(3000);
  const taken = h.nextEvent((payload) => payload.https.serveState === "taken");
  t.mock.timers.tick(TAILNET_CHECK_INTERVAL_MS);
  const payload = await taken;
  assert.equal(h.ts.routes.get(10000), "http://127.0.0.1:3000");
  assert.equal(payload.https.problem?.code, "serve-port-taken");
  assert.match(payload.https.problem?.fix ?? "", /port 10001/);
  assert.equal(h.ts.calls.filter((line) => line.endsWith("http://127.0.0.1:3000")).length, 0);
});

test("a route already serving the daemon is adopted; turning it off removes only Orquester's own route", async (t) => {
  const h = await harness(t, {
    setup: (ts) => {
      ts.routes.set(10000, "http://127.0.0.1:47831");
      ts.routes.set(10001, "http://127.0.0.1:3000");
    }
  });
  await h.service.start();
  assert.equal((await h.service.httpsStatus()).url, `https://${NAME}:10000`);
  const stored = JSON.parse(await readFile(h.file, "utf8"));
  assert.deepEqual([stored.https.enabled, stored.https.port, stored.https.target], [true, 10000, "http://127.0.0.1:47831"]);

  const off = await h.service.disableHttps();
  assert.equal(off.serveState, "off");
  assert.deepEqual([...h.ts.routes.keys()], [10001]);
  assert.deepEqual(h.ts.calls.filter((line) => line.endsWith(" off")), ["tailscale serve --https=10000 off"]);
  await h.service.check();
  assert.equal(h.ts.routes.has(10000), false, "not recreated once turned off");
});

test("without operator rights setup names the fix; after the operator grant serve changes need no sudo", async (t) => {
  const h = await harness(t, {
    setup: (ts) => {
      ts.operator = null;
      // A sudoers rule for exactly this command, no blanket passwordless sudo.
      ts.sudoAllows = [`tailscale set --operator=${USER}`];
    }
  });
  await h.service.start();
  assert.equal((await h.service.httpsStatus()).operatorOk, false);
  const refusal = await h.service.enableHttps().then(
    () => assert.fail("enabled without permission"),
    (error: unknown) => error
  );
  assert.equal(problemOf(refusal), "tailscale-not-operator");
  assert.match((refusal as TailnetError).problem?.fix ?? "", /sudo tailscale set --operator=orquester/);

  const granted = await h.service.setOperator();
  assert.equal(granted.operatorOk, true);
  assert.ok(h.ts.calls.includes(`sudo -n tailscale set --operator=${USER}`));
  const before = h.ts.calls.length;
  assert.equal((await h.service.enableHttps()).serveState, "serving");
  assert.ok(h.ts.calls.slice(before).includes("tailscale serve --bg --https=10000 http://127.0.0.1:47831"));
  assert.ok(!h.ts.calls.slice(before).some((line) => line.startsWith("sudo")));
});

test("the operator grant without passwordless sudo answers the exact command", async (t) => {
  const h = await harness(t, { setup: (ts) => (ts.operator = null) });
  await h.service.start();
  const refusal = await h.service.setOperator().then(
    () => assert.fail("granted without sudo"),
    (error: unknown) => error
  );
  assert.equal(problemOf(refusal), "tailscale-not-operator");
  assert.equal((refusal as TailnetError).problem?.fix, "Run `sudo tailscale set --operator=orquester` once on this server.");
});

test("previews: shared on the same port, gone when the port stops listening or the chat closes, never another app's", async (t) => {
  const h = await harness(t, {
    setup: (ts) => ts.routes.set(3000, "http://127.0.0.1:3000"),
    deps: { hostPortFor: async (projectPath, port) => (projectPath === "/ws/boxed" ? port + 40000 : null) }
  });
  h.listening = new Set([47831, 3000, 5173, 5174, 6000, 45173]);
  h.onlyV6.add(6000);
  await h.service.start();

  const shared = await h.service.sharePreview({ port: 5173, threadId: "t1" });
  assert.deepEqual([shared.port, shared.url, shared.threadId], [5173, `https://${NAME}:5173`, "t1"]);
  assert.equal(h.ts.routes.get(5173), "http://127.0.0.1:5173");
  // A dev server listening on ::1 only is served there.
  await h.service.sharePreview({ port: 6000, threadId: null });
  assert.equal(h.ts.routes.get(6000), "http://[::1]:6000");
  // A box project's port is shared through its host forward.
  const boxed = await h.service.sharePreview({ port: 5173, threadId: "t3", projectPath: "/ws/boxed" });
  assert.equal(boxed.port, 45173);

  assert.equal(problemOf(await h.service.sharePreview({ port: 3000, threadId: "t1" }).catch((error: unknown) => error)), "serve-port-taken");
  const silent = await h.service.sharePreview({ port: 4000, threadId: "t1" }).catch((error: unknown) => error);
  assert.match((silent as Error).message, /Nothing listens on port 4000/);
  assert.equal(h.ts.routes.get(3000), "http://127.0.0.1:3000");
  assert.deepEqual(h.service.previews("t1").map((preview) => preview.port), [5173]);

  // Silent for one check (a restart) is fine; silent for two, the share goes.
  h.listening.delete(5173);
  await h.service.check();
  assert.equal(h.ts.routes.has(5173), true);
  const removed = h.nextEvent((payload) => !payload.previews.some((preview) => preview.port === 5173));
  await h.service.check();
  await removed;
  assert.equal(h.ts.routes.has(5173), false);

  // A route someone else replaced is forgotten, not removed.
  await h.service.sharePreview({ port: 5174, threadId: "t2" });
  h.ts.routes.set(5174, "http://127.0.0.1:9999");
  await h.service.check();
  assert.equal(h.ts.routes.get(5174), "http://127.0.0.1:9999");
  assert.ok(!h.service.previews().some((preview) => preview.port === 5174));

  // The chat that shared it closes; its box port names the share too.
  assert.deepEqual((await h.service.stopPreview(5173, { threadId: "t3" })).length, 0);
  assert.equal(h.ts.routes.has(45173), false);
  h.ts.routes.delete(5174);
  await h.service.sharePreview({ port: 5174, threadId: "t4" });
  h.service.chatClosed("t4");
  await h.service.check();
  assert.equal(h.ts.routes.has(5174), false);
  assert.deepEqual(h.service.previews().map((preview) => preview.port), [6000]);
  await assert.rejects(h.service.stopPreview(6000, { threadId: "t1" }), (error: unknown) => error instanceof TailnetError && error.status === 404);
});
