import assert from "node:assert/strict";
import type { LookupAddress } from "node:dns";
import test from "node:test";
import { checkRequestUrl, hostnameProblem, isBlockedAddress, pinnedLookup, SafeFetchError } from "./safe-fetch.ts";

test("isBlockedAddress refuses every non-public IPv4 range", () => {
  const blocked = [
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "100.127.255.254",
    "100.100.100.200",
    "127.0.0.1",
    "127.255.0.9",
    "169.254.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255"
  ];
  for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, ip);
});

test("isBlockedAddress allows public IPv4, including the neighbours of blocked ranges", () => {
  const allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "192.167.1.1", "192.169.0.1", "198.17.255.255", "198.20.0.1", "223.255.255.255", "11.0.0.1", "126.255.255.255", "128.0.0.1", "169.253.1.1"];
  for (const ip of allowed) assert.equal(isBlockedAddress(ip), false, ip);
});

test("isBlockedAddress refuses every non-public IPv6 range", () => {
  const blocked = [
    "::",
    "::1",
    "[::1]",
    "::7f00:1", // IPv4-compatible
    "::8.8.8.8", // deprecated IPv4-compatible, even with a public tail
    "fe80::1",
    "fe80::1%eth0",
    "febf::1",
    "fec0::1", // site-local
    "fc00::1",
    "fd12:3456::1",
    "fd00:ec2::254",
    "ff02::1",
    "ff0e::1",
    "100::1", // discard-only
    "2001:db8::1",
    "2001::1", // Teredo
    "2001:2::1", // benchmarking
    "3fff::1", // documentation
    "64:ff9b:1::1" // local-use NAT64
  ];
  for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, ip);
});

test("isBlockedAddress unwraps IPv4 embedded in mapped, translated, NAT64 and 6to4 forms", () => {
  const blocked = [
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::FFFF:10.0.0.1",
    "::ffff:a9fe:a9fe", // 169.254.169.254
    "::ffff:192.168.0.1",
    "0:0:0:0:0:ffff:ac10:1",
    "::ffff:0:10.1.2.3", // IPv4-translated
    "64:ff9b::127.0.0.1",
    "64:ff9b::a00:1",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    "2002:c0a8:101::1",
    "2002:a9fe:a9fe::1"
  ];
  for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, ip);
  const allowed = ["::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::8.8.8.8", "64:ff9b::5db8:d822", "2002:808:808::1"];
  for (const ip of allowed) assert.equal(isBlockedAddress(ip), false, ip);
});

test("isBlockedAddress allows public IPv6 and refuses garbage", () => {
  for (const ip of ["2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "2001:4860:4860::8888", "2400:cb00::1"]) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
  for (const ip of ["", "localhost", "example.com", "1.2.3", "999.1.1.1", "::g", "1:2:3:4:5:6:7:8:9"]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
});

test("hostnameProblem separates local names from malformed ones", () => {
  assert.equal(hostnameProblem("example.com"), null);
  assert.equal(hostnameProblem("xn--bcher-kva.example"), null);
  assert.equal(hostnameProblem("a_b.example.com"), null);
  for (const host of ["localhost", "app.localhost", "printer.local", "db.internal", "metadata.google.internal", "metadata.goog", "router.home.arpa", "intranet"]) {
    assert.equal(hostnameProblem(host), "local", host);
  }
  for (const host of ["", "a..b.com", "-a.com", "a-.com", "a!b.com", `${"a".repeat(64)}.com`, `${"a.".repeat(127)}com`]) {
    assert.equal(hostnameProblem(host), "malformed", host);
  }
});

test("checkRequestUrl allows only https to a plausible public name", () => {
  assert.equal(checkRequestUrl("https://example.com/a#frag", {}).href, "https://example.com/a");
  const refused: Array<[string, string]> = [
    ["http://example.com/", "invalid-url"],
    ["ftp://example.com/", "invalid-url"],
    ["https://user:pw@example.com/", "invalid-url"],
    ["https://example.com:8443/", "invalid-url"],
    ["https://8.8.8.8/", "invalid-url"],
    ["https://127.0.0.1/", "blocked"],
    ["https://0x7f.1/", "blocked"],
    ["https://[::1]/", "blocked"],
    ["https://[::ffff:10.0.0.1]/", "blocked"],
    ["https://localhost/", "blocked"],
    ["https://metadata.google.internal/", "blocked"],
    ["https://intranet/", "blocked"],
    ["not a url", "invalid-url"]
  ];
  for (const [url, kind] of refused) {
    assert.throws(() => checkRequestUrl(url, {}), (error) => error instanceof SafeFetchError && error.kind === kind, url);
  }
  assert.equal(checkRequestUrl("http://example.com/", { unsafeTestServer: { port: 1 } }).protocol, "http:");
  assert.throws(() => checkRequestUrl("https://example.com/", { unsafeTestServer: { port: 1 } }));
});

test("pinnedLookup answers only the vetted host with only the vetted addresses", () => {
  const vetted: LookupAddress[] = [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1::1", family: 6 }
  ];
  const lookup = pinnedLookup("example.com", vetted);
  const call = (host: string, options: object) =>
    new Promise<{ error: NodeJS.ErrnoException | null; address: unknown; family?: number }>((resolve) =>
      lookup(host, options, (error, address, family) => resolve({ error, address, family }))
    );

  return (async () => {
    assert.deepEqual((await call("example.com", { all: true })).address, vetted);
    assert.deepEqual(await call("EXAMPLE.com", {}), { error: null, address: "93.184.216.34", family: 4 });
    assert.deepEqual(await call("example.com", { family: 6 }), { error: null, address: "2606:2800:220:1::1", family: 6 });
    const other = await call("rebound.example.com", { all: true });
    assert.equal(other.error?.code, "ENOTFOUND");
  })();
});
