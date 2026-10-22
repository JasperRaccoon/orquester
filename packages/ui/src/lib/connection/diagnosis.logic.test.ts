import assert from "node:assert/strict";
import { describe, it, mock, afterEach } from "node:test";

import type { ConnectionLogState } from "./connection-log.ts";
import {
  RESTART_WINDOW_MS,
  WS_BLOCKED_AFTER,
  connectionDiagnosticsText,
  presentConnectionDiagnosis,
  type ConnectionDiagnosisInput
} from "./diagnosis.logic.ts";
import type { ConnectionFailure } from "./failure.ts";
import { probeHttp, probeWebSocket, type ProbeSocket } from "./probes.ts";

afterEach(() => mock.timers.reset());

const NOW = Date.parse("2026-10-22T10:00:00.000Z");
const WS = "wss://orq.example.com/ws";

const log = (patch: Partial<ConnectionLogState> = {}): ConnectionLogState => ({
  lastFailure: null,
  recent: [],
  serverProtocol: 1,
  serverBuild: "abc1234",
  stoppingAt: null,
  connectedAt: NOW - 600_000,
  ws: {},
  ...patch
});

const failure = (kind: ConnectionFailure["kind"], patch: Partial<ConnectionFailure> = {}): ConnectionFailure => ({
  kind,
  detail: `${kind} detail`,
  at: NOW - 1_000,
  ...patch
});

const input = (patch: Partial<ConnectionDiagnosisInput> = {}): ConnectionDiagnosisInput => ({
  status: "connecting",
  attempt: 2,
  connectionError: null,
  log: log(),
  serverLabel: "vps",
  endpoint: "https://orq.example.com",
  wsUrl: WS,
  runtime: "web",
  sameOrigin: false,
  online: true,
  clientProtocol: 1,
  clientBuild: "abc1234",
  now: NOW,
  ...patch
});

const diagnose = (patch: Partial<ConnectionDiagnosisInput> = {}) => presentConnectionDiagnosis(input(patch));

describe("presentConnectionDiagnosis", () => {
  it("says nothing while healthy or still starting up", () => {
    assert.equal(diagnose({ status: "connected", attempt: 0 }), null);
    assert.equal(diagnose({ status: "connecting", attempt: 0, log: log({ lastFailure: failure("refused") }) }), null);
    assert.equal(diagnose({ status: "connecting", attempt: 3 }), null, "a retry with no failure on record yet");
  });

  it("names each failure with its own headline, steps and action", () => {
    const cases: Array<[ConnectionFailure["kind"], RegExp]> = [
      ["dns", /address could not be found/],
      ["refused", /refused the connection/],
      ["tls", /secure connection to vps failed/i],
      ["timeout", /did not answer in time/],
      ["unreachable", /Can't reach vps/],
      ["proxy-down", /proxy answered 502, but the daemon behind it did not/],
      ["not-orquester", /Something other than Orquester answered/],
      ["server-error", /answered with an error \(HTTP 500\)/],
      ["unauthorized", /Sign in to vps again/],
      ["stalled", /went quiet/]
    ];
    for (const [kind, pattern] of cases) {
      const status = kind === "proxy-down" ? 502 : kind === "server-error" ? 500 : undefined;
      const diagnosis = diagnose({ status: "error", attempt: 0, log: log({ lastFailure: failure(kind, { status }) }) });
      assert.ok(diagnosis, kind);
      assert.equal(diagnosis.kind, kind);
      assert.equal(diagnosis.severity, "error");
      assert.match(diagnosis.headline, pattern, kind);
      assert.ok(diagnosis.steps.length > 0, kind);
      assert.equal(diagnosis.action, kind === "unauthorized" ? "sign-in" : "retry", kind);
    }
  });

  it("TLS points at the certificate and the Tailscale address", () => {
    const diagnosis = diagnose({ log: log({ lastFailure: failure("tls") }) });
    assert.ok(diagnosis?.steps.some((step) => step.includes("certificate")));
    assert.ok(diagnosis?.steps.some((step) => step.includes("Tailscale HTTPS")));
  });

  it("an offline device beats whatever the last failure said", () => {
    assert.equal(diagnose({ online: false, log: log({ lastFailure: failure("dns") }) })?.kind, "offline");
  });

  it("a failure right after the daemon announced a stop is a restart", () => {
    const stoppingAt = NOW - 5_000;
    const restarting = diagnose({ log: log({ stoppingAt, lastFailure: failure("refused", { at: NOW - 4_000 }) }) });
    assert.equal(restarting?.kind, "restarting");
    assert.match(restarting!.headline, /vps is restarting/);
    assert.equal(
      diagnose({ log: log({ stoppingAt, lastFailure: failure("proxy-down", { at: NOW - 3_000, status: 502 }) }) })?.kind,
      "restarting"
    );
    // Too long after the announcement, before it, or explained by a later connect: not a restart.
    assert.equal(
      diagnose({ log: log({ stoppingAt, lastFailure: failure("refused", { at: stoppingAt + RESTART_WINDOW_MS + 1 }) }) })?.kind,
      "refused"
    );
    assert.equal(diagnose({ log: log({ stoppingAt, lastFailure: failure("refused", { at: stoppingAt - 1 }) }) })?.kind, "refused");
    assert.equal(
      diagnose({ log: log({ stoppingAt, connectedAt: stoppingAt + 1, lastFailure: failure("refused", { at: NOW }) }) })?.kind,
      "refused"
    );
    // A refused sign-in is never a restart.
    assert.equal(diagnose({ log: log({ stoppingAt, lastFailure: failure("unauthorized", { at: NOW - 4_000 }) }) })?.kind, "unauthorized");
  });

  it("a web app served by the unreachable server says it stopped answering", () => {
    assert.match(diagnose({ sameOrigin: true, log: log({ lastFailure: failure("unreachable") }) })!.headline, /vps stopped answering/);
  });

  it("the lockout headline is the store's countdown", () => {
    const diagnosis = diagnose({
      status: "error",
      attempt: 0,
      connectionError: "Too many attempts — locked out, retry in 60s.",
      log: log({ lastFailure: failure("locked", { status: 429 }) })
    });
    assert.equal(diagnosis?.headline, "Too many attempts — locked out, retry in 60s.");
  });

  it("warns, while connected, about a protocol mismatch either way", () => {
    const newer = diagnose({ status: "connected", attempt: 0, log: log({ serverProtocol: 2 }) });
    assert.equal(newer?.kind, "client-outdated");
    assert.equal(newer?.severity, "warn");
    assert.equal(newer?.action, "reload");
    assert.equal(diagnose({ status: "connected", attempt: 0, runtime: "desktop", log: log({ serverProtocol: 2 }) })?.action, null);
    const older = diagnose({ status: "connected", attempt: 0, clientProtocol: 2, log: log({ serverProtocol: 1 }) });
    assert.equal(older?.kind, "server-outdated");
    assert.ok(older?.steps.some((step) => step.includes("deploy")));
    assert.equal(diagnose({ status: "connected", attempt: 0, log: log({ serverProtocol: null }) }), null, "an older daemon without a protocol");
  });

  it("warns when HTTP works but the WebSocket keeps closing", () => {
    const ws = (failures: number) => ({ [WS]: { failures, lastOpenAt: null, lastCloseCode: 1006, lastFailureAt: NOW } });
    assert.equal(diagnose({ status: "connected", attempt: 0, log: log({ ws: ws(WS_BLOCKED_AFTER - 1) }) }), null);
    const blocked = diagnose({ status: "connected", attempt: 0, log: log({ ws: ws(WS_BLOCKED_AFTER) }) });
    assert.equal(blocked?.kind, "ws-blocked");
    assert.equal(blocked?.severity, "warn");
    assert.ok(blocked?.facts.some(([label, value]) => label === "WebSocket" && value.includes("1006")));
    // No WebSocket on this transport: nothing to warn about.
    assert.equal(diagnose({ status: "connected", attempt: 0, wsUrl: null, log: log({ ws: ws(9) }) }), null);
  });
});

describe("connectionDiagnosticsText", () => {
  it("reports the server, client, checks and timestamped errors, never a token", () => {
    const credential = Buffer.from("mapacho:$2a$12$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ0123").toString("base64");
    const state = log({
      lastFailure: failure("refused"),
      recent: [
        { ...failure("refused", { detail: `connect ECONNREFUSED (token ${credential})` }), count: 3 },
        { ...failure("unauthorized", { status: 401, at: NOW - 500 }), count: 1 }
      ]
    });
    const text = connectionDiagnosticsText({
      diagnosis: diagnose({ log: state }),
      input: input({ endpoint: `https://me:pw@orq.example.com/?token=${credential}`, log: state }),
      http: { outcome: "failed", summary: "GET /health failed: refused", durationMs: 12.4 },
      ws: { outcome: "skipped", summary: "not used" },
      client: { runtimeLabel: "Web browser", userAgent: "TestAgent/1.0" },
      secrets: [credential]
    });
    assert.ok(!text.includes(credential), text);
    assert.ok(!text.includes("pw@"), text);
    assert.match(text, /^Orquester connection diagnostics$/m);
    assert.match(text, /Server: vps — https:\/\/orq\.example\.com\/$/m);
    assert.match(text, /Client: Web browser, build abc1234, protocol 1/);
    assert.match(text, /User agent: TestAgent\/1\.0/);
    assert.match(text, /HTTP check: FAILED — GET \/health failed: refused \(12 ms\)/);
    assert.match(text, /WebSocket check: SKIPPED — not used/);
    assert.match(text, /2026-10-22T09:59:59\.000Z {2}refused ×3/);
    assert.match(text, /unauthorized HTTP 401/);
    assert.match(text, /Diagnosis: vps refused the connection \[refused\]/);
  });
});

describe("probes", () => {
  it("the HTTP check accepts only an Orquester health answer", async () => {
    assert.equal((await probeHttp(async () => ({ ok: true, service: "orquester", protocol: 1 }))).outcome, "ok");
    const html = await probeHttp(async () => "<html>");
    assert.equal(html.outcome, "failed");
    assert.match(html.summary, /not-orquester/);
    const refused = await probeHttp(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED" } });
    });
    assert.match(refused.summary, /refused/);
  });

  it("the HTTP check gives up after its timeout", async () => {
    const result = await probeHttp(
      (signal) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
      { timeoutMs: 5 }
    );
    assert.equal(result.outcome, "failed");
    assert.match(result.summary, /timeout/);
  });

  class FakeSocket implements ProbeSocket {
    onopen: ((event: unknown) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    closed = false;
    close(): void {
      this.closed = true;
    }
  }

  it("the WebSocket check opens, closes again, and never reports the URL", async () => {
    const socket = new FakeSocket();
    const opened: string[] = [];
    const pending = probeWebSocket(`${WS}?token=secret`, (url) => {
      opened.push(url);
      queueMicrotask(() => socket.onopen?.({}));
      return socket;
    });
    const result = await pending;
    assert.equal(result.outcome, "ok");
    assert.equal(socket.closed, true);
    assert.deepEqual(opened, [`${WS}?token=secret`]);
    assert.ok(!result.summary.includes("secret"));
  });

  it("the WebSocket check reports a close code, a timeout, and skips without a WebSocket", async () => {
    const closing = new FakeSocket();
    const closed = await probeWebSocket(WS, () => {
      queueMicrotask(() => closing.onclose?.({ code: 1006 }));
      return closing;
    });
    assert.equal(closed.outcome, "failed");
    assert.match(closed.summary, /code 1006/);

    mock.timers.enable({ apis: ["setTimeout"] });
    const silent = probeWebSocket(WS, () => new FakeSocket(), { timeoutMs: 1_000 });
    mock.timers.tick(1_000);
    assert.match((await silent).summary, /did not open in time/);

    assert.equal((await probeWebSocket(null, () => new FakeSocket())).outcome, "skipped");
  });
});
