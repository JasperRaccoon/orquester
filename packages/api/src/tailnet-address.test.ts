import assert from "node:assert/strict";
import test from "node:test";

import { isTailnetAddress, isTailnetHost, tailnetAddressesOf } from "./tailnet-address.ts";

test("isTailnetAddress: Tailscale's interface or IPv6 range, never the CGNAT range alone", () => {
  const cases: [string, string, Parameters<typeof isTailnetAddress>[1], boolean][] = [
    ["tailscale0 on Linux", "100.80.44.62", { name: "tailscale0" }, true],
    ["Tailscale on Windows", "100.101.7.3", { name: "Tailscale" }, true],
    ["Tailscale IPv6, no interface known", "fd7a:115c:a1e0::8835:2c3f", undefined, true],
    ["Tailscale IPv6, bracketed with a zone", "[FD7A:115C:A1E0:ab12::1%utun4]", undefined, true],
    ["macOS utun carrying a Tailscale IPv6", "100.80.1.2", { name: "utun4", addresses: [{ address: "100.80.1.2" }, { address: "fd7a:115c:a1e0::1" }] }, true],
    ["Cloudflare WARP on a macOS utun", "100.96.0.5", { name: "utun3", addresses: [{ address: "100.96.0.5" }, { address: "2606:4700:110:8a1::1" }] }, false],
    ["Cloudflare WARP on its own interface", "100.96.0.5", { name: "CloudflareWARP" }, false],
    ["a CGNAT address with no interface known", "100.64.0.7", undefined, false],
    ["a LAN address", "192.168.1.20", { name: "en0" }, false],
    ["a ULA outside Tailscale's /48", "fd7a:115c:a1e1::1", undefined, false],
    ["the /48's first groups compressed away", "fd7a:115c::1", undefined, false]
  ];
  for (const [label, address, iface, expected] of cases) assert.equal(isTailnetAddress(address, iface), expected, label);
});

test("tailnetAddressesOf: the tailnet addresses of a networkInterfaces() map, IPv4 first", () => {
  const found = tailnetAddressesOf({
    lo: [{ address: "127.0.0.1", family: "IPv4" }],
    enp6s0: [{ address: "65.108.137.234", family: "IPv4" }],
    utun3: [{ address: "100.96.0.5", family: "IPv4" }],
    tailscale0: [
      { address: "fd7a:115c:a1e0::8835:2c3f", family: "IPv6" },
      { address: "fe80::c535:4f8d:1289:4490", family: "IPv6" },
      { address: "100.80.44.62", family: "IPv4" }
    ]
  });
  assert.deepEqual(found, [
    { interface: "tailscale0", address: "100.80.44.62", family: "IPv4" },
    { interface: "tailscale0", address: "fd7a:115c:a1e0::8835:2c3f", family: "IPv6" }
  ]);
});

test("isTailnetHost: MagicDNS names and Tailscale IPv6 literals", () => {
  assert.equal(isTailnetHost("ryzen7700.taila64f1b.ts.net"), true);
  assert.equal(isTailnetHost("RYZEN7700.taila64f1b.ts.net."), true);
  assert.equal(isTailnetHost("[fd7a:115c:a1e0::1]"), true);
  assert.equal(isTailnetHost("100.80.44.62"), false);
  assert.equal(isTailnetHost("orq.example.com"), false);
  assert.equal(isTailnetHost("ts.net.example.com"), false);
});
