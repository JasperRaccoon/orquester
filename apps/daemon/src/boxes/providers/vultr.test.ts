import assert from "node:assert/strict";
import { test } from "node:test";

import { ProviderHttpError } from "./http.ts";
import { fixture, replayFetch, replayOptions, testBootstrap, testCreateRequest, TEST_BOX_ID } from "./fixtures/vm-replay.ts";
import { HOURS_PER_MONTH, roundUsd, VULTR_WINDOWS_LICENCE_USD_PER_VCPU_MONTH } from "./price-tables.ts";
import { vultrAdapter, vultrWindowsBootScript } from "./vultr.ts";

const API = "https://api.vultr.com/v2";
const credentials = { apiKey: "vultr-test-key" };
const INSTANCE_ID = "11111111-2222-4333-8444-555555555555";
const SCRIPT_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const instanceUrl = `${API}/instances/${INSTANCE_ID}`;

function readRoutes() {
  return [
    { method: "GET", url: `${API}/plans?per_page=500`, body: fixture("vultr", "plans") },
    { method: "GET", url: `${API}/regions?per_page=500`, body: fixture("vultr", "regions") },
    { method: "GET", url: `${API}/os?per_page=500`, body: fixture("vultr", "os") }
  ];
}

test("validate: ok with a working key, the provider's message for a bad one", async () => {
  const replay = replayFetch([
    { method: "GET", url: `${API}/instances?per_page=1`, body: fixture("vultr", "instances-empty") },
    { method: "GET", url: `${API}/instances?per_page=1`, status: 401, body: fixture("vultr", "error-unauthorized") }
  ]);
  assert.deepEqual(await vultrAdapter.validate(credentials, replayOptions(replay)), { ok: true });
  assert.equal(replay.requests[0]!.headers.authorization, "Bearer vultr-test-key");
  const bad = await vultrAdapter.validate({ apiKey: "nope" }, replayOptions(replay));
  assert.deepEqual(bad, { ok: false, message: "Vultr: Invalid API token. (check the key and its permissions)" });
  assert.deepEqual(await vultrAdapter.validate({ apiKey: "  " }, replayOptions(replay)), { ok: false, message: "Vultr: API key is missing" });
});

test("offers linux: live plan prices, no GPU, IPv6-only or sub-1 GB plans", async () => {
  const replay = replayFetch(readRoutes());
  const offers = await vultrAdapter.offers(credentials, "linux", replayOptions(replay));
  assert.equal(offers.priceSource, "live");
  assert.deepEqual(
    offers.sizes.map((size) => size.id),
    ["vc2-1c-1gb", "vhf-1c-1gb", "vc2-1c-2gb", "vc2-2c-4gb", "vhp-2c-4gb-amd"]
  );
  const small = offers.sizes[0]!;
  assert.deepEqual(small, {
    id: "vc2-1c-1gb",
    label: "vc2-1c-1gb — 1 vCPU, 1 GB",
    vcpu: 1,
    ramGb: 1,
    diskGb: 25,
    gpu: null,
    hourlyUsd: 0.007,
    regions: ["ewr", "ams", "fra", "nrt"]
  });
  // Only regions some offered plan can use (Honolulu has none of them).
  assert.deepEqual(
    offers.regions.map((region) => region.id),
    ["ams", "ewr", "fra", "nrt"]
  );
  assert.deepEqual(offers.regions[1], { id: "ewr", label: "New Jersey (ewr)", country: "US" });
  // Ubuntu 24.04 first; LTS and Debian only (no interim 26.10, no Fedora).
  assert.deepEqual(
    offers.images.map((image) => image.label),
    ["Ubuntu 24.04 LTS x64", "Ubuntu 26.04 LTS x64", "Ubuntu 22.04 LTS x64", "Debian 13 x64 (trixie)", "Debian 12 x64 (bookworm)"]
  );
  assert.equal(offers.images[0]!.id, "2284");
});

test("offers windows: 2 GB minimum and the per-vCPU licence fee from the price table", async () => {
  const replay = replayFetch(readRoutes());
  const offers = await vultrAdapter.offers(credentials, "windows", replayOptions(replay));
  assert.equal(offers.priceSource, "table");
  assert.deepEqual(
    offers.sizes.map((size) => size.id),
    ["vc2-1c-2gb", "vc2-2c-4gb", "vhp-2c-4gb-amd"]
  );
  const twoCore = offers.sizes.find((size) => size.id === "vc2-2c-4gb")!;
  assert.equal(twoCore.hourlyUsd, roundUsd(0.027 + (2 * VULTR_WINDOWS_LICENCE_USD_PER_VCPU_MONTH) / HOURS_PER_MONTH));
  assert.equal(offers.images[0]!.label, "Windows 2022 Standard x64");
  assert.ok(offers.images.every((image) => image.label.startsWith("Windows")));
  await assert.rejects(vultrAdapter.offers(credentials, "linux-gpu", replayOptions(replayFetch([]))), /does not rent linux-gpu/);
});

test("create linux: tags, label, base64 cloud-init, one POST", async () => {
  const replay = replayFetch([
    { method: "GET", url: `${API}/os?per_page=500`, body: fixture("vultr", "os") },
    { method: "GET", url: `${API}/plans?per_page=500`, body: fixture("vultr", "plans") },
    { method: "POST", url: `${API}/instances`, status: 202, body: fixture("vultr", "create-instance") }
  ]);
  const request = testCreateRequest({ size: "vc2-1c-1gb", region: "ewr" });
  const result = await vultrAdapter.create(credentials, request, replayOptions(replay));
  const post = replay.requests.find((entry) => entry.method === "POST")!;
  const body = post.body as Record<string, unknown>;
  assert.deepEqual({ ...body, user_data: undefined }, {
    region: "ewr",
    plan: "vc2-1c-1gb",
    os_id: 2284,
    label: `orq-${TEST_BOX_ID}`,
    hostname: `orq-${TEST_BOX_ID}`,
    tags: ["orquester-box", `orquester-box=${TEST_BOX_ID}`],
    enable_ipv6: true,
    backups: "disabled",
    activation_email: false,
    user_data: undefined
  });
  assert.equal(Buffer.from(body.user_data as string, "base64").toString("utf8"), testBootstrap().cloudInit);
  assert.deepEqual(result, { ref: { instanceId: INSTANCE_ID }, hourlyUsd: 0.007 });
});

test("create windows: a boot script carrying the PowerShell bootstrap, the Administrator password kept", async () => {
  const replay = replayFetch([
    { method: "GET", url: `${API}/plans?per_page=500`, body: fixture("vultr", "plans") },
    { method: "POST", url: `${API}/startup-scripts`, status: 201, body: fixture("vultr", "create-startup-script") },
    { method: "POST", url: `${API}/instances`, status: 202, body: fixture("vultr", "create-instance-windows") }
  ]);
  const request = testCreateRequest({ kind: "windows", size: "vc2-2c-4gb", region: "ewr", image: "501" });
  const result = await vultrAdapter.create(credentials, request, replayOptions(replay));

  const [scriptPost, instancePost] = replay.requests.filter((entry) => entry.method === "POST");
  const script = scriptPost!.body as { name: string; type: string; script: string };
  assert.equal(script.name, `orq-${TEST_BOX_ID}`);
  assert.equal(script.type, "boot");
  const decoded = Buffer.from(script.script, "base64").toString("utf8");
  assert.equal(decoded, vultrWindowsBootScript(request.bootstrap));
  assert.ok(decoded.endsWith(`#ORQ-POWERSHELL-BEGIN\r\n${request.bootstrap.powershellScript}`));

  const body = instancePost!.body as Record<string, unknown>;
  assert.equal(body.os_id, 501);
  assert.equal(body.script_id, SCRIPT_ID);
  assert.equal(body.user_data, undefined);
  assert.equal(body.hostname, `orq-${TEST_BOX_ID}`.slice(0, 15));
  assert.deepEqual(result.ref, { instanceId: INSTANCE_ID, startupScriptId: SCRIPT_ID });
  assert.equal(result.windowsPassword, "REDACTED");
  assert.equal(result.hourlyUsd, roundUsd(0.027 + 32 / HOURS_PER_MONTH));
});

test("create windows: the boot script is removed when the instance create fails, and the create is not retried", async () => {
  const replay = replayFetch([
    { method: "GET", url: `${API}/plans?per_page=500`, body: fixture("vultr", "plans") },
    { method: "POST", url: `${API}/startup-scripts`, status: 201, body: fixture("vultr", "create-startup-script") },
    { method: "POST", url: `${API}/instances`, status: 500, body: { error: "Server add failed: plan not available in region", status: 500 }, times: 2 },
    { method: "DELETE", url: `${API}/startup-scripts/${SCRIPT_ID}`, status: 204 }
  ]);
  const request = testCreateRequest({ kind: "windows", size: "vc2-2c-4gb", region: "ewr", image: "501" });
  await assert.rejects(vultrAdapter.create(credentials, request, replayOptions(replay)), (error) => {
    assert.ok(error instanceof ProviderHttpError);
    assert.equal(error.message, "Vultr: Server add failed: plan not available in region");
    return true;
  });
  assert.equal(replay.requests.filter((entry) => entry.method === "POST" && entry.url.endsWith("/instances")).length, 1);
  assert.equal(replay.pending().length, 1, "the second create answer was never needed");
});

test("vultrWindowsBootScript: cmd hands the rest of the file to PowerShell untouched", () => {
  const bootstrap = { ...testBootstrap(), powershellScript: "$x = '100%'; Write-Output \"a & b | c\"\n" };
  const script = vultrWindowsBootScript(bootstrap);
  const lines = script.split("\r\n");
  assert.equal(lines[0], "@echo off");
  assert.match(lines[1]!, /^powershell\.exe -NoProfile -ExecutionPolicy Bypass -Command "/);
  // Only one literal marker line: the command builds its marker from pieces.
  assert.equal(script.split("#ORQ-POWERSHELL-BEGIN").length, 2);
  assert.equal(lines[2], "exit /b %ERRORLEVEL%");
  assert.equal(script.slice(script.indexOf("#ORQ-POWERSHELL-BEGIN") + "#ORQ-POWERSHELL-BEGIN".length), `\r\n${bootstrap.powershellScript}`);
});

test("status: installing reads as pending, 404 as gone, 429 retried", async () => {
  const replay = replayFetch([
    { method: "GET", url: instanceUrl, body: fixture("vultr", "instance-installing") },
    { method: "GET", url: instanceUrl, status: 429, headers: { "retry-after": "0" }, body: { error: "Rate limit reached", status: 429 } },
    { method: "GET", url: instanceUrl, body: fixture("vultr", "instance-running") },
    { method: "GET", url: instanceUrl, status: 404, body: fixture("vultr", "error-not-found") }
  ]);
  const ref = { instanceId: INSTANCE_ID };
  const installing = await vultrAdapter.status(credentials, ref, replayOptions(replay));
  assert.equal(installing.state, "pending");
  assert.deepEqual(await vultrAdapter.status(credentials, ref, replayOptions(replay)), {
    state: "running",
    detail: null,
    publicIp: "203.0.113.20",
    hourlyUsd: null
  });
  const gone = await vultrAdapter.status(credentials, ref, replayOptions(replay));
  assert.equal(gone.state, "gone");
});

test("status: a stopped or suspended instance reads as stopped", async () => {
  const running = fixture<{ instance: Record<string, unknown> }>("vultr", "instance-running");
  const replay = replayFetch([
    { method: "GET", url: instanceUrl, body: { instance: { ...running.instance, power_status: "stopped" } } },
    { method: "GET", url: instanceUrl, body: { instance: { ...running.instance, status: "suspended" } } },
    { method: "GET", url: instanceUrl, body: { instance: { ...running.instance, status: "something-new" } } }
  ]);
  const ref = { instanceId: INSTANCE_ID };
  const stopped = await vultrAdapter.status(credentials, ref, replayOptions(replay));
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.detail, "Vultr reports the instance active, power stopped");
  assert.equal((await vultrAdapter.status(credentials, ref, replayOptions(replay))).state, "stopped");
  // A state the adapter does not know is transient (pending), never a failure that destroys the box.
  assert.equal((await vultrAdapter.status(credentials, ref, replayOptions(replay))).state, "pending");
});

test("destroy: deletes the instance and its boot script, idempotently", async () => {
  const replay = replayFetch([
    { method: "DELETE", url: instanceUrl, status: 204 },
    { method: "DELETE", url: `${API}/startup-scripts/${SCRIPT_ID}`, status: 204 },
    { method: "DELETE", url: instanceUrl, status: 404, body: fixture("vultr", "error-not-found") },
    { method: "DELETE", url: `${API}/startup-scripts/${SCRIPT_ID}`, status: 404, body: { error: "Startup script not found", status: 404 } }
  ]);
  const ref = { instanceId: INSTANCE_ID, startupScriptId: SCRIPT_ID };
  await vultrAdapter.destroy(credentials, ref, replayOptions(replay));
  await vultrAdapter.destroy(credentials, ref, replayOptions(replay));
  assert.equal(replay.pending().length, 0);
});

test("listManaged: tagged or orq- labelled instances, with the boot script of Windows boxes", async () => {
  const managed = fixture<{ instances: Array<Record<string, unknown>>; meta: unknown }>("vultr", "instances-managed");
  const tagged = managed.instances[0]!;
  const windows = { ...tagged, id: "22222222-3333-4444-8555-666666666666", label: "orq-ffeeddccbbaa", tags: [], os: "Windows 2022 Standard x64" };
  const foreign = { ...tagged, id: "33333333-4444-4555-8666-777777777777", label: "my-own-server", tags: ["web"] };
  const replay = replayFetch([
    {
      method: "GET",
      url: `${API}/instances?per_page=500`,
      body: { instances: [tagged, windows], meta: { total: 3, links: { next: "cursor-2", prev: "" } } }
    },
    { method: "GET", url: `${API}/instances?per_page=500&cursor=cursor-2`, body: { instances: [foreign], meta: { total: 3, links: { next: "", prev: "" } } } },
    {
      method: "GET",
      url: `${API}/startup-scripts?per_page=500`,
      body: { startup_scripts: [{ id: SCRIPT_ID, name: "orq-ffeeddccbbaa", type: "boot" }], meta: { total: 1, links: { next: "", prev: "" } } }
    }
  ]);
  const listed = await vultrAdapter.listManaged(credentials, replayOptions(replay));
  assert.deepEqual(listed, [
    { ref: { instanceId: INSTANCE_ID }, name: `orq-${TEST_BOX_ID}`, boxId: TEST_BOX_ID, createdAt: "2026-10-19T23:06:41.000Z", state: "running" },
    {
      ref: { instanceId: "22222222-3333-4444-8555-666666666666", startupScriptId: SCRIPT_ID },
      name: "orq-ffeeddccbbaa",
      boxId: "ffeeddccbbaa",
      createdAt: "2026-10-19T23:06:41.000Z",
      state: "running"
    }
  ]);
});
