import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { test } from "node:test";

import { ProviderHttpError } from "./http.ts";
import { ociKeyFingerprint, ociSignedHeaders, oracleAdapter } from "./oracle.ts";
import { fixture, replayFetch, replayOptions, testCreateRequest, TEST_BOX_ID, type RecordedRequest } from "./fixtures/vm-replay.ts";
import { monthlyToHourly, roundUsd } from "./price-tables.ts";

const CORE = "https://iaas.eu-frankfurt-1.oraclecloud.com/20160918";
const IDENTITY = "https://identity.eu-frankfurt-1.oraclecloud.com/20160918";
const PRICE_LIST = "https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD";
const TENANCY = "ocid1.tenancy.oc1..aaaaaaaa11111111111111111111111111111111111111111111111111aa";
const USER = "ocid1.user.oc1..aaaaaaaa22222222222222222222222222222222222222222222222222bb";
const AD1 = "Uocm:EU-FRANKFURT-1-AD-1";
const AD2 = "Uocm:EU-FRANKFURT-1-AD-2";
const AD3 = "Uocm:EU-FRANKFURT-1-AD-3";
const enc = encodeURIComponent;

const { privateKey: testKey, publicKey: testPublicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const testPem = testKey.export({ type: "pkcs8", format: "pem" }).toString();
const credentials = {
  tenancyOcid: TENANCY,
  userOcid: USER,
  fingerprint: ociKeyFingerprint(testKey),
  privateKey: `${testPem}OCI_API_KEY\n`,
  region: "eu-frankfurt-1",
  compartmentOcid: ""
};

const INSTANCE_ID = fixture<{ id: string }>("oracle", "launch-instance").id;
const ref = { instanceId: INSTANCE_ID, region: "eu-frankfurt-1", compartmentId: TENANCY, availabilityDomain: AD1 };

/** Checks a recorded request's OCI signature against the test key, from its own headers. */
function assertSigned(request: RecordedRequest, publicKey: KeyObject = testPublicKey): void {
  const auth = request.headers.authorization ?? "";
  const names = /headers="([^"]+)"/.exec(auth)?.[1]?.split(" ") ?? [];
  const signature = /signature="([^"]+)"/.exec(auth)?.[1] ?? "";
  assert.match(auth, new RegExp(`keyId="${TENANCY}/${USER}/${credentials.fingerprint}"`));
  const url = new URL(request.url);
  const lines = names.map((name) => {
    if (name === "(request-target)") return `(request-target): ${request.method.toLowerCase()} ${url.pathname}${url.search}`;
    if (name === "host") return `host: ${url.host}`;
    return `${name}: ${request.headers[name]}`;
  });
  if (["POST", "PUT", "PATCH"].includes(request.method)) {
    assert.deepEqual(names, ["date", "(request-target)", "host", "content-length", "content-type", "x-content-sha256"]);
    assert.equal(request.headers["x-content-sha256"], createHash("sha256").update(request.rawBody ?? "").digest("base64"));
    assert.equal(request.headers["content-length"], String(Buffer.byteLength(request.rawBody ?? "")));
  } else {
    assert.deepEqual(names, ["date", "(request-target)", "host"]);
  }
  assert.ok(verify("sha256", Buffer.from(lines.join("\n")), publicKey, Buffer.from(signature, "base64")), `signature of ${request.method} ${request.url}`);
}

function shapesRoutes() {
  const query = (ad: string) => `compartmentId=${TENANCY}&availabilityDomain=${enc(ad)}&limit=100`;
  return [
    { method: "GET", url: `${IDENTITY}/availabilityDomains?compartmentId=${TENANCY}`, body: fixture("oracle", "availability-domains") },
    {
      method: "GET",
      url: `${CORE}/shapes?${query(AD1)}`,
      body: fixture("oracle", "shapes-ad1-page1"),
      headers: { "opc-next-page": "page-2-token" }
    },
    { method: "GET", url: `${CORE}/shapes?${query(AD1)}&page=page-2-token`, body: fixture("oracle", "shapes-ad1-page2") },
    { method: "GET", url: `${CORE}/shapes?${query(AD2)}`, body: fixture("oracle", "shapes-ad2") },
    { method: "GET", url: `${CORE}/shapes?${query(AD3)}`, body: fixture("oracle", "shapes-ad3") }
  ];
}

function imagesUrl(os: string): string {
  return `${CORE}/images?compartmentId=${TENANCY}&operatingSystem=${enc(os)}&lifecycleState=AVAILABLE&sortBy=TIMECREATED&sortOrder=DESC&limit=100`;
}

function shapeImageUrl(os: string, version: string, shape: string): string {
  return (
    `${CORE}/images?compartmentId=${TENANCY}&operatingSystem=${enc(os)}&operatingSystemVersion=${enc(version)}` +
    `&shape=${shape}&lifecycleState=AVAILABLE&sortBy=TIMECREATED&sortOrder=DESC&limit=100`
  );
}

const existingNetworkRoutes = [
  { method: "GET", url: `${CORE}/vcns?compartmentId=${TENANCY}&displayName=orquester-boxes&limit=100`, body: fixture("oracle", "vcns") },
  {
    method: "GET",
    url: `${CORE}/subnets?compartmentId=${TENANCY}&vcnId=${fixture<Array<{ id: string }>>("oracle", "vcns")[0]!.id}&displayName=orquester-boxes&limit=100`,
    body: fixture("oracle", "subnets")
  }
];

/** E5 Flex, Balanced 50/256 GB boot volume, list prices of products.json. */
function e5Hourly(ocpus: number, memoryGb: number, windows: boolean): number {
  const boot = monthlyToHourly((windows ? 256 : 50) * (0.0255 + 10 * 0.0017));
  return roundUsd(ocpus * 0.03 + memoryGb * 0.002 + (windows ? ocpus * 0.092 : 0) + boot);
}

test("signing: matches the OCI SDK test vector for the documented sample key (GET and POST)", () => {
  // Oracle's sample key from https://docs.oracle.com/en-us/iaas/Content/API/Concepts/signingrequests.htm and the
  // expected signatures from oci-go-sdk common/http_signer_test.go, which signs the documentation's sample requests.
  const samplePem = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIICXgIBAAKBgQDCFENGw33yGihy92pDjZQhl0C36rPJj+CvfSC8+q28hxA161QF",
    "NUd13wuCTUcq0Qd2qsBe/2hFyc2DCJJg0h1L78+6Z4UMR7EOcpfdUE9Hf3m/hs+F",
    "UR45uBJeDK1HSFHD8bHKD6kv8FPGfJTotc+2xjJwoYi+1hqp1fIekaxsyQIDAQAB",
    "AoGBAJR8ZkCUvx5kzv+utdl7T5MnordT1TvoXXJGXK7ZZ+UuvMNUCdN2QPc4sBiA",
    "QWvLw1cSKt5DsKZ8UETpYPy8pPYnnDEz2dDYiaew9+xEpubyeW2oH4Zx71wqBtOK",
    "kqwrXa/pzdpiucRRjk6vE6YY7EBBs/g7uanVpGibOVAEsqH1AkEA7DkjVH28WDUg",
    "f1nqvfn2Kj6CT7nIcE3jGJsZZ7zlZmBmHFDONMLUrXR/Zm3pR5m0tCmBqa5RK95u",
    "412jt1dPIwJBANJT3v8pnkth48bQo/fKel6uEYyboRtA5/uHuHkZ6FQF7OUkGogc",
    "mSJluOdc5t6hI1VsLn0QZEjQZMEOWr+wKSMCQQCC4kXJEsHAve77oP6HtG/IiEn7",
    "kpyUXRNvFsDE0czpJJBvL/aRFUJxuRK91jhjC68sA7NsKMGg5OXb5I5Jj36xAkEA",
    "gIT7aFOYBFwGgQAQkWNKLvySgKbAZRTeLBacpHMuQdl1DfdntvAyqpAZ0lY0RKmW",
    "G6aFKaqQfOXKCyWoUiVknQJAXrlgySFci/2ueKlIE1QqIiLSZ8V8OlpFLRnb1pzI",
    "7U1yQXnTAEFYM560yJlzUpOb1V4cScGd365tiSMvxLOvTA==",
    "-----END RSA PRIVATE KEY-----"
  ].join("\n");
  const samplePublic = createPublicKey(
    [
      "-----BEGIN PUBLIC KEY-----",
      "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDCFENGw33yGihy92pDjZQhl0C3",
      "6rPJj+CvfSC8+q28hxA161QFNUd13wuCTUcq0Qd2qsBe/2hFyc2DCJJg0h1L78+6",
      "Z4UMR7EOcpfdUE9Hf3m/hs+FUR45uBJeDK1HSFHD8bHKD6kv8FPGfJTotc+2xjJw",
      "oYi+1hqp1fIekaxsyQIDAQAB",
      "-----END PUBLIC KEY-----"
    ].join("\n")
  );
  const keyId =
    "ocid1.tenancy.oc1..aaaaaaaaba3pv6wkcr4jqae5f15p2b2m2yt2j6rx32uzr4h25vqstifsfdsq/" +
    "ocid1.user.oc1..aaaaaaaat5nvwcna5j6aqzjcaty5eqbb6qt2jvpkanghtgdaqedqw3rynjq/20:3b:97:13:55:1c:5b:0d:d3:37:d8:50:4e:c5:3a:34";
  const key = { keyId, privateKey: createPrivateKey(samplePem) };
  const date = "Thu, 05 Jan 2014 21:31:40 GMT";

  const getUrl =
    "https://iaas.us-phoenix-1.oraclecloud.com/20160918/instances?availabilityDomain=Pjwf%3A%20PHX-AD-1&" +
    "compartmentId=ocid1.compartment.oc1..aaaaaaaam3we6vgnherjq5q2idnccdflvjsnog7mlr6rtdb25gilchfeyjxa" +
    "&displayName=TeamXInstances&volumeId=ocid1.volume.oc1.phx.abyhqljrgvttnlx73nmrwfaux7kcvzfs3s66izvxf2h4lgvyndsdsnoiwr5q";
  const get = ociSignedHeaders(key, "GET", getUrl, null, date);
  assert.deepEqual(Object.keys(get).sort(), ["authorization", "date"]);
  assert.equal(
    get.authorization,
    `Signature version="1",headers="date (request-target) host",keyId="${keyId}",algorithm="rsa-sha256",signature="` +
      "GBas7grhyrhSKHP6AVIj/h5/Vp8bd/peM79H9Wv8kjoaCivujVXlpbKLjMPeDUhxkFIWtTtLBj3sUzaFj34XE6YZAHc9r2DmE4pMwOAy/kiITcZxa1oHPOeRh" +
      'eC0jP2dqbTll8fmTZVwKZOKHYPtrLJIJQHJjNvxFWeHQjMaR7M="'
  );

  const body = [
    "{",
    '    "compartmentId": "ocid1.compartment.oc1..aaaaaaaam3we6vgnherjq5q2idnccdflvjsnog7mlr6rtdb25gilchfeyjxa",',
    '    "instanceId": "ocid1.instance.oc1.phx.abuw4ljrlsfiqw6vzzxb43vyypt4pkodawglp3wqxjqofakrwvou52gb6s5a",',
    '    "volumeId": "ocid1.volume.oc1.phx.abyhqljrgvttnlx73nmrwfaux7kcvzfs3s66izvxf2h4lgvyndsdsnoiwr5q"',
    "}"
  ].join("\n");
  const post = ociSignedHeaders(key, "POST", "https://iaas.us-phoenix-1.oraclecloud.com/20160918/volumeAttachments", body, date);
  assert.equal(post["content-length"], "316");
  assert.equal(post["content-type"], "application/json");
  assert.equal(post["x-content-sha256"], "V9Z20UJTvkvpJ50flBzKE32+6m2zJjweHpDMX/U4Uy0=");
  const signature =
    "Mje8vIDPlwIHmD/cTDwRxE7HaAvBg16JnVcsuqaNRim23fFPgQfLoOOxae6WqKb1uPjYEl0qIdazWaBy/Ml8DRhqlocMwoSXv0fbukP8J5N80LCmzT/FFBvIvTB91XuXI3hYfP9Zt1l7S6ieVadHUfqBedWH0itrtPJBgKmrWso=";
  assert.equal(
    post.authorization,
    `Signature version="1",headers="date (request-target) host content-length content-type x-content-sha256",keyId="${keyId}",algorithm="rsa-sha256",signature="${signature}"`
  );
  // And the documented signing string verifies under the documented public key.
  const signingString = [
    `date: ${date}`,
    "(request-target): post /20160918/volumeAttachments",
    "host: iaas.us-phoenix-1.oraclecloud.com",
    "content-length: 316",
    "content-type: application/json",
    "x-content-sha256: V9Z20UJTvkvpJ50flBzKE32+6m2zJjweHpDMX/U4Uy0="
  ].join("\n");
  assert.ok(verify("sha256", Buffer.from(signingString), samplePublic, Buffer.from(signature, "base64")));
});

test("validate: ok with a working key, a message for a bad key, missing fields, malformed input", async () => {
  const replay = replayFetch([
    { method: "GET", url: `${CORE}/instances?compartmentId=${TENANCY}&limit=1`, body: [] },
    { method: "GET", url: `${CORE}/instances?compartmentId=${TENANCY}&limit=1`, status: 401, body: fixture("oracle", "error-not-authenticated") }
  ]);
  assert.deepEqual(await oracleAdapter.validate(credentials, replayOptions(replay)), { ok: true });
  assertSigned(replay.requests[0]!);

  const bad = await oracleAdapter.validate(credentials, replayOptions(replay));
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.message : "", /^Oracle Cloud: The required information to complete authentication/);
  assert.doesNotMatch(!bad.ok ? bad.message : "", /PRIVATE KEY|MII/);

  const expectations: Array<[Record<string, string>, RegExp]> = [
    [{ ...credentials, userOcid: "" }, /^Oracle Cloud: User OCID is missing$/],
    [{ ...credentials, privateKey: "not a key" }, /not a PEM private key/],
    [{ ...credentials, privateKey: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" }, /could not be read/],
    [{ ...credentials, fingerprint: "00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff" }, /fingerprint does not belong/],
    [{ ...credentials, fingerprint: "abc" }, /16 hex pairs/],
    [{ ...credentials, region: "evil.example.com/x" }, /region identifier like eu-frankfurt-1/],
    [{ ...credentials, tenancyOcid: USER }, /Tenancy OCID must be an OCID starting with ocid1\.tenancy\./],
    [{ ...credentials, compartmentOcid: "ocid1.compartment.oc2..aaaa" }, /not in the commercial realm/]
  ];
  for (const [input, message] of expectations) {
    const result = await oracleAdapter.validate(input, replayOptions(replay));
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.message : "", message);
  }
  assert.equal(replay.requests.length, 2);
});

test("validate: a PEM flattened onto one line still signs", async () => {
  const replay = replayFetch([{ method: "GET", url: `${CORE}/instances?compartmentId=${TENANCY}&limit=1`, body: [] }]);
  const flattened = { ...credentials, privateKey: testPem.replace(/\n/g, " ") };
  assert.deepEqual(await oracleAdapter.validate(flattened, replayOptions(replay)), { ok: true });
  assertSigned(replay.requests[0]!);
});

test("offers: flex shape configs per availability domain, live prices, Ubuntu LTS images", async () => {
  const replay = replayFetch([
    ...shapesRoutes(),
    { method: "GET", url: imagesUrl("Canonical Ubuntu"), body: fixture("oracle", "images-ubuntu") },
    { method: "GET", url: PRICE_LIST, body: fixture("oracle", "products") }
  ]);
  const offers = await oracleAdapter.offers(credentials, "linux", replayOptions(replay));
  assert.equal(offers.priceSource, "live");
  for (const request of replay.requests.filter((entry) => entry.url.includes("oraclecloud.com"))) assertSigned(request);
  // The public price list is fetched unsigned.
  assert.equal(replay.requests.find((entry) => entry.url === PRICE_LIST)?.headers.authorization, undefined);

  // Fixed shapes (E2.1.Micro, the GPU shape) are not offered; AD-3 lists nothing Orquester offers.
  assert.equal(offers.sizes.some((size) => /Micro|GPU/.test(size.id)), false);
  assert.deepEqual(new Set(offers.sizes.map((size) => size.id.split(":")[0])), new Set(["VM.Standard.E4.Flex", "VM.Standard.E5.Flex", "VM.Standard3.Flex", "VM.Standard.A1.Flex"]));
  assert.equal(offers.sizes.length, 4 * 8);

  const e5 = offers.sizes.find((size) => size.id === "VM.Standard.E5.Flex:2:16");
  assert.deepEqual(e5, {
    id: "VM.Standard.E5.Flex:2:16",
    label: "VM.Standard.E5.Flex — 2 OCPU (4 vCPU AMD EPYC), 16 GB",
    vcpu: 4,
    ramGb: 16,
    diskGb: 50,
    gpu: null,
    hourlyUsd: e5Hourly(2, 16, false),
    regions: [AD1, AD2]
  });
  // A1 is Arm (1 vCPU per OCPU), priced at its paid tier, and only in AD-1 here.
  const a1 = offers.sizes.find((size) => size.id === "VM.Standard.A1.Flex:1:8");
  assert.equal(a1?.vcpu, 1);
  assert.deepEqual(a1?.regions, [AD1]);
  assert.equal(a1?.hourlyUsd, roundUsd(0.01 + 8 * 0.0015 + monthlyToHourly(50 * (0.0255 + 10 * 0.0017))));

  const prices = offers.sizes.map((size) => size.hourlyUsd ?? Infinity);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));

  assert.deepEqual(offers.regions, [
    { id: AD1, label: "Frankfurt AD-1 (eu-frankfurt-1)", country: null },
    { id: AD2, label: "Frankfurt AD-2 (eu-frankfurt-1)", country: null }
  ]);
  // Ubuntu 24.04 first, LTS only, one entry per version (x86/Arm/Minimal builds collapse).
  assert.deepEqual(offers.images, [
    { id: "ubuntu-24.04", label: "Ubuntu 24.04 LTS" },
    { id: "ubuntu-26.04", label: "Ubuntu 26.04 LTS" },
    { id: "ubuntu-22.04", label: "Ubuntu 22.04 LTS" },
    { id: "ubuntu-20.04", label: "Ubuntu 20.04 LTS" }
  ]);
});

test("offers: Windows has no Arm shapes, adds the licence per OCPU, falls back to the price table", async () => {
  const replay = replayFetch([
    ...shapesRoutes(),
    { method: "GET", url: imagesUrl("Windows"), body: fixture("oracle", "images-windows") },
    { method: "GET", url: PRICE_LIST, status: 503, headers: { "retry-after": "0" }, body: "Service Unavailable", times: 4 }
  ]);
  const offers = await oracleAdapter.offers(credentials, "windows", replayOptions(replay));
  assert.equal(offers.priceSource, "table");
  assert.equal(offers.sizes.some((size) => size.id.startsWith("VM.Standard.A1.Flex")), false);
  const e5 = offers.sizes.find((size) => size.id === "VM.Standard.E5.Flex:2:16");
  assert.equal(e5?.diskGb, 256);
  assert.equal(e5?.hourlyUsd, e5Hourly(2, 16, true));
  assert.deepEqual(
    offers.images.map((image) => image.id),
    ["windows-2022", "windows-2025", "windows-2019"]
  );
  assert.equal(offers.images[0]!.label, "Windows Server 2022 Standard");
  assert.equal(replay.pending().length, 0);
});

test("offers: refuses kinds Oracle Cloud does not rent", async () => {
  await assert.rejects(oracleAdapter.offers(credentials, "linux-gpu", replayOptions(replayFetch([]))), /does not rent linux-gpu/);
});

test("create: Linux into the existing shared subnet — one signed launch with name, tags, cloud-init and SSH key", async () => {
  const replay = replayFetch([
    { method: "GET", url: shapeImageUrl("Canonical Ubuntu", "24.04", "VM.Standard.E5.Flex"), body: fixture("oracle", "images-ubuntu-e5") },
    { method: "GET", url: PRICE_LIST, body: fixture("oracle", "products") },
    ...existingNetworkRoutes,
    { method: "POST", url: `${CORE}/instances`, body: fixture("oracle", "launch-instance") }
  ]);
  const request = testCreateRequest({ size: "VM.Standard.E5.Flex:2:16", region: AD1 });
  const result = await oracleAdapter.create(credentials, request, replayOptions(replay));

  const post = replay.requests.find((entry) => entry.method === "POST")!;
  assertSigned(post);
  const subnets = fixture<Array<{ id: string }>>("oracle", "subnets");
  const images = fixture<Array<{ id: string }>>("oracle", "images-ubuntu-e5");
  assert.deepEqual(post.body, {
    availabilityDomain: AD1,
    compartmentId: TENANCY,
    displayName: `orq-${TEST_BOX_ID}`,
    shape: "VM.Standard.E5.Flex",
    shapeConfig: { ocpus: 2, memoryInGBs: 16 },
    // The newest non-GPU build of Ubuntu 24.04 for the shape.
    sourceDetails: { sourceType: "image", imageId: images[1]!.id, bootVolumeSizeInGBs: 50 },
    createVnicDetails: { subnetId: subnets[0]!.id, assignPublicIp: true, displayName: `orq-${TEST_BOX_ID}` },
    metadata: {
      user_data: Buffer.from(request.bootstrap.cloudInit).toString("base64"),
      ssh_authorized_keys: request.sshPublicKey
    },
    freeformTags: { "orquester-box": TEST_BOX_ID }
  });
  assert.deepEqual(result.ref, ref);
  assert.equal(result.hourlyUsd, e5Hourly(2, 16, false));
  assert.equal(result.windowsPassword, undefined);
  assert.equal(replay.pending().length, 0);
});

test("create: sets up the shared network on first use, waiting for the VCN to become available", async () => {
  const vcn = fixture<{ id: string; defaultRouteTableId: string; defaultSecurityListId: string }>("oracle", "vcn-available");
  const gateway = fixture<{ id: string }>("oracle", "create-internet-gateway");
  const replay = replayFetch([
    { method: "GET", url: shapeImageUrl("Canonical Ubuntu", "22.04", "VM.Standard.A1.Flex"), body: fixture("oracle", "images-ubuntu-e5") },
    { method: "GET", url: PRICE_LIST, body: fixture("oracle", "products") },
    { method: "GET", url: `${CORE}/vcns?compartmentId=${TENANCY}&displayName=orquester-boxes&limit=100`, body: [] },
    { method: "POST", url: `${CORE}/vcns`, body: fixture("oracle", "create-vcn") },
    { method: "GET", url: `${CORE}/vcns/${vcn.id}`, body: vcn },
    { method: "GET", url: `${CORE}/subnets?compartmentId=${TENANCY}&vcnId=${vcn.id}&displayName=orquester-boxes&limit=100`, body: [] },
    { method: "GET", url: `${CORE}/internetGateways?compartmentId=${TENANCY}&vcnId=${vcn.id}`, body: [] },
    { method: "POST", url: `${CORE}/internetGateways`, body: gateway },
    { method: "PUT", url: `${CORE}/routeTables/${vcn.defaultRouteTableId}`, body: fixture("oracle", "route-table") },
    { method: "PUT", url: `${CORE}/securityLists/${vcn.defaultSecurityListId}`, body: fixture("oracle", "security-list") },
    { method: "POST", url: `${CORE}/subnets`, body: fixture("oracle", "create-subnet") },
    { method: "POST", url: `${CORE}/instances`, body: fixture("oracle", "launch-instance") }
  ]);
  await oracleAdapter.create(credentials, testCreateRequest({ size: "VM.Standard.A1.Flex:1:8", region: AD2, image: "ubuntu-22.04" }), replayOptions(replay));
  assert.equal(replay.pending().length, 0);
  for (const request of replay.requests.filter((entry) => entry.url.includes("oraclecloud.com"))) assertSigned(request);

  const body = (method: string, url: string) => replay.requests.find((entry) => entry.method === method && entry.url === url)?.body;
  assert.deepEqual(body("POST", `${CORE}/vcns`), {
    compartmentId: TENANCY,
    cidrBlocks: ["10.77.0.0/16"],
    displayName: "orquester-boxes",
    freeformTags: { "orquester-network": "boxes" }
  });
  assert.deepEqual(body("POST", `${CORE}/internetGateways`), { compartmentId: TENANCY, vcnId: vcn.id, isEnabled: true, displayName: "orquester-boxes" });
  assert.deepEqual(body("PUT", `${CORE}/routeTables/${vcn.defaultRouteTableId}`), {
    routeRules: [{ destination: "0.0.0.0/0", destinationType: "CIDR_BLOCK", networkEntityId: gateway.id }]
  });
  const securityList = body("PUT", `${CORE}/securityLists/${vcn.defaultSecurityListId}`) as Record<string, unknown[]>;
  assert.deepEqual(securityList.egressSecurityRules, [{ destination: "0.0.0.0/0", destinationType: "CIDR_BLOCK", protocol: "all", isStateless: false }]);
  assert.deepEqual(securityList.ingressSecurityRules, [
    { source: "0.0.0.0/0", sourceType: "CIDR_BLOCK", protocol: "1", isStateless: false, icmpOptions: { type: 3, code: 4 } }
  ]);
  assert.deepEqual(body("POST", `${CORE}/subnets`), {
    compartmentId: TENANCY,
    vcnId: vcn.id,
    cidrBlock: "10.77.0.0/20",
    displayName: "orquester-boxes",
    routeTableId: vcn.defaultRouteTableId,
    securityListIds: [vcn.defaultSecurityListId],
    prohibitPublicIpOnVnic: false
  });
  const launch = body("POST", `${CORE}/instances`) as Record<string, unknown>;
  assert.equal(launch.availabilityDomain, AD2);
  assert.deepEqual(launch.shapeConfig, { ocpus: 1, memoryInGBs: 8 });
});

test("create: Windows gets cloudbase-init PowerShell user data, a 256 GB boot volume and no SSH key", async () => {
  const replay = replayFetch([
    { method: "GET", url: shapeImageUrl("Windows", "Server 2022 Standard", "VM.Standard.E5.Flex"), body: fixture("oracle", "images-windows-e5") },
    { method: "GET", url: PRICE_LIST, body: fixture("oracle", "products") },
    ...existingNetworkRoutes,
    { method: "POST", url: `${CORE}/instances`, body: fixture("oracle", "launch-instance") }
  ]);
  const request = testCreateRequest({ kind: "windows", size: "VM.Standard.E5.Flex:2:16", region: AD1 });
  const result = await oracleAdapter.create(credentials, request, replayOptions(replay));
  const launch = replay.requests.find((entry) => entry.method === "POST")?.body as Record<string, Record<string, unknown>>;
  assert.deepEqual(launch.metadata, {
    user_data: Buffer.from(`#ps1_sysnative\r\n${request.bootstrap.powershellScript}`).toString("base64")
  });
  assert.equal(launch.sourceDetails!.bootVolumeSizeInGBs, 256);
  assert.equal(launch.sourceDetails!.imageId, fixture<Array<{ id: string }>>("oracle", "images-windows-e5")[0]!.id);
  assert.equal(result.hourlyUsd, e5Hourly(2, 16, true));
  assert.equal(result.windowsPassword, undefined);
});

test("create: an out-of-capacity launch is never retried and surfaces Oracle's message", async () => {
  const replay = replayFetch([
    { method: "GET", url: shapeImageUrl("Canonical Ubuntu", "24.04", "VM.Standard.E5.Flex"), body: fixture("oracle", "images-ubuntu-e5") },
    { method: "GET", url: PRICE_LIST, body: fixture("oracle", "products") },
    ...existingNetworkRoutes,
    { method: "POST", url: `${CORE}/instances`, status: 500, body: fixture("oracle", "error-out-of-capacity"), times: 2 }
  ]);
  await assert.rejects(
    oracleAdapter.create(credentials, testCreateRequest({ size: "VM.Standard.E5.Flex:2:16", region: AD1 }), replayOptions(replay)),
    (error) => {
      assert.ok(error instanceof ProviderHttpError);
      assert.equal(error.status, 500);
      assert.equal(error.message, "Oracle Cloud: Out of host capacity.");
      return true;
    }
  );
  assert.equal(replay.requests.filter((entry) => entry.method === "POST").length, 1);
});

test("create: refuses bad requests before calling Oracle", async () => {
  const replay = replayFetch([]);
  const cases: Array<[Parameters<typeof testCreateRequest>[0], RegExp]> = [
    [{ kind: "windows", size: "VM.Standard.A1.Flex:1:8", region: AD1 }, /VM.Standard.A1.Flex cannot run Windows/],
    [{ size: "VM.Standard.E2.1.Micro", region: AD1 }, /unknown size VM.Standard.E2.1.Micro/],
    [{ size: "VM.Standard.E5.Flex:2:16", region: AD1, image: "windows-2022" }, /image windows-2022 is not offered for linux boxes/],
    [{ size: "VM.Standard.E5.Flex:2:16", region: "" }, /availability domain is required/]
  ];
  for (const [fields, message] of cases) {
    await assert.rejects(oracleAdapter.create(credentials, testCreateRequest(fields), replayOptions(replay)), message);
  }
  assert.equal(replay.requests.length, 0);
});

test("status: maps lifecycle states, reads the public IP, 404 is gone, 429 is retried", async () => {
  const running = fixture<Record<string, unknown>>("oracle", "instance-running");
  const instanceUrl = `${CORE}/instances/${INSTANCE_ID}`;
  const vnic = fixture<Array<{ vnicId: string }>>("oracle", "vnic-attachments")[0]!.vnicId;
  const replay = replayFetch([
    { method: "GET", url: instanceUrl, status: 429, headers: { "retry-after": "0" }, body: fixture("oracle", "error-rate-limit") },
    { method: "GET", url: instanceUrl, body: running },
    { method: "GET", url: `${CORE}/vnicAttachments?compartmentId=${TENANCY}&instanceId=${INSTANCE_ID}`, body: fixture("oracle", "vnic-attachments") },
    { method: "GET", url: `${CORE}/vnics/${vnic}`, body: fixture("oracle", "vnic") },
    { method: "GET", url: instanceUrl, body: { ...running, lifecycleState: "PROVISIONING" } },
    { method: "GET", url: instanceUrl, body: { ...running, lifecycleState: "STOPPED" } },
    { method: "GET", url: instanceUrl, body: { ...running, lifecycleState: "TERMINATED" } },
    { method: "GET", url: instanceUrl, status: 404, body: fixture("oracle", "error-not-found") }
  ]);
  assert.deepEqual(await oracleAdapter.status(credentials, ref, replayOptions(replay)), {
    state: "running",
    detail: null,
    publicIp: "203.0.113.20",
    hourlyUsd: null
  });
  assert.equal((await oracleAdapter.status(credentials, ref, replayOptions(replay))).state, "pending");
  const stopped = await oracleAdapter.status(credentials, ref, replayOptions(replay));
  assert.deepEqual(stopped, { state: "stopped", detail: "Oracle Cloud reports the instance STOPPED", publicIp: null, hourlyUsd: null });
  assert.equal((await oracleAdapter.status(credentials, ref, replayOptions(replay))).state, "gone");
  assert.deepEqual(await oracleAdapter.status(credentials, ref, replayOptions(replay)), {
    state: "gone",
    detail: "The instance no longer exists in Oracle Cloud",
    publicIp: null,
    hourlyUsd: null
  });
  assert.equal(replay.pending().length, 0);
});

test("status: a failing public IP lookup does not fail the status", async () => {
  const replay = replayFetch([
    { method: "GET", url: `${CORE}/instances/${INSTANCE_ID}`, body: fixture("oracle", "instance-running") },
    { method: "GET", url: `${CORE}/vnicAttachments?compartmentId=${TENANCY}&instanceId=${INSTANCE_ID}`, status: 404, body: fixture("oracle", "error-not-found") }
  ]);
  const status = await oracleAdapter.status(credentials, ref, replayOptions(replay));
  assert.equal(status.state, "running");
  assert.equal(status.publicIp, null);
});

test("destroy: terminates with the boot volume and is idempotent", async () => {
  const deleteUrl = `${CORE}/instances/${INSTANCE_ID}?preserveBootVolume=false`;
  const replay = replayFetch([
    { method: "DELETE", url: deleteUrl, status: 204 },
    { method: "DELETE", url: deleteUrl, status: 404, body: fixture("oracle", "error-not-found") },
    { method: "DELETE", url: deleteUrl, status: 409, body: fixture("oracle", "error-conflict") },
    { method: "GET", url: `${CORE}/instances/${INSTANCE_ID}`, body: { ...fixture<Record<string, unknown>>("oracle", "instance-running"), lifecycleState: "TERMINATING" } }
  ]);
  await oracleAdapter.destroy(credentials, ref, replayOptions(replay));
  assertSigned(replay.requests[0]!);
  await oracleAdapter.destroy(credentials, ref, replayOptions(replay));
  await oracleAdapter.destroy(credentials, ref, replayOptions(replay));
  assert.equal(replay.pending().length, 0);
  await assert.rejects(oracleAdapter.destroy(credentials, {}, replayOptions(replay)), /instance reference has no instanceId/);
});

test("destroy: a conflict on a running instance still fails", async () => {
  const replay = replayFetch([
    { method: "DELETE", url: `${CORE}/instances/${INSTANCE_ID}?preserveBootVolume=false`, status: 409, body: fixture("oracle", "error-conflict") },
    { method: "GET", url: `${CORE}/instances/${INSTANCE_ID}`, body: fixture("oracle", "instance-running") }
  ]);
  await assert.rejects(oracleAdapter.destroy(credentials, ref, replayOptions(replay)), /incorrect state/);
});

test("listManaged: lists the compartment across pages, keeps marked instances that are not terminated", async () => {
  const listUrl = `${CORE}/instances?compartmentId=${TENANCY}&limit=100`;
  const replay = replayFetch([
    { method: "GET", url: listUrl, body: fixture("oracle", "instances-page1"), headers: { "opc-next-page": "next/page+2" } },
    { method: "GET", url: `${listUrl}&page=${enc("next/page+2")}`, body: fixture("oracle", "instances-page2") }
  ]);
  const managed = await oracleAdapter.listManaged(credentials, replayOptions(replay));
  const page2 = fixture<Array<{ id: string }>>("oracle", "instances-page2");
  assert.deepEqual(managed, [
    { ref, name: `orq-${TEST_BOX_ID}`, boxId: TEST_BOX_ID, createdAt: "2026-10-19T23:00:37.123Z", state: "running" },
    {
      ref: { instanceId: page2[0]!.id, region: "eu-frankfurt-1", compartmentId: TENANCY, availabilityDomain: AD2 },
      name: "orq-ffeeddccbbaa",
      boxId: "ffeeddccbbaa",
      createdAt: "2026-10-19T21:12:00.000Z",
      state: "pending"
    }
  ]);
});
