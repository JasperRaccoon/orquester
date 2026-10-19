// Jarvislabs adapter. `server-meta.json` was recorded on 2026-10-20 from the public twin of
// `misc/server_meta` (`general_api/general_server_meta`, same shape); the other fixtures follow the
// official `jarvislabs` SDK source (transport/instances/scripts modules and their test mocks) and the
// backend's OpenAPI spec; the 403 body is what the backend returned without a token. No live account
// was used; ids are made up. Stubbed fetch only.

import assert from "node:assert/strict";
import { test } from "node:test";

import { callOptions, fixture, routedFetch, sampleCreateRequest } from "./gpu-testing.ts";
import { JARVIS_STORAGE_GB, jarvisStartupScript, jarvislabsAdapter, multipartScript } from "./jarvislabs.ts";

const creds = { apiKey: "jl_test" };
const f = (name: string): string => fixture("jarvislabs", name);
const NOIDA = "https://backendn.jarvislabs.net";
const CHENNAI = "https://backendc.jarvislabs.net";

test("jarvislabs: validate reads the balance on the default host; 403 Not authenticated is ok:false", async () => {
  const good = routedFetch([{ path: "/users/balance", replies: [{ body: f("balance.json") }] }]);
  assert.deepEqual(await jarvislabsAdapter.validate(creds, callOptions(good.fetch)), { ok: true });
  assert.equal(new URL(good.seen[0]!.url).origin, NOIDA);
  assert.equal(good.seen[0]!.headers.authorization, "Bearer jl_test");
  const bad = routedFetch([{ path: "/users/balance", replies: [{ status: 403, body: f("not-authenticated.json") }] }]);
  const result = await jarvislabsAdapter.validate(creds, callOptions(bad.fetch));
  assert.equal(result.ok, false);
  assert.match((result as { message: string }).message, /Not authenticated/);
});

test("jarvislabs: offers list container GPUs with free devices, live-priced, per region", async () => {
  const { fetch, seen } = routedFetch([{ path: "/misc/server_meta?workload_type=container", replies: [{ body: f("server-meta.json") }] }]);
  const offers = await jarvislabsAdapter.offers(creds, "linux-gpu", callOptions(fetch));
  assert.equal(new URL(seen[0]!.url).origin, NOIDA);
  assert.equal(offers.priceSource, "live");
  // H100 is VM-only there; L4/H200 have both rows but appear once.
  assert.deepEqual(
    offers.sizes.map((size) => [size.id, size.hourlyUsd, size.regions]),
    [
      ["A30", 0.41, ["india-noida-01"]],
      ["L4", 0.44, ["india-noida-01"]],
      ["A100", 0.89, ["india-noida-01"]],
      ["A100-80GB", 1.49, ["india-noida-01"]],
      ["RTX-PRO6000", 2.19, ["india-chennai-01"]],
      ["H200", 4.59, ["india-noida-01"]]
    ]
  );
  const l4 = offers.sizes[1]!;
  assert.deepEqual(l4.gpu, { model: "L4", count: 1, vramGb: 24 });
  assert.equal(l4.vcpu, 28);
  assert.equal(l4.ramGb, 124);
  assert.equal(l4.diskGb, JARVIS_STORAGE_GB);
  assert.deepEqual(
    offers.regions.map((region) => [region.id, region.country]),
    [
      ["india-chennai-01", "IN"],
      ["india-noida-01", "IN"]
    ]
  );

  const meta = JSON.parse(f("server-meta.json"));
  for (const row of meta.server_meta) if (row.gpu_type === "A30") row.effective_num_free_devices = 0;
  for (const row of meta.server_meta) if (row.gpu_type === "L4") row.price_per_hour = null;
  const changed = routedFetch([{ path: "/misc/server_meta", replies: [{ body: JSON.stringify(meta) }] }]);
  const offers2 = await jarvislabsAdapter.offers(creds, "linux-gpu", callOptions(changed.fetch));
  assert.ok(!offers2.sizes.some((size) => size.id === "A30"), "no free devices");
  assert.equal(offers2.sizes.find((size) => size.id === "L4")!.hourlyUsd, 0.44, "table price");
  assert.equal(offers2.priceSource, "table");
});

test("jarvislabs: create uploads the startup script, finds its id, creates once on the region host", async () => {
  const { fetch, seen } = routedFetch([
    { path: "/misc/server_meta", replies: [{ body: f("server-meta.json") }] },
    { method: "POST", path: "/scripts/add?name=orq-box-0123abcd", replies: [{ body: f("script-added.json") }] },
    { path: "/scripts/", replies: [{ body: f("scripts.json") }] },
    { method: "POST", path: "/templates/pytorch/create", replies: [{ body: f("create.json") }] }
  ]);
  const request = sampleCreateRequest({ size: "RTX-PRO6000", region: "india-chennai-01" });
  const result = await jarvislabsAdapter.create(creds, request, callOptions(fetch));
  const upload = seen.find((call) => call.url.includes("/scripts/add"))!;
  assert.equal(new URL(upload.url).origin, NOIDA);
  assert.match(upload.headers["content-type"]!, /^multipart\/form-data; boundary=----orq[0-9a-f]+$/);
  assert.ok((upload.body as string).includes(jarvisStartupScript(request.bootstrap.posixScript)));
  assert.ok((upload.body as string).includes('name="script"; filename="orq-bootstrap.sh"'));
  const creates = seen.filter((call) => call.url.includes("/templates/pytorch/create"));
  assert.equal(creates.length, 1);
  assert.equal(new URL(creates[0]!.url).origin, CHENNAI);
  assert.deepEqual(creates[0]!.body, {
    gpu_type: "RTX-PRO6000",
    num_gpus: 1,
    hdd: JARVIS_STORAGE_GB,
    region: "india-chennai-01",
    name: "orq-box-0123abcd",
    is_spot: false,
    duration: "hour",
    disk_type: "ssd",
    http_ports: "",
    script_id: "27",
    script_args: "",
    fs_id: null,
    arguments: ""
  });
  assert.deepEqual(result, { ref: { machineId: 314159, region: "india-chennai-01", scriptId: 27, name: "orq-box-0123abcd" }, hourlyUsd: 2.19 });
});

test("jarvislabs: a create answered without machine_id fails and removes the script; long names are cut to 40", async () => {
  const { fetch, seen } = routedFetch([
    { path: "/misc/server_meta", replies: [{ body: f("server-meta.json") }] },
    { method: "POST", path: "/scripts/add", replies: [{ body: f("script-added.json") }] },
    { path: "/scripts/", replies: [{ body: JSON.stringify({ success: true, script_meta: [{ script_id: 31, script_name: "orq-0123456789abcdef0123456789abcdef0123" }] }) }] },
    { method: "POST", path: "/templates/pytorch/create", replies: [{ body: f("create-no-id.json") }] },
    { method: "DELETE", path: "/scripts/?script_id=31", replies: [{ body: f("script-deleted.json") }] }
  ]);
  const boxId = "0123456789abcdef0123456789abcdef0123456789";
  await assert.rejects(
    jarvislabsAdapter.create(creds, sampleCreateRequest({ boxId, size: "L4", region: "india-noida-01" }), callOptions(fetch)),
    /Insufficient balance/
  );
  const create = seen.find((call) => call.url.includes("/templates/pytorch/create"))!;
  assert.equal((create.body as { name: string }).name, "orq-0123456789abcdef0123456789abcdef0123");
  assert.equal(seen.filter((call) => call.method === "DELETE").length, 1);

  const missingScript = routedFetch([
    { path: "/misc/server_meta", replies: [{ body: f("server-meta.json") }] },
    { method: "POST", path: "/scripts/add", replies: [{ body: '{"message":"Script name already exists"}' }] },
    { path: "/scripts/", replies: [{ body: f("scripts-empty.json") }] }
  ]);
  await assert.rejects(
    jarvislabsAdapter.create(creds, sampleCreateRequest({ size: "L4", region: "india-noida-01" }), callOptions(missingScript.fetch)),
    /startup script was not stored \(Script name already exists\)/
  );
  await assert.rejects(
    jarvislabsAdapter.create(creds, sampleCreateRequest({ size: "H100", region: "india-noida-01" }), callOptions(missingScript.fetch)),
    /not offered/
  );
});

test("jarvislabs: status reads users/fetch; success:false (any spelling) means gone", async () => {
  const running = routedFetch([{ path: "/users/fetch/314159", replies: [{ body: f("fetch-one.json") }] }]);
  assert.deepEqual(await jarvislabsAdapter.status(creds, { machineId: 314159 }, callOptions(running.fetch)), {
    state: "running",
    detail: "Running",
    publicIp: null,
    hourlyUsd: null
  });
  const missing = routedFetch([{ path: "/users/fetch/", replies: [{ body: f("fetch-missing.json") }] }]);
  assert.equal((await jarvislabsAdapter.status(creds, { machineId: 1 }, callOptions(missing.fetch))).state, "gone");
  const destroying = routedFetch([{ path: "/users/fetch/", replies: [{ body: f("fetch-destroying.json") }] }]);
  assert.equal((await jarvislabsAdapter.status(creds, { machineId: 1 }, callOptions(destroying.fetch))).state, "gone");
});

test("jarvislabs: destroy on the region host, tolerating gone instances, then deletes the script", async () => {
  const ok = routedFetch([
    { method: "POST", path: "/misc/destroy?machine_id=314159", replies: [{ body: f("destroy.json") }] },
    { method: "DELETE", path: "/scripts/?script_id=27", replies: [{ body: f("script-deleted.json") }] }
  ]);
  await jarvislabsAdapter.destroy(creds, { machineId: 314159, region: "india-chennai-01", scriptId: 27 }, callOptions(ok.fetch));
  assert.equal(new URL(ok.seen[0]!.url).origin, CHENNAI);
  assert.equal(new URL(ok.seen[1]!.url).origin, NOIDA);

  const gone = routedFetch([
    { method: "POST", path: "/misc/destroy", replies: [{ body: f("destroy-error.json") }] },
    { path: "/users/fetch/314159", replies: [{ body: f("fetch-missing.json") }] },
    { path: "/scripts/", replies: [{ body: f("scripts.json") }] },
    { method: "DELETE", path: "/scripts/?script_id=27", replies: [{ status: 404, body: '{"detail":"Not Found"}' }] }
  ]);
  // A reconciler ref: the script is found by the instance name.
  await jarvislabsAdapter.destroy(creds, { machineId: 314159, region: "india-noida-01", name: "orq-box-0123abcd" }, callOptions(gone.fetch));

  const busy = routedFetch([
    { method: "POST", path: "/misc/destroy", replies: [{ body: f("destroy-error.json") }] },
    { path: "/users/fetch/314159", replies: [{ body: f("fetch-one.json") }] }
  ]);
  await assert.rejects(jarvislabsAdapter.destroy(creds, { machineId: 314159, region: "india-noida-01" }, callOptions(busy.fetch)), /Machine is busy/);
});

test("jarvislabs: listManaged keeps orq- names with their region", async () => {
  const { fetch } = routedFetch([{ path: "/users/fetch", replies: [{ body: f("fetch-all.json") }] }]);
  assert.deepEqual(
    (await jarvislabsAdapter.listManaged(creds, callOptions(fetch))).map((instance) => [instance.ref.machineId, instance.ref.region, instance.boxId, instance.state]),
    [
      [314159, "india-noida-01", "box-0123abcd", "running"],
      [161803, "india-chennai-01", "box-99887766", "stopped"]
    ]
  );
});

test("jarvislabs: multipart and startup script helpers; GET 429 is retried", async () => {
  const part = multipartScript("echo hi", "x.sh");
  const boundary = part.contentType.split("boundary=")[1]!;
  assert.ok(part.body.startsWith(`--${boundary}\r\n`));
  assert.ok(part.body.endsWith(`\r\n--${boundary}--\r\n`));
  assert.match(jarvisStartupScript("echo hi"), /^#!\/bin\/bash\nf=\$\(mktemp\)/);
  const { fetch, seen } = routedFetch([
    { path: "/users/balance", replies: [{ status: 429, headers: { "retry-after": "0" }, body: '{"detail":"Too Many Requests"}' }, { body: f("balance.json") }] }
  ]);
  assert.deepEqual(await jarvislabsAdapter.validate(creds, callOptions(fetch)), { ok: true });
  assert.equal(seen.length, 2);
});
