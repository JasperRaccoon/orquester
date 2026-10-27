import assert from "node:assert/strict";
import { test } from "node:test";

import { ProviderHttpError } from "./http.ts";
import { morphAdapter } from "./morph.ts";
import { fixture, replayFetch, replayOptions, testCreateRequest, TEST_BOX_ID } from "./fixtures/vm-replay.ts";

const API = "https://cloud.morph.so/api";
const credentials = { apiKey: "morph_test_key" };
const DIGEST = "orquester-morphvm-minimal-2c-8192m-32768d";
const SNAPSHOTS_BY_DIGEST = `${API}/snapshot?digest=${DIGEST}`;
const INSTANCE = `${API}/instance/morphvm_11111111`;

/** The script the exec writes: the base64 between the printf quotes, decoded. */
function scriptFromExec(body: unknown): string {
  const command = (body as { command: string[] }).command;
  assert.deepEqual(command.slice(0, 2), ["/bin/sh", "-c"]);
  const encoded = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(command[2]!)?.[1];
  assert.ok(encoded, "the exec writes the script from base64");
  return Buffer.from(encoded, "base64").toString("utf8");
}

test("validate: ok with a working key, a message for a bad or missing one", async (t) => {
  const replay = replayFetch([
    { method: "GET", url: `${API}/image`, body: fixture("morph", "images") },
    { method: "GET", url: `${API}/image`, status: 401, body: fixture("morph", "error-unauthorized"), headers: { "content-type": "text/plain" } }
  ]);
  assert.deepEqual(await morphAdapter.validate(credentials, replayOptions(t, replay)), { ok: true });
  assert.equal(replay.requests[0]!.headers.authorization, "Bearer morph_test_key");

  const bad = await morphAdapter.validate({ apiKey: "wrong-key" }, replayOptions(t, replay));
  assert.deepEqual(bad, { ok: false, message: "Morph: unauthorized (check the key and its permissions)" });

  assert.deepEqual(await morphAdapter.validate({ apiKey: " " }, replayOptions(t, replay)), { ok: false, message: "Morph: API key is missing" });
  assert.equal(replay.requests.length, 2);
});

test("offers: balanced sizes priced in MCUs, one region, live images with the minimal image first", async (t) => {
  const replay = replayFetch([{ method: "GET", url: `${API}/image`, body: fixture("morph", "images") }]);
  const offers = await morphAdapter.offers(credentials, "linux", replayOptions(t, replay));
  assert.equal(offers.priceSource, "table");
  assert.deepEqual(
    offers.sizes.map((size) => [size.id, size.vcpu, size.ramGb, size.diskGb, size.hourlyUsd]),
    [
      ["1vcpu-4gb", 1, 4, 16, 0.05],
      ["2vcpu-8gb", 2, 8, 32, 0.1],
      ["4vcpu-16gb", 4, 16, 64, 0.2],
      ["8vcpu-32gb", 8, 32, 128, 0.4],
      ["16vcpu-64gb", 16, 64, 256, 0.8]
    ]
  );
  assert.equal(offers.sizes.every((size) => size.gpu === null && size.regions.length === 0), true);
  assert.deepEqual(offers.regions, [{ id: "default", label: "Morph Cloud", country: null }]);
  assert.deepEqual(offers.images, [
    { id: "morphvm-minimal", label: "Minimal Morph VM" },
    { id: "morphvm-sandbox", label: "morphvm-sandbox" }
  ]);
  await assert.rejects(morphAdapter.offers(credentials, "windows", replayOptions(t, replay)), /does not rent windows/);
});

test("create: base snapshot by digest, one instance start with the marker, the bootstrap started over exec", async (t) => {
  const replay = replayFetch([
    { method: "GET", url: SNAPSHOTS_BY_DIGEST, body: fixture("morph", "snapshots-empty") },
    { method: "POST", url: `${API}/snapshot`, body: fixture("morph", "create-snapshot") },
    { method: "GET", url: `${API}/snapshot/snapshot_11111111`, body: fixture("morph", "snapshot-ready") },
    { method: "POST", url: `${API}/instance`, body: fixture("morph", "instance-pending") },
    { method: "GET", url: INSTANCE, body: fixture("morph", "instance-ready") },
    { method: "POST", url: `${INSTANCE}/exec`, body: fixture("morph", "exec-ok") }
  ]);
  const request = testCreateRequest({ size: "2vcpu-8gb", region: "default" });
  const result = await morphAdapter.create(credentials, request, replayOptions(t, replay));

  assert.deepEqual(replay.requests[1]!.body, {
    image_id: "morphvm-minimal",
    vcpus: 2,
    memory: 8192,
    disk_size: 32768,
    digest: DIGEST,
    metadata: { orquester: "base" }
  });
  assert.deepEqual(replay.requests[3]!.body, {
    snapshot_id: "snapshot_11111111",
    metadata: { "orquester-box": TEST_BOX_ID, name: `orq-${TEST_BOX_ID}` }
  });
  const exec = replay.requests[5]!;
  // The script deletes its own file (it holds the bootstrap token) before anything else.
  assert.equal(scriptFromExec(exec.body), `rm -f "$0"\n${request.bootstrap.posixScript}`);
  const program = (exec.body as { command: string[] }).command[2]!;
  assert.match(program, /setsid nohup \/bin\/sh -c '.*command -v curl.*exec \/bin\/sh "\$0"' "\$f" > .* < \/dev\/null &$/);
  assert.equal(program.includes("orq-bootstrap-posix"), false);

  assert.deepEqual(result.ref, { instanceId: "morphvm_11111111", snapshotId: "snapshot_11111111" });
  assert.equal(result.hourlyUsd, 0.1);
  assert.equal(replay.pending().length, 0);
});

test("create: reuses the ready snapshot of the size and image", async (t) => {
  const replay = replayFetch([
    { method: "GET", url: `${API}/snapshot?digest=orquester-morphvm-sandbox-2c-8192m-32768d`, body: {
      object: "list",
      data: [{ ...fixture<Record<string, unknown>>("morph", "snapshot-ready"), digest: "orquester-morphvm-sandbox-2c-8192m-32768d" }]
    } },
    { method: "POST", url: `${API}/instance`, body: fixture("morph", "instance-ready") },
    { method: "POST", url: `${INSTANCE}/exec`, body: fixture("morph", "exec-ok") }
  ]);
  await morphAdapter.create(credentials, testCreateRequest({ size: "2vcpu-8gb", region: "default", image: "morphvm-sandbox" }), replayOptions(t, replay));
  assert.deepEqual(
    replay.requests.map((entry) => `${entry.method} ${entry.url}`),
    [
      `GET ${API}/snapshot?digest=orquester-morphvm-sandbox-2c-8192m-32768d`,
      `POST ${API}/instance`,
      `POST ${INSTANCE}/exec`
    ]
  );
});

test("create: a failed instance start is never retried and surfaces Morph's message", async (t) => {
  const replay = replayFetch([
    { method: "GET", url: SNAPSHOTS_BY_DIGEST, body: fixture("morph", "snapshots-by-digest") },
    { method: "POST", url: `${API}/instance`, status: 503, body: fixture("morph", "error-unavailable"), times: 2 }
  ]);
  await assert.rejects(morphAdapter.create(credentials, testCreateRequest({ size: "2vcpu-8gb", region: "default" }), replayOptions(t, replay)), (error) => {
    assert.ok(error instanceof ProviderHttpError);
    assert.equal(error.status, 503);
    assert.equal(error.message, "Morph: No capacity available for the requested instance size");
    return true;
  });
  assert.equal(replay.requests.filter((entry) => entry.method === "POST").length, 1);
});

test("create: an instance that errors or a failing bootstrap exec is deleted", async (t) => {
  const errored = replayFetch([
    { method: "GET", url: SNAPSHOTS_BY_DIGEST, body: fixture("morph", "snapshots-by-digest") },
    { method: "POST", url: `${API}/instance`, body: fixture("morph", "instance-pending") },
    { method: "GET", url: INSTANCE, body: { ...fixture<Record<string, unknown>>("morph", "instance-ready"), status: "error" } },
    { method: "DELETE", url: INSTANCE, status: 204 }
  ]);
  await assert.rejects(
    morphAdapter.create(credentials, testCreateRequest({ size: "2vcpu-8gb", region: "default" }), replayOptions(t, errored)),
    /Morph: the instance is error/
  );
  assert.equal(errored.pending().length, 0);

  const failedExec = replayFetch([
    { method: "GET", url: SNAPSHOTS_BY_DIGEST, body: fixture("morph", "snapshots-by-digest") },
    { method: "POST", url: `${API}/instance`, body: fixture("morph", "instance-ready") },
    { method: "POST", url: `${INSTANCE}/exec`, body: { exit_code: 2, stdout: "", stderr: "sh: syntax error near orq-bootstrap-posix" } },
    { method: "DELETE", url: INSTANCE, status: 204 }
  ]);
  await assert.rejects(
    morphAdapter.create(credentials, testCreateRequest({ size: "2vcpu-8gb", region: "default" }), replayOptions(t, failedExec)),
    (error) => {
      assert.equal((error as Error).message, "Morph: starting the bootstrap failed (exit code 2)");
      return true;
    }
  );
  assert.equal(failedExec.pending().length, 0);
});

test("create: rejects an unknown size before any call", async (t) => {
  const replay = replayFetch([]);
  await assert.rejects(morphAdapter.create(credentials, testCreateRequest({ size: "3vcpu-12gb", region: "default" }), replayOptions(t, replay)), /unknown size 3vcpu-12gb/);
  assert.equal(replay.requests.length, 0);
});

test("status: maps instance states, 404 is gone, 429 is retried", async (t) => {
  const ready = fixture<Record<string, unknown>>("morph", "instance-ready");
  const replay = replayFetch([
    { method: "GET", url: INSTANCE, status: 429, headers: { "retry-after": "0" }, body: fixture("morph", "error-rate-limit") },
    { method: "GET", url: INSTANCE, body: ready },
    { method: "GET", url: INSTANCE, body: { ...ready, status: "pending" } },
    { method: "GET", url: INSTANCE, body: { ...ready, status: "paused" } },
    { method: "GET", url: INSTANCE, body: { ...ready, status: "error" } },
    { method: "GET", url: INSTANCE, body: { ...ready, status: "something-new" } },
    { method: "GET", url: INSTANCE, status: 404, body: fixture("morph", "error-not-found") }
  ]);
  const ref = { instanceId: "morphvm_11111111", snapshotId: "snapshot_11111111" };
  assert.deepEqual(await morphAdapter.status(credentials, ref, replayOptions(t, replay)), { state: "running", detail: null, publicIp: null, hourlyUsd: null });
  assert.equal((await morphAdapter.status(credentials, ref, replayOptions(t, replay))).state, "pending");
  const paused = await morphAdapter.status(credentials, ref, replayOptions(t, replay));
  assert.equal(paused.state, "stopped");
  assert.equal(paused.detail, "Morph reports the instance paused");
  assert.equal((await morphAdapter.status(credentials, ref, replayOptions(t, replay))).state, "error");
  // A state the adapter does not know is transient (pending), never a failure that destroys the box.
  assert.equal((await morphAdapter.status(credentials, ref, replayOptions(t, replay))).state, "pending");
  assert.equal((await morphAdapter.status(credentials, ref, replayOptions(t, replay))).state, "gone");
  assert.equal(replay.pending().length, 0);
});

test("destroy: deletes the instance, keeps the shared snapshot, and is idempotent", async (t) => {
  const replay = replayFetch([
    { method: "DELETE", url: INSTANCE, status: 204 },
    { method: "DELETE", url: INSTANCE, status: 404, body: fixture("morph", "error-not-found") }
  ]);
  const ref = { instanceId: "morphvm_11111111", snapshotId: "snapshot_11111111" };
  await morphAdapter.destroy(credentials, ref, replayOptions(t, replay));
  await morphAdapter.destroy(credentials, ref, replayOptions(t, replay));
  assert.equal(replay.pending().length, 0);
  assert.equal(replay.requests.some((entry) => entry.url.includes("/snapshot")), false);
  await assert.rejects(morphAdapter.destroy(credentials, {}, replayOptions(t, replay)), /instance reference has no instanceId/);
});

test("listManaged: instances with the marker metadata or an orq- name", async (t) => {
  const replay = replayFetch([{ method: "GET", url: `${API}/instance`, body: fixture("morph", "instances-managed") }]);
  const managed = await morphAdapter.listManaged(credentials, replayOptions(t, replay));
  assert.deepEqual(managed, [
    {
      ref: { instanceId: "morphvm_11111111", snapshotId: "snapshot_11111111" },
      name: `orq-${TEST_BOX_ID}`,
      boxId: TEST_BOX_ID,
      createdAt: "2026-10-19T23:00:37.000Z",
      state: "running"
    },
    {
      ref: { instanceId: "morphvm_22222222", snapshotId: "snapshot_11111111" },
      name: "orq-ffeeddccbbaa",
      boxId: "ffeeddccbbaa",
      createdAt: "2026-10-19T21:12:00.000Z",
      state: "stopped"
    }
  ]);
});
