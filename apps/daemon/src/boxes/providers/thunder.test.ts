// Thunder Compute adapter. `unauthorized.json` was recorded from an unauthenticated
// /v1/instances/list on 2026-10-20. The instance-list fixture follows the OpenAPI spec
// and the `tnr` CLI JSON contract (a map keyed by index). Stubbed fetch only.

import assert from "node:assert/strict";
import { test } from "node:test";

import { callOptions, fixture, routedFetch, sampleCreateRequest } from "./gpu-testing.ts";
import { THUNDER_REGION, thunderAdapter } from "./thunder.ts";

const creds = { apiKey: "tnr_test" };
const f = (name: string): string => fixture("thunder", name);

test("thunder: offers no box kinds and refuses create with the reason, without calling the API", async (t) => {
  assert.deepEqual(thunderAdapter.kinds, []);
  assert.match(thunderAdapter.accountNote ?? "", /startup script/);
  assert.match(thunderAdapter.accountNote ?? "", /UVM/);
  const { fetch, seen } = routedFetch([]);
  await assert.rejects(thunderAdapter.create(creds, sampleCreateRequest({ size: "a100xl_x1", region: THUNDER_REGION }), callOptions(t, fetch)), /cannot run a startup script/);
  assert.equal(seen.length, 0);
});

test("thunder: validate lists instances with the bearer token; 401 is ok:false", async (t) => {
  const good = routedFetch([{ path: "/v1/instances/list", replies: [{ body: f("instances.json") }] }]);
  assert.deepEqual(await thunderAdapter.validate(creds, callOptions(t, good.fetch)), { ok: true });
  assert.equal(good.seen[0]!.headers.authorization, "Bearer tnr_test");
  const bad = routedFetch([{ path: "/v1/instances/list", replies: [{ status: 401, body: f("unauthorized.json") }] }]);
  const result = await thunderAdapter.validate(creds, callOptions(t, bad.fetch));
  assert.equal(result.ok, false);
  assert.match((result as { message: string }).message, /Authentication required/);
});

test("thunder: status finds the instance by uuid in the list; missing → gone", async (t) => {
  const { fetch } = routedFetch([{ path: "/v1/instances/list", replies: [{ body: f("instances.json") }] }]);
  assert.deepEqual(await thunderAdapter.status(creds, { uuid: "c3f1a2b4-5d6e-4f70-8a9b-0c1d2e3f4a5b" }, callOptions(t, fetch)), {
    state: "running",
    detail: "RUNNING",
    publicIp: "203.0.113.5",
    hourlyUsd: null
  });
  assert.equal((await thunderAdapter.status(creds, { uuid: "66666666-7777-4888-9999-000000000000" }, callOptions(t, fetch))).state, "pending");
  assert.equal((await thunderAdapter.status(creds, { uuid: "gone" }, callOptions(t, fetch))).state, "gone");
});

test("thunder: destroy deletes by the current index and is idempotent", async (t) => {
  const { fetch, seen } = routedFetch([
    { path: "/v1/instances/list", replies: [{ body: f("instances.json") }, { body: "{}" }] },
    { method: "POST", path: "/v1/instances/2/delete", replies: [{ body: f("deleted.json") }] }
  ]);
  await thunderAdapter.destroy(creds, { uuid: "66666666-7777-4888-9999-000000000000" }, callOptions(t, fetch));
  await thunderAdapter.destroy(creds, { uuid: "66666666-7777-4888-9999-000000000000" }, callOptions(t, fetch));
  assert.deepEqual(
    seen.map((call) => `${call.method} ${new URL(call.url).pathname}`),
    ["GET /v1/instances/list", "POST /v1/instances/2/delete", "GET /v1/instances/list"]
  );
});

test("thunder: listManaged keeps orq- names with uuid and index; 429 is retried", async (t) => {
  const { fetch, seen } = routedFetch([
    {
      path: "/v1/instances/list",
      replies: [{ status: 429, headers: { "retry-after": "0" }, body: '{"error":"rate_limited","message":"Too many requests","code":429}' }, { body: f("instances.json") }]
    }
  ]);
  assert.deepEqual(
    (await thunderAdapter.listManaged(creds, callOptions(t, fetch))).map((instance) => [instance.ref, instance.boxId, instance.state]),
    [
      [{ uuid: "c3f1a2b4-5d6e-4f70-8a9b-0c1d2e3f4a5b", index: "0" }, "box-0123abcd", "running"],
      [{ uuid: "66666666-7777-4888-9999-000000000000", index: "2" }, "box-99887766", "pending"]
    ]
  );
  assert.equal(seen.length, 2);
});
