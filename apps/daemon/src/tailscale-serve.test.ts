/**
 * Remote access → Tailscale HTTPS, driven through an injected fake CLI: never
 * the real `tailscale` (state-changing calls must not run on a dev host).
 */

import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { tailscaleServeRoutes } from "@orquester/api";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";
import { testAuthSessions } from "./auth/testing.ts";
import { createServer } from "./index.ts";
import {
  TailscaleCliError,
  TailscaleServe,
  TailscaleServeError,
  localTarget,
  parseServeTarget,
  parseTailscaleStatus,
  stderrDiagnostic,
  type TailscaleCommandResult,
  type TailscaleRunner
} from "./tailscale-serve.ts";

const DNS = "box.tail1234.ts.net";

const statusJson = (patch: Record<string, unknown> = {}, self: Record<string, unknown> = {}) =>
  JSON.stringify({
    BackendState: "Running",
    Self: { DNSName: `${DNS}.`, TailscaleIPs: ["100.101.102.103"], CapMap: { https: null, funnel: null }, ...self },
    ...patch
  });

const serveJson = (proxy: string | null) =>
  proxy === null
    ? "{}"
    : JSON.stringify({ TCP: { "443": { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: proxy } } } } });

const ok = (stdout = ""): TailscaleCommandResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string): TailscaleCommandResult => ({ exitCode: 1, stdout: "", stderr });

/** A scripted CLI: answers by subcommand, records every call, applies serve on/off to its own state. */
function fakeCli(options: {
  status?: TailscaleCommandResult | TailscaleCliError;
  served?: string | null;
  serveOn?: TailscaleCommandResult | TailscaleCliError;
  serveOff?: TailscaleCommandResult;
} = {}) {
  const calls: Array<{ args: string[]; timeoutMs: number }> = [];
  const state = { served: options.served ?? null };
  const run: TailscaleRunner = async (args, timeoutMs) => {
    calls.push({ args: [...args], timeoutMs });
    if (args[0] === "status") {
      if (options.status instanceof TailscaleCliError) throw options.status;
      return options.status ?? ok(statusJson());
    }
    if (args[0] === "serve" && args[1] === "status") return ok(serveJson(state.served));
    if (args[0] === "serve" && args.at(-1) === "off") {
      const result = options.serveOff ?? (state.served ? ok() : fail("error: handler does not exist"));
      if (result.exitCode === 0) state.served = null;
      return result;
    }
    if (args[0] === "serve") {
      if (options.serveOn instanceof TailscaleCliError) throw options.serveOn;
      const result = options.serveOn ?? ok();
      if (result.exitCode === 0) state.served = args.at(-1)!;
      return result;
    }
    throw new Error(`unexpected call ${args.join(" ")}`);
  };
  return { run, calls, state };
}

function controller(cli: ReturnType<typeof fakeCli>, http: { enabled: boolean; host: string; port: number } = { enabled: true, host: "0.0.0.0", port: 7420 }, saved = false) {
  const store = { saved, http: { ...http } };
  const serve = new TailscaleServe({
    run: cli.run,
    http: () => store.http,
    saved: () => store.saved,
    save: async (enabled) => {
      store.saved = enabled;
    }
  });
  return { serve, store };
}

const changing = (calls: Array<{ args: string[] }>) =>
  calls.filter((call) => call.args[0] === "serve" && call.args[1] !== "status").map((call) => call.args.join(" "));

describe("parsing", () => {
  it("reads the MagicDNS name, login state and the https capability", () => {
    assert.deepEqual(parseTailscaleStatus(statusJson()), { backendState: "Running", dnsName: DNS, httpsEnabled: true });
    assert.equal(parseTailscaleStatus(statusJson({}, { CapMap: { funnel: null } }))?.httpsEnabled, false);
    assert.equal(parseTailscaleStatus(statusJson({}, { CapMap: undefined }))?.httpsEnabled, null, "an older CLI without a capability map");
    assert.equal(parseTailscaleStatus(statusJson({ BackendState: "NeedsLogin" }, { DNSName: "" }))?.dnsName, null);
    assert.equal(parseTailscaleStatus("not json"), null);
    assert.equal(parseTailscaleStatus("[]"), null);
  });

  it("reads what HTTPS 443 serves", () => {
    assert.equal(parseServeTarget("{}"), null);
    assert.equal(parseServeTarget(serveJson("http://127.0.0.1:7420")), "http://127.0.0.1:7420");
    assert.equal(parseServeTarget(JSON.stringify({ TCP: { "443": { TCPForward: "127.0.0.1:22" } } })), "tcp://127.0.0.1:22");
    assert.equal(
      parseServeTarget(JSON.stringify({ Web: { [`${DNS}:443`]: { Handlers: { "/": { Path: "/srv" } } } } })),
      "a file path"
    );
    assert.equal(parseServeTarget(JSON.stringify({ Web: { [`${DNS}:8443`]: { Handlers: { "/": { Proxy: "http://x" } } } } })), null);
  });

  it("names stderr failures without echoing them", () => {
    assert.equal(stderrDiagnostic("error: handler does not exist"), "no-existing-handler");
    assert.equal(stderrDiagnostic("Logged out."), "not-logged-in");
    assert.equal(stderrDiagnostic("failed to connect to local tailscaled; it doesn't appear to be running"), "daemon-not-running");
    assert.equal(stderrDiagnostic("Access denied: serve config denied. Use 'sudo tailscale serve'"), "permission-denied");
    assert.equal(stderrDiagnostic("HTTPS cert support is not enabled/configured for your tailnet"), "https-disabled");
    assert.equal(stderrDiagnostic("tskey-auth-abc123 something odd"), "unknown");
  });

  it("proxies to the daemon's listener", () => {
    assert.equal(localTarget("0.0.0.0", 7420), "http://127.0.0.1:7420");
    assert.equal(localTarget("127.0.0.1", 7420), "http://127.0.0.1:7420");
    assert.equal(localTarget("::", 7420), "http://[::1]:7420");
    assert.equal(localTarget("192.168.1.5", 80), "http://192.168.1.5:80");
    assert.equal(localTarget("fd00::5", 80), "http://[fd00::5]:80");
  });
});

describe("TailscaleServe", () => {
  it("reports status read-only, with the ts.net URL", async () => {
    const cli = fakeCli();
    const { serve } = controller(cli);
    assert.deepEqual(await serve.status(), {
      available: true,
      dnsName: DNS,
      httpsEnabled: true,
      enabled: false,
      active: false,
      url: `https://${DNS}/`,
      otherTarget: null,
      problem: null
    });
    assert.deepEqual(changing(cli.calls), []);
    assert.ok(cli.calls.every((call) => call.timeoutMs > 0 && call.timeoutMs <= 10_000), "every call is bounded");
  });

  it("turns serving on and off, saving the choice", async () => {
    const cli = fakeCli();
    const { serve, store } = controller(cli);
    const on = await serve.setEnabled(true);
    assert.equal(on.active, true);
    assert.equal(on.enabled, true);
    assert.equal(store.saved, true);
    assert.deepEqual(changing(cli.calls), ["serve --bg --https=443 http://127.0.0.1:7420"]);

    const off = await serve.setEnabled(false);
    assert.equal(off.active, false);
    assert.equal(store.saved, false);
    assert.deepEqual(changing(cli.calls).at(-1), "serve --https=443 off");
  });

  it("already serving this daemon: on is a no-op, and status says active", async () => {
    const cli = fakeCli({ served: "http://127.0.0.1:7420/" });
    const { serve } = controller(cli);
    assert.equal((await serve.status()).active, true);
    await serve.setEnabled(true);
    assert.deepEqual(changing(cli.calls), []);
  });

  for (const [name, options, code] of [
    ["no CLI", { status: new TailscaleCliError("not-installed") }, "not-installed"],
    ["CLI timeout", { status: new TailscaleCliError("timeout") }, "timeout"],
    ["tailscaled down", { status: fail("failed to connect to local tailscaled; it doesn't appear to be running") }, "daemon-not-running"],
    ["not logged in", { status: ok(statusJson({ BackendState: "NeedsLogin" }, { DNSName: "" })) }, "not-logged-in"],
    ["awaiting approval", { status: ok(statusJson({ BackendState: "NeedsMachineAuth" })) }, "needs-approval"],
    ["tailscale down", { status: ok(statusJson({ BackendState: "Stopped" })) }, "stopped"],
    ["no MagicDNS", { status: ok(statusJson({}, { DNSName: "" })) }, "no-magicdns"],
    ["HTTPS off in the tailnet", { status: ok(statusJson({}, { CapMap: { funnel: null } })) }, "https-disabled"]
  ] as const) {
    it(`refuses with an actionable problem: ${name}`, async () => {
      const cli = fakeCli(options as Parameters<typeof fakeCli>[0]);
      const { serve, store } = controller(cli);
      const status = await serve.status();
      assert.equal(status.problem?.code, code);
      assert.ok(status.problem!.message.length > 20);
      await assert.rejects(serve.setEnabled(true), (error: unknown) => {
        assert.ok(error instanceof TailscaleServeError);
        assert.equal(error.problem.code, code);
        assert.equal(error.statusCode, code === "timeout" ? 504 : 409);
        return true;
      });
      assert.equal(store.saved, false);
      assert.deepEqual(changing(cli.calls), [], "nothing changed");
    });
  }

  it("needs External HTTP access", async () => {
    const cli = fakeCli();
    const { serve } = controller(cli, { enabled: false, host: "127.0.0.1", port: 7420 });
    assert.equal((await serve.status()).problem?.code, "http-disabled");
    await assert.rejects(serve.setEnabled(true), (error: unknown) => error instanceof TailscaleServeError && error.problem.code === "http-disabled");
    assert.deepEqual(changing(cli.calls), []);
  });

  it("never takes over port 443 from another service, nor turns it off", async () => {
    const cli = fakeCli({ served: "http://127.0.0.1:3000" });
    const { serve, store } = controller(cli, undefined, true);
    const status = await serve.status();
    assert.equal(status.otherTarget, "http://127.0.0.1:3000");
    assert.equal(status.problem?.code, "port-in-use");
    assert.match(status.problem!.message, /127\.0\.0\.1:3000/);
    await assert.rejects(serve.setEnabled(true), (error: unknown) => error instanceof TailscaleServeError && error.problem.code === "port-in-use");
    await serve.setEnabled(false);
    assert.equal(store.saved, false);
    await serve.reconcile();
    assert.deepEqual(changing(cli.calls), []);
    assert.equal(cli.state.served, "http://127.0.0.1:3000");
  });

  it("maps a refused serve to its fix, without the CLI's text", async () => {
    const cli = fakeCli({ serveOn: fail("Access denied: serve config denied. tskey-auth-SECRET") });
    const { serve, store } = controller(cli);
    await assert.rejects(serve.setEnabled(true), (error: unknown) => {
      assert.ok(error instanceof TailscaleServeError);
      assert.equal(error.problem.code, "permission-denied");
      assert.match(error.problem.message, /--operator/);
      assert.ok(!error.problem.message.includes("SECRET"));
      return true;
    });
    assert.equal(store.saved, false);
  });

  it("re-points its own mapping when the transport moves to another port", async () => {
    const cli = fakeCli();
    const { serve, store } = controller(cli);
    await serve.setEnabled(true);
    store.http.port = 8080;
    const stale = await serve.status();
    assert.equal(stale.active, false);
    assert.equal(stale.problem, null, "its own old mapping is not 'in use by something else'");
    await serve.reconcile();
    assert.equal(cli.state.served, "http://127.0.0.1:8080");
    assert.equal((await serve.status()).active, true);
  });

  it("reconcile does nothing unless the choice is saved on", async () => {
    const cli = fakeCli();
    const { serve } = controller(cli);
    await serve.reconcile();
    assert.deepEqual(cli.calls, []);
    const saved = controller(cli, undefined, true);
    await saved.serve.reconcile();
    assert.deepEqual(changing(cli.calls), ["serve --bg --https=443 http://127.0.0.1:7420"]);
  });
});

describe("routes", () => {
  type CreateServerArgs = Parameters<typeof createServer>;
  const USERNAME = "admin";
  const PASSWORD_HASH = "$2a$12$0123456789012345678901uFAKEfakeFAKEfakeFAKEfa";

  it("answer only authenticated clients on the remote transport, and toggle there", async () => {
    const root = await mkdtemp(join(tmpdir(), "orq-tailscale-route-"));
    const config = createDefaultDaemonConfig({ env: {} });
    config.transports.http.username = USERNAME;
    config.transports.http.passwordHash = PASSWORD_HASH;
    const cli = fakeCli();
    const { serve } = controller(cli);
    const { authSessions, bearer } = await testAuthSessions();
    const resolved = { daemonDir: root, baseDir: root, workspacesDir: root, workspacesMetaFile: `${root}/workspaces.json`, fsRoot: root, appConfigFile: join(root, "app.json") } as unknown as CreateServerArgs[1];
    const app = createServer(
      config,
      resolved,
      createDefaultClientConfig(`${root}/daemon.sock`),
      createWriteStream("/dev/null"),
      { tailscaleServe: serve, authSessions } as unknown as CreateServerArgs[4],
      { authRequired: true, mode: "remote" }
    );
    try {
      assert.equal((await app.inject({ method: "GET", url: tailscaleServeRoutes.serve })).statusCode, 401);
      assert.equal((await app.inject({ method: "PUT", url: tailscaleServeRoutes.serve, payload: { enabled: true } })).statusCode, 401);
      assert.deepEqual(changing(cli.calls), []);

      const headers = { authorization: bearer };
      const status = await app.inject({ method: "GET", url: tailscaleServeRoutes.serve, headers });
      assert.equal(status.statusCode, 200);
      assert.equal(status.json().url, `https://${DNS}/`);

      assert.equal((await app.inject({ method: "PUT", url: tailscaleServeRoutes.serve, headers, payload: { enabled: "yes" } })).statusCode, 400);
      const on = await app.inject({ method: "PUT", url: tailscaleServeRoutes.serve, headers, payload: { enabled: true } });
      assert.equal(on.statusCode, 200);
      assert.equal(on.json().active, true);
    } finally {
      await app.close();
    }
  });

  it("a refused toggle answers its problem code and message", async () => {
    const root = await mkdtemp(join(tmpdir(), "orq-tailscale-route-"));
    const config = createDefaultDaemonConfig({ env: {} });
    const { serve } = controller(fakeCli({ status: new TailscaleCliError("not-installed") }));
    const resolved = { daemonDir: root, baseDir: root, workspacesDir: root, workspacesMetaFile: `${root}/workspaces.json`, fsRoot: root, appConfigFile: join(root, "app.json") } as unknown as CreateServerArgs[1];
    const app = createServer(
      config,
      resolved,
      createDefaultClientConfig(`${root}/daemon.sock`),
      createWriteStream("/dev/null"),
      { tailscaleServe: serve } as unknown as CreateServerArgs[4],
      { authRequired: false, mode: "local" }
    );
    try {
      const refused = await app.inject({ method: "PUT", url: tailscaleServeRoutes.serve, payload: { enabled: true } });
      assert.equal(refused.statusCode, 409);
      assert.equal(refused.json().code, "not-installed");
      assert.match(refused.json().message, /tailscale\.com\/download/);
    } finally {
      await app.close();
    }
  });
});
