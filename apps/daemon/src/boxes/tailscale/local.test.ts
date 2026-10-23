import assert from "node:assert/strict";
import test from "node:test";

import {
  createLocalTailscale,
  parseServeStatus,
  parseTailscaleStatus,
  serveTarget,
  type CommandRunner,
  type RunResult
} from "./local.ts";

// Shapes as `tailscale status --json` / `tailscale serve status --json` (1.102) print them, trimmed.
const STATUS_RUNNING = JSON.stringify({
  BackendState: "Running",
  TailscaleIPs: ["100.80.44.62", "fd7a:115c:a1e0::8835:2c3f"],
  Self: { DNSName: "ryzen7700.taila64f1b.ts.net.", HostName: "ryzen7700", TailscaleIPs: ["fd7a:115c:a1e0::8835:2c3f", "100.80.44.62"] },
  MagicDNSSuffix: "taila64f1b.ts.net"
});
const STATUS_STOPPED = JSON.stringify({ BackendState: "Stopped", Self: { DNSName: "ryzen7700.taila64f1b.ts.net.", TailscaleIPs: [] } });
const SERVE_DAEMON = JSON.stringify({
  TCP: { "10000": { HTTPS: true } },
  Web: { "ryzen7700.taila64f1b.ts.net:10000": { Handlers: { "/": { Proxy: "http://127.0.0.1:47831" } } } }
});
const SERVE_OTHER = JSON.stringify({
  TCP: { "10000": { HTTPS: true } },
  Web: { "ryzen7700.taila64f1b.ts.net:10000": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } }
});
const DAEMON = { host: "127.0.0.1", port: 47831 };
const NAME = "ryzen7700.taila64f1b.ts.net";

class FakeRunner {
  calls: string[] = [];
  constructor(private readonly answer: (line: string) => RunResult | Error) {}
  run: CommandRunner = async (file, args) => {
    const line = [file, ...args].join(" ");
    this.calls.push(line);
    const result = this.answer(line);
    if (result instanceof Error) throw result;
    return result;
  };
}

const ok = (stdout: string): RunResult => ({ stdout, stderr: "" });
const failed = (stderr: string, extra: Record<string, unknown> = {}): Error => Object.assign(new Error(`Command failed: tailscale\n${stderr}`), { code: 1, stderr, stdout: "" }, extra);
const notFound = (): Error => Object.assign(new Error("spawn tailscale ENOENT"), { code: "ENOENT" });

test("parseTailscaleStatus: state, DNS name without the trailing dot, first IPv4", () => {
  assert.deepEqual(parseTailscaleStatus(STATUS_RUNNING), { running: true, dnsName: NAME, tailnetIp: "100.80.44.62" });
  assert.deepEqual(parseTailscaleStatus(STATUS_STOPPED), { running: false, dnsName: NAME, tailnetIp: null });
  assert.deepEqual(parseTailscaleStatus(JSON.stringify({ BackendState: "Running", Self: { DNSName: "" } })), { running: true, dnsName: null, tailnetIp: null });
  assert.deepEqual(parseTailscaleStatus("not json"), { running: false, dnsName: null, tailnetIp: null });
});

test("parseServeStatus: finds the port proxied to the daemon, not one serving another target", () => {
  assert.deepEqual(parseServeStatus(SERVE_DAEMON, NAME, DAEMON), { daemonPorts: [10000], usedPorts: [10000] });
  assert.deepEqual(parseServeStatus(SERVE_OTHER, NAME, DAEMON).daemonPorts, []);
  assert.deepEqual(parseServeStatus(SERVE_OTHER, NAME, DAEMON).usedPorts, [10000]);
  assert.deepEqual(parseServeStatus("{}", NAME, DAEMON), { daemonPorts: [], usedPorts: [] });
  // Short proxy forms, another machine name, and a TLS-terminated TCP forward.
  const short = JSON.stringify({ Web: { [`${NAME}:443`]: { Handlers: { "/": { Proxy: "localhost:47831" } } } } });
  assert.deepEqual(parseServeStatus(short, NAME, DAEMON).daemonPorts, [443]);
  const otherName = JSON.stringify({ Web: { "other.taila64f1b.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:47831" } } } } });
  assert.deepEqual(parseServeStatus(otherName, NAME, DAEMON).daemonPorts, []);
  const tcp = JSON.stringify({ TCP: { "8443": { TCPForward: "127.0.0.1:47831", TerminateTLS: NAME } } });
  assert.deepEqual(parseServeStatus(tcp, NAME, DAEMON).daemonPorts, [8443]);
  // A daemon bound to its LAN address is not reached through loopback.
  assert.deepEqual(parseServeStatus(SERVE_DAEMON, NAME, { host: "192.168.1.5", port: 47831 }).daemonPorts, []);
});

test("serveTarget: loopback for loopback and wildcard binds, else the bound host", () => {
  assert.equal(serveTarget(DAEMON), "http://127.0.0.1:47831");
  assert.equal(serveTarget({ host: "0.0.0.0", port: 9000 }), "http://127.0.0.1:9000");
  assert.equal(serveTarget({ host: "192.168.1.5", port: 9000 }), "http://192.168.1.5:9000");
  assert.equal(serveTarget({ host: "fd00::5", port: 9000 }), "http://[fd00::5]:9000");
});

test("state: not installed", async () => {
  const runner = new FakeRunner(() => notFound());
  const local = createLocalTailscale({ daemonHttp: () => DAEMON, run: runner.run });
  const state = await local.state();
  assert.equal(state.installed, false);
  assert.equal(state.running, false);
  assert.equal(state.serveCommand, null);
  assert.equal(state.suggestedUrl, null);
});

test("state: installed but stopped, or tailscaled down", async () => {
  const stopped = createLocalTailscale({ daemonHttp: () => DAEMON, run: new FakeRunner(() => ok(STATUS_STOPPED)).run });
  const state = await stopped.state();
  assert.equal(state.installed, true);
  assert.equal(state.running, false);
  assert.equal(state.serving, false);
  assert.equal(state.serveCommand, "tailscale serve --bg --https=10000 http://127.0.0.1:47831");

  const down = createLocalTailscale({
    daemonHttp: () => DAEMON,
    run: new FakeRunner(() => failed("failed to connect to local tailscaled; it doesn't appear to be running")).run
  });
  assert.deepEqual([(await down.state()).installed, (await down.state()).running], [true, false]);
});

test("state: serving the daemon, cached until fresh is asked", async () => {
  let now = 0;
  const runner = new FakeRunner((line) => (line === "tailscale status --json" ? ok(STATUS_RUNNING) : ok(SERVE_DAEMON)));
  const local = createLocalTailscale({ daemonHttp: () => DAEMON, run: runner.run, now: () => now });
  assert.equal(local.cached(), null);
  const state = await local.state();
  assert.deepEqual(state, {
    installed: true,
    running: true,
    dnsName: NAME,
    tailnetIp: "100.80.44.62",
    servePort: 10000,
    serving: true,
    suggestedUrl: `https://${NAME}:10000`,
    serveCommand: "tailscale serve --bg --https=10000 http://127.0.0.1:47831"
  });
  assert.deepEqual(local.cached(), state);
  now = 1_000;
  await local.state();
  assert.equal(runner.calls.length, 2);
  await local.state({ fresh: true });
  assert.equal(runner.calls.length, 4);
});

test("state: port 10000 serving another target is left alone; the next free port is suggested", async () => {
  const runner = new FakeRunner((line) => (line === "tailscale status --json" ? ok(STATUS_RUNNING) : ok(SERVE_OTHER)));
  const state = await createLocalTailscale({ daemonHttp: () => DAEMON, run: runner.run }).state();
  assert.equal(state.serving, false);
  assert.equal(state.servePort, 10001);
  assert.equal(state.suggestedUrl, `https://${NAME}:10001`);
  assert.equal(state.serveCommand, "tailscale serve --bg --https=10001 http://127.0.0.1:47831");
});

test("serve: runs tailscale serve without sudo when allowed", async () => {
  const runner = new FakeRunner(() => ok(""));
  const result = await createLocalTailscale({ daemonHttp: () => DAEMON, run: runner.run }).serve(10000);
  assert.deepEqual(result, { ok: true, port: 10000, sudo: false });
  assert.deepEqual(runner.calls, ["tailscale serve --bg --https=10000 http://127.0.0.1:47831"]);
});

test("serve: a permission refusal retries once through passwordless sudo", async () => {
  const runner = new FakeRunner((line) => (line.startsWith("tailscale serve") ? failed("Access denied: serve config denied") : ok("")));
  const result = await createLocalTailscale({ daemonHttp: () => DAEMON, run: runner.run }).serve(10000);
  assert.deepEqual(result, { ok: true, port: 10000, sudo: true });
  assert.deepEqual(runner.calls, [
    "tailscale serve --bg --https=10000 http://127.0.0.1:47831",
    "sudo -n true",
    "sudo -n tailscale serve --bg --https=10000 http://127.0.0.1:47831"
  ]);
});

test("serve: without sudo, the permission refusal names both remedies", async () => {
  const runner = new FakeRunner((line) =>
    line.startsWith("sudo") ? failed("sudo: a password is required") : failed("Access denied: serve config denied. Use 'sudo tailscale set --operator=$USER'")
  );
  const result = await createLocalTailscale({ daemonHttp: () => DAEMON, run: runner.run, user: () => "orquester" }).serve(10000);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason === "permission");
  assert.deepEqual(result.commands, ["sudo tailscale set --operator=orquester", "sudo tailscale serve --bg --https=10000 http://127.0.0.1:47831"]);
  assert.match(result.message, /sudo tailscale set --operator=orquester/);
  assert.match(result.message, /sudo tailscale serve --bg --https=10000 http:\/\/127\.0\.0\.1:47831/);
  assert.deepEqual(runner.calls, ["tailscale serve --bg --https=10000 http://127.0.0.1:47831", "sudo -n true"]);
});

test("serve: another failure is reported with Tailscale's line and link", async () => {
  const runner = new FakeRunner(() => failed("Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc\n"));
  const result = await createLocalTailscale({ daemonHttp: () => DAEMON, run: runner.run }).serve(10000);
  assert.deepEqual(result, { ok: false, reason: "failed", message: "Serve is not enabled on your tailnet. https://login.tailscale.com/f/serve?node=abc" });
  assert.equal(runner.calls.length, 1);
});
