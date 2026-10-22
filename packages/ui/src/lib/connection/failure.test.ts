import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiError } from "../api-client.ts";
import {
  NotOrquesterError,
  UnexpectedResponseError,
  checkHealth,
  classifyConnectionError,
  redactSecrets,
  redactUrl
} from "./failure.ts";

const kindOf = (error: unknown, online?: boolean) => classifyConnectionError(error, { online, at: 1 }).kind;

/** A Node socket error the way undici's fetch reports it: a TypeError with the code on `cause`. */
const nodeFetchError = (code: string, message = `connect ${code}`) =>
  Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(message), { code }) });

describe("classifyConnectionError", () => {
  it("names the network cause from a system error code", () => {
    assert.equal(kindOf(nodeFetchError("ENOTFOUND")), "dns");
    assert.equal(kindOf(nodeFetchError("EAI_AGAIN")), "dns");
    assert.equal(kindOf(nodeFetchError("ECONNREFUSED")), "refused");
    assert.equal(kindOf(nodeFetchError("ETIMEDOUT")), "timeout");
    assert.equal(kindOf(nodeFetchError("UND_ERR_CONNECT_TIMEOUT")), "timeout");
    assert.equal(kindOf(nodeFetchError("CERT_HAS_EXPIRED")), "tls");
    assert.equal(kindOf(nodeFetchError("DEPTH_ZERO_SELF_SIGNED_CERT")), "tls");
    assert.equal(kindOf(nodeFetchError("ERR_TLS_CERT_ALTNAME_INVALID")), "tls");
    assert.equal(kindOf(nodeFetchError("ECONNRESET")), "unreachable");
  });

  it("names it from the text the desktop bridge and Chromium report", () => {
    const ipc = (inner: string) => new Error(`Error invoking remote method 'orquester:http:request': Error: ${inner}`);
    assert.equal(kindOf(ipc("getaddrinfo ENOTFOUND orq.example.com")), "dns");
    assert.equal(kindOf(ipc("connect ECONNREFUSED 10.0.0.2:7420")), "refused");
    assert.equal(kindOf(ipc("connect ENOENT /home/me/.orquester/daemon.sock")), "refused");
    assert.equal(kindOf(ipc("self-signed certificate")), "tls");
    assert.equal(kindOf(ipc("unable to verify the first certificate")), "tls");
    assert.equal(kindOf(new Error("net::ERR_NAME_NOT_RESOLVED")), "dns");
    assert.equal(kindOf(new Error("net::ERR_CERT_AUTHORITY_INVALID")), "tls");
    assert.equal(kindOf(new Error("connect ETIMEDOUT 1.2.3.4:443")), "timeout");
  });

  it("an opaque browser fetch failure is 'unreachable', or 'offline' without a network", () => {
    assert.equal(kindOf(new TypeError("Failed to fetch")), "unreachable");
    assert.equal(kindOf(new TypeError("NetworkError when attempting to fetch resource.")), "unreachable");
    assert.equal(kindOf(new TypeError("Load failed")), "unreachable");
    assert.equal(kindOf(new TypeError("Failed to fetch"), false), "offline");
    assert.equal(kindOf(new Error("something odd"), false), "offline");
  });

  it("an abort or timeout is a timeout", () => {
    assert.equal(kindOf(Object.assign(new Error("aborted"), { name: "AbortError" })), "timeout");
    assert.equal(kindOf(Object.assign(new Error("timed"), { name: "TimeoutError" })), "timeout");
  });

  it("reads the HTTP status of an answer", () => {
    const api = (status: number) => new ApiError(status, "GET", "/api/info");
    assert.equal(kindOf(api(401)), "unauthorized");
    assert.equal(kindOf(api(429)), "locked");
    assert.equal(kindOf(api(502)), "proxy-down");
    assert.equal(kindOf(api(503)), "proxy-down");
    assert.equal(kindOf(api(404)), "not-orquester");
    assert.equal(kindOf(api(500)), "server-error");
    const failure = classifyConnectionError(api(502));
    assert.equal(failure.status, 502);
  });

  it("a non-JSON or non-Orquester answer is 'not-orquester', unless a proxy says the daemon is down", () => {
    assert.equal(kindOf(new UnexpectedResponseError(200, "text/html")), "not-orquester");
    assert.equal(kindOf(new UnexpectedResponseError(502, "text/html")), "proxy-down");
    assert.equal(kindOf(new NotOrquesterError()), "not-orquester");
    assert.equal(kindOf(new SyntaxError("Unexpected token <")), "not-orquester");
  });

  it("anything else is 'unknown', with its text redacted", () => {
    const failure = classifyConnectionError(new Error("weird Bearer abc.def"), { at: 5 });
    assert.deepEqual(failure, { kind: "unknown", detail: "weird Bearer [redacted]", at: 5 });
  });
});

describe("checkHealth", () => {
  it("accepts an Orquester answer, including one from a daemon that predates the marker", () => {
    assert.deepEqual(checkHealth({ ok: true, service: "orquester", protocol: 1 }), {
      ok: true,
      service: "orquester",
      protocol: 1
    });
    assert.deepEqual(checkHealth({ ok: true }), { ok: true });
  });

  it("refuses anything else", () => {
    for (const value of [null, "ok", {}, { ok: "true" }, { ok: true, service: "nginx" }, []]) {
      assert.throws(() => checkHealth(value), NotOrquesterError, JSON.stringify(value));
    }
  });
});

describe("redaction", () => {
  it("strips every credential shape from text", () => {
    const credential = Buffer.from("mapacho:$2a$12$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ0123").toString("base64");
    const text = [
      `Authorization: Bearer ${credential}`,
      `wss://host/ws?token=${encodeURIComponent(credential)}&x=1`,
      "https://user:hunter2@host/",
      "tskey-auth-k123ABC-xyz",
      "$2a$12$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ0123",
      `raw ${credential}`
    ].join("\n");
    const out = redactSecrets(text, [credential]);
    assert.ok(!out.includes(credential), out);
    assert.ok(!out.includes(encodeURIComponent(credential)), out);
    assert.ok(!out.includes("hunter2"), out);
    assert.ok(!out.includes("k123ABC"), out);
    assert.ok(!out.includes("$2a$12$abc"), out);
    assert.match(out, /token=\[redacted\]&x=1/);
  });

  it("leaves ordinary diagnostics alone", () => {
    const text = "connect ECONNREFUSED 10.0.0.2:7420 at 2026-10-22T10:00:00.000Z";
    assert.equal(redactSecrets(text), text);
  });

  it("drops userinfo, query and fragment from the server URL", () => {
    assert.equal(redactUrl("https://me:pw@orq.example.com:8443/app?token=abc#x"), "https://orq.example.com:8443/app");
    assert.equal(redactUrl("unix:///tmp/orq.sock"), "unix:///tmp/orq.sock");
    assert.equal(redactUrl("not a url?token=abc"), "not a url");
  });
});
