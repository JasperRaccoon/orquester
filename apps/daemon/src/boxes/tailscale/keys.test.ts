import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { createTailscaleKeys, policySnippet } from "./keys.ts";

interface Call {
  method: string;
  url: string;
  authorization: string | null;
  body: string | null;
}

/** A fake Tailscale API: answers by "METHOD path" and records every call. */
function fakeApi(t: TestContext, routes: Record<string, (call: Call) => Response>): { calls: Call[] } {
  const calls: Call[] = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? "GET",
      url: url.pathname + url.search,
      authorization: headers.get("authorization"),
      body: typeof init?.body === "string" ? init.body : null
    };
    calls.push(call);
    const route = routes[`${call.method} ${url.pathname}`];
    return route ? route(call) : new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  }) as typeof fetch;
  t.mock.method(globalThis, "fetch", doFetch);
  return { calls };
}

const signal = new AbortController().signal;
// Split so secret scanners do not read the fake key as a real one.
const MINTED_KEY = "tskey-auth-" + "k123-SECRET";

test("mints a single-use, ephemeral, pre-authorized, tagged key with an API token", async (t) => {
  const api = fakeApi(t, {
    "POST /api/v2/tailnet/-/keys": () => Response.json({ id: "k123", key: MINTED_KEY, expires: "2026-10-20T12:05:00Z" })
  });
  const keys = createTailscaleKeys({ credentials: () => ({ apiToken: "tskey-api-TOKEN" }) });
  const key = await keys.mintAuthKey({ boxId: "box-0123456789abcdef0123456789abcdef0123456789", ttlSeconds: 600, signal });
  assert.equal(key, MINTED_KEY);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0]!.authorization, "Bearer tskey-api-TOKEN");
  const body = JSON.parse(api.calls[0]!.body!) as Record<string, unknown>;
  assert.deepEqual(body.capabilities, {
    devices: { create: { reusable: false, ephemeral: true, preauthorized: true, tags: ["tag:orq-box"] } }
  });
  assert.equal(body.expirySeconds, 600);
  assert.ok((body.description as string).startsWith("orq box box-0123"));
  assert.ok((body.description as string).length <= 50);
});

test("an OAuth client gets an access token once and reuses it until it nearly expires", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  let issued = 0;
  const api = fakeApi(t, {
    "POST /api/v2/oauth/token": (call) => {
      issued += 1;
      const form = new URLSearchParams(call.body ?? "");
      assert.equal(form.get("grant_type"), "client_credentials");
      assert.equal(form.get("client_id"), "client-id");
      assert.equal(form.get("client_secret"), "tskey-client-SECRET");
      return Response.json({ access_token: `oauth-${issued}`, expires_in: 3600, token_type: "Bearer" });
    },
    "POST /api/v2/tailnet/-/keys": () => Response.json({ id: "k1", key: "tskey-auth-1" }),
    "DELETE /api/v2/tailnet/-/keys/k1": () => new Response(null, { status: 200 })
  });
  const keys = createTailscaleKeys({
    credentials: () => ({ oauthClientId: "client-id", oauthClientSecret: "tskey-client-SECRET" })
  });
  await keys.mintAuthKey({ boxId: "box-0123456789ab", ttlSeconds: 300, signal });
  await keys.deleteAuthKey({ keyId: "k1", signal });
  assert.equal(issued, 1);
  assert.deepEqual(
    api.calls.filter((call) => !call.url.includes("oauth")).map((call) => call.authorization),
    ["Bearer oauth-1", "Bearer oauth-1"]
  );
  now += 3600_000 - 30_000; // within the refresh margin
  await keys.mintAuthKey({ boxId: "box-0123456789ab", ttlSeconds: 300, signal });
  assert.equal(issued, 2);
  assert.equal(api.calls.at(-1)!.authorization, "Bearer oauth-2");
});

test("removeNode deletes only tagged devices named orq-<boxId>", async (t) => {
  const deleted: string[] = [];
  const api = fakeApi(t, {
    "GET /api/v2/tailnet/-/devices": () =>
      Response.json({
        devices: [
          { id: "1", nodeId: "n1", hostname: "orq-box-0123456789ab", name: "orq-box-0123456789ab.tail1.ts.net", tags: ["tag:orq-box"] },
          { id: "2", nodeId: "n2", hostname: "laptop", name: "orq-box-0123456789ab-1.tail1.ts.net", tags: ["tag:orq-box"] },
          { id: "3", nodeId: "n3", hostname: "orq-box-0123456789ab", name: "orq-box-0123456789ab-2.tail1.ts.net", tags: [] },
          { id: "4", nodeId: "n4", hostname: "orq-box-other0000000", name: "orq-box-other0000000.tail1.ts.net", tags: ["tag:orq-box"] }
        ]
      }),
    "DELETE /api/v2/device/n1": () => {
      deleted.push("n1");
      return new Response(null, { status: 200 });
    }
  });
  const keys = createTailscaleKeys({ credentials: () => ({ apiToken: "tskey-api-TOKEN" }) });
  await keys.removeNode({ boxId: "box-0123456789ab", signal });
  assert.deepEqual(deleted, ["n1"]);
});

test("unconfigured credentials and API errors fail without leaking secrets", async (t) => {
  const unconfigured = createTailscaleKeys({ credentials: () => null });
  await assert.rejects(unconfigured.mintAuthKey({ boxId: "box-0123456789ab", ttlSeconds: 60, signal }), /not configured/);

  const api = fakeApi(t, {
    "GET /api/v2/tailnet/-/keys": () => Response.json({ message: "API token invalid" }, { status: 401 }),
    "POST /api/v2/tailnet/-/keys": () => Response.json({ message: "requested tags [tag:orq-box] are invalid or not permitted" }, { status: 400 })
  });
  const keys = createTailscaleKeys({ credentials: () => ({ apiToken: "tskey-api-" + "SECRET-VALUE" }) });
  const validation = await keys.validate({ signal });
  assert.equal(validation.ok, false);
  await assert.rejects(keys.mintAuthKey({ boxId: "box-0123456789ab", ttlSeconds: 60, signal }), (error: Error) => {
    assert.match(error.message, /tags \[tag:orq-box\] are invalid/);
    assert.ok(!error.message.includes("SECRET"));
    return true;
  });
  // A failed create is not retried (it could leave a second key).
  assert.equal(api.calls.filter((call) => call.method === "POST").length, 1);
});

test("evaluates the tailnet policy", async (t) => {
  const policies = [
    {
      hosts: { "orq-host": "100.80.44.62" },
      tagOwners: { "tag:orq-box": ["autogroup:admin"] },
      grants: [
        { src: ["autogroup:member"], dst: ["*"], ip: ["*"] },
        { src: ["tag:orq-box"], dst: ["orq-host"], ip: ["tcp:8443"] }
      ]
    },
    { tagOwners: { "tag:orq-box": [] }, grants: [{ src: ["*"], dst: ["*"], ip: ["*"] }] },
    { acls: [{ action: "accept", src: ["tag:orq-box"], dst: ["orq-host:8443"] }] },
    {}
  ];
  const api = fakeApi(t, {
    "GET /api/v2/tailnet/-/acl": () => Response.json(policies.shift())
  });
  const keys = createTailscaleKeys({ credentials: () => ({ apiToken: "tskey-api-TOKEN" }) });
  for (const expected of [[true, true, false], [true, false, true], [false, true, false], [false, false, false]]) {
    const check = await keys.checkTailnetPolicy({ signal });
    assert.deepEqual([check.tagOwner, check.boxGrant, check.unrestricted], expected);
  }
  assert.equal(api.calls.length, 4);
});

test("the policy snippet names the alias, IP and ports", () => {
  const snippet = policySnippet("orq-host", [8443, 10000], "100.80.44.62");
  assert.match(snippet, /"orq-host": "100\.80\.44\.62"/);
  assert.match(snippet, /"tag:orq-box": \["autogroup:admin"\]/);
  assert.match(snippet, /\{"src": \["tag:orq-box"\], "dst": \["orq-host"\], "ip": \["tcp:8443", "tcp:10000"\]\}/);
  assert.match(policySnippet("bad alias!", []), /"orq-host": "<this machine's Tailscale IP/);
});
