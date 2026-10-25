import assert from "node:assert/strict";
import test from "node:test";

import type { BoxLocalTailscale } from "@orquester/api";

import { classifyFetchError, fetchFailureMessage, statusFailureMessage, type CheckContext } from "./connection-check.ts";
import { tailscalePolicySnippet } from "./settings.ts";

/** fetch's own shape: `TypeError("fetch failed")` with the socket error as `cause`. */
const fetchFailed = (cause: unknown): Error => new TypeError("fetch failed", { cause });
const sysError = (code: string, message = code): Error => Object.assign(new Error(message), { code });

const LOCAL: BoxLocalTailscale = {
  installed: true,
  running: true,
  dnsName: "my-pc.tail1234.ts.net",
  tailnetIp: "100.64.0.7",
  servePort: 10000,
  serving: false,
  suggestedUrl: "https://my-pc.tail1234.ts.net:10000",
  serveCommand: "tailscale serve --bg --https=10000 http://127.0.0.1:47831"
};
const TAILSCALE: CheckContext = { mode: "tailscale", local: LOCAL, daemonPort: 47831 };
const PUBLIC: CheckContext = { mode: "public-url", local: null, daemonPort: 47831 };

test("classifyFetchError: unwraps nested causes and AggregateErrors", () => {
  const cases: [unknown, string][] = [
    [fetchFailed(sysError("ENOTFOUND", "getaddrinfo ENOTFOUND my-pc.tail1234.ts.net")), "dns"],
    [fetchFailed(sysError("EAI_AGAIN")), "dns"],
    [fetchFailed(Object.assign(new AggregateError([sysError("ECONNREFUSED"), sysError("ECONNREFUSED")]), { code: "ECONNREFUSED" })), "refused"],
    [fetchFailed(new AggregateError([sysError("ECONNREFUSED")])), "refused"],
    [new DOMException("The operation was aborted due to timeout", "TimeoutError"), "timeout"],
    [fetchFailed(sysError("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error")), "timeout"],
    [fetchFailed(sysError("ETIMEDOUT")), "timeout"],
    [fetchFailed(sysError("EHOSTUNREACH")), "timeout"],
    [fetchFailed(sysError("ERR_TLS_CERT_ALTNAME_INVALID", "Hostname/IP does not match certificate's altnames")), "certificate"],
    [fetchFailed(sysError("CERT_HAS_EXPIRED")), "certificate"],
    [fetchFailed(sysError("UNABLE_TO_VERIFY_LEAF_SIGNATURE")), "certificate"],
    [fetchFailed(sysError("DEPTH_ZERO_SELF_SIGNED_CERT")), "certificate"],
    [fetchFailed(sysError("SELF_SIGNED_CERT_IN_CHAIN")), "certificate"],
    [fetchFailed(sysError("ERR_SSL_WRONG_VERSION_NUMBER")), "certificate"],
    [fetchFailed(new Error("unable to get local issuer certificate")), "certificate"],
    [fetchFailed(sysError("ECONNRESET", "read ECONNRESET")), "reset"],
    [fetchFailed(new Error("socket hang up")), "reset"],
    [fetchFailed(new Error("something odd")), "other"],
    // Deeper nesting still classifies.
    [fetchFailed(new Error("wrapper", { cause: sysError("ENOTFOUND") })), "dns"]
  ];
  for (const [error, kind] of cases) assert.equal(classifyFetchError(error).kind, kind, String((error as Error).message));
});

test("Tailscale failures name the failed endpoint and the working setup command or URL", () => {
  const url = "https://my-pc.tail1234.ts.net";
  const failed = fetchFailureMessage(url, fetchFailed(sysError("ERR_TLS_CERT_ALTNAME_INVALID")), TAILSCALE);
  assert.ok(failed.includes("my-pc.tail1234.ts.net:443"));
  assert.ok(failed.includes("tailscale serve --bg --https=10000 http://127.0.0.1:47831"));
  const serving: CheckContext = { ...TAILSCALE, local: { ...LOCAL, serving: true } };
  assert.ok(fetchFailureMessage(url, fetchFailed(sysError("ECONNREFUSED")), serving).includes("https://my-pc.tail1234.ts.net:10000"));
  assert.doesNotMatch(fetchFailureMessage("https://my-pc.tail1234.ts.net:10000", fetchFailed(sysError("ECONNRESET")), serving), /tailscale serve/);
});

test("public URL failures identify the daemon's reverse-proxy target and HTTP status", () => {
  const url = "https://orq.example.com";
  assert.ok(fetchFailureMessage(url, fetchFailed(sysError("ECONNREFUSED")), PUBLIC).includes("127.0.0.1:47831"));
  const status = statusFailureMessage(url, 502, PUBLIC);
  assert.ok(status.includes("502") && status.includes("127.0.0.1:47831"));
});

test("tailscalePolicySnippet: the real Tailscale IP and the configured or serve port", () => {
  const known = tailscalePolicySnippet("https://my-pc.tail1234.ts.net:8443", LOCAL);
  assert.match(known, /"dst": \["100\.64\.0\.7"\], "ip": \["tcp:8443"\]/);
  assert.ok(!known.includes("<daemon-tailscale-ip>"));
  assert.match(tailscalePolicySnippet(null, LOCAL), /"tcp:10000"/);
  assert.match(tailscalePolicySnippet(null, { ...LOCAL, servePort: 10001 }), /"tcp:10001"/);
  assert.match(tailscalePolicySnippet("https://my-pc.tail1234.ts.net", null), /"tcp:443"/);
  const unknown = tailscalePolicySnippet(null);
  assert.match(unknown, /"dst": \["<daemon-tailscale-ip>"\], "ip": \["tcp:10000"\]/);
  assert.match(unknown, /Replace <daemon-tailscale-ip>/);
});
