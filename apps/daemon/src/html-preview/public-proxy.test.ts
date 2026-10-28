import assert from "node:assert/strict";
import * as dgram from "node:dgram";
import { readFile } from "node:fs/promises";
import * as net from "node:net";
import { describe, it } from "node:test";

import {
  createDnsResolver,
  isLocalAddress,
  publicAddresses,
  SOCKS_REFUSED_BY_RULE,
  startPublicProxy,
  type PublicProxyOptions
} from "./public-proxy.ts";

describe("isLocalAddress", () => {
  it("blocks this machine, private and link-local ranges, metadata and translator-embedded local addresses", () => {
    for (const [address, family] of [
      ["127.0.0.1", 4],
      ["127.8.9.10", 4],
      ["0.0.0.0", 4],
      ["10.1.2.3", 4],
      ["172.16.0.1", 4],
      ["172.31.255.255", 4],
      ["192.168.1.1", 4],
      ["100.64.0.1", 4],
      ["169.254.169.254", 4], // cloud metadata
      ["192.0.0.192", 4], // Oracle metadata
      ["224.0.0.1", 4],
      ["255.255.255.255", 4],
      ["::1", 6],
      ["::", 6],
      ["fe80::1", 6],
      ["fc00::1", 6],
      ["fd00:ec2::254", 6], // AWS IPv6 metadata
      ["ff02::1", 6],
      ["::ffff:127.0.0.1", 6], // IPv4-mapped loopback
      ["::ffff:10.0.0.1", 6],
      ["64:ff9b::7f00:1", 6], // NAT64 of 127.0.0.1
      ["64:ff9b::a00:1", 6], // NAT64 of 10.0.0.1
      ["2002:7f00:1::1", 6], // 6to4 of 127.0.0.1
      ["2002:c0a8:101::1", 6] // 6to4 of 192.168.1.1
    ] as const) {
      assert.equal(isLocalAddress(address, family), true, address);
    }
  });

  it("lets public addresses through, NAT64 of a public one included", () => {
    for (const [address, family] of [
      ["93.184.216.34", 4],
      ["1.1.1.1", 4],
      ["172.32.0.1", 4], // just past 172.16/12
      ["2606:4700:4700::1111", 6],
      ["64:ff9b::5db8:d822", 6] // NAT64 of 93.184.216.34
    ] as const) {
      assert.equal(isLocalAddress(address, family), false, address);
    }
  });
});

describe("publicAddresses: resolve first, then check every address", () => {
  const resolver =
    (answers: Record<string, Array<{ address: string; family: number }>>) =>
    async (host: string): Promise<Array<{ address: string; family: number }>> =>
      answers[host] ?? [];

  it("answers a name's addresses only when every one of them is public", async () => {
    const resolve = resolver({
      "public.example": [{ address: "93.184.216.34", family: 4 }],
      // DNS rebinding: one public answer, one local — refused whole.
      "rebind.example": [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 }
      ],
      "metadata.example": [{ address: "169.254.169.254", family: 4 }],
      "v6local.example": [{ address: "fd00::5", family: 6 }]
    });
    assert.deepEqual(await publicAddresses("public.example", { resolve }), [{ address: "93.184.216.34", family: 4 }]);
    assert.equal(await publicAddresses("rebind.example", { resolve }), undefined);
    assert.equal(await publicAddresses("metadata.example", { resolve }), undefined);
    assert.equal(await publicAddresses("v6local.example", { resolve }), undefined);
    assert.equal(await publicAddresses("nxdomain.example", { resolve }), undefined);
  });

  it("checks an address literal as itself, never resolving it", async () => {
    const resolve = async (): Promise<never> => {
      throw new Error("a literal is never resolved");
    };
    assert.equal(await publicAddresses("127.0.0.1", { resolve }), undefined);
    assert.equal(await publicAddresses("::1", { resolve }), undefined);
    assert.deepEqual(await publicAddresses("1.1.1.1", { resolve }), [{ address: "1.1.1.1", family: 4 }]);
  });

  it("refuses localhost names without resolving them, and takes bracketed IPv6 literals as literals", async () => {
    const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
    for (const host of ["localhost", "LOCALHOST.", "app.localhost", "[::1]", "[::ffff:127.0.0.1]"]) {
      assert.equal(await publicAddresses(host, { resolve }), undefined, host);
    }
    assert.deepEqual(await publicAddresses("[2606:4700:4700::1111]", { resolve }), [{ address: "2606:4700:4700::1111", family: 6 }]);
  });

  it("treats a failing resolver as nothing to connect to", async () => {
    const resolve = async (): Promise<never> => {
      throw new Error("SERVFAIL");
    };
    assert.equal(await publicAddresses("broken.example", { resolve }), undefined);
  });
});

/** A SOCKS5 CONNECT through the proxy: the reply code, and the socket when it opened. */
async function socksConnect(proxyPort: number, host: string, port: number): Promise<{ code: number; socket: net.Socket }> {
  const socket = net.connect(proxyPort, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  const read = (bytes: number): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const onData = (chunk: Buffer): void => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length >= bytes) {
          socket.off("data", onData);
          socket.off("close", onClose);
          if (buffer.length > bytes) socket.unshift(buffer.subarray(bytes));
          resolve(buffer.subarray(0, bytes));
        }
      };
      const onClose = (): void => reject(new Error("closed early"));
      socket.on("data", onData);
      socket.once("close", onClose);
    });
  socket.write(Buffer.from([5, 1, 0]));
  assert.deepEqual([...(await read(2))], [5, 0]);
  const name = Buffer.from(host, "latin1");
  const request = Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 0xff])]);
  socket.write(request);
  const reply = await read(10);
  return { code: reply[1]!, socket };
}

async function withServer(
  run: (port: number, connections: () => number) => Promise<void>
): Promise<void> {
  let count = 0;
  const server = net.createServer((socket) => {
    count += 1;
    socket.on("data", (chunk) => socket.write(Buffer.concat([Buffer.from("echo:"), chunk])));
    socket.on("error", () => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run((server.address() as net.AddressInfo).port, () => count);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("the SOCKS5 proxy", () => {
  it("refuses loopback and any name that resolves to a local address, without ever connecting", async () => {
    await withServer(async (port, connections) => {
      const options: PublicProxyOptions = {
        resolve: async (host) =>
          host === "sneaky.example" ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "10.0.0.1", family: 4 }]
      };
      const proxy = await startPublicProxy(options);
      try {
        for (const host of ["127.0.0.1", "localhost", "sneaky.example", "::1"]) {
          const { code, socket } = await socksConnect(proxy.port, host, port);
          assert.equal(code, SOCKS_REFUSED_BY_RULE, host);
          socket.destroy();
        }
        assert.equal(connections(), 0);
      } finally {
        await proxy.close();
      }
    });
  });

  it("tunnels bytes both ways to an allowed address, connecting only to the address it checked", async () => {
    await withServer(async (port, connections) => {
      const resolved: string[] = [];
      const proxy = await startPublicProxy({
        // A name that resolves to the test server; the rule allows exactly it.
        resolve: async (host) => {
          resolved.push(host);
          return [{ address: "127.0.0.1", family: 4 }];
        },
        blocked: (address) => address !== "127.0.0.1"
      });
      try {
        const { code, socket } = await socksConnect(proxy.port, "allowed.example", port);
        assert.equal(code, 0);
        const answer = new Promise<string>((resolve) => socket.once("data", (chunk: Buffer) => resolve(chunk.toString())));
        socket.write("ping");
        assert.equal(await answer, "echo:ping");
        assert.equal(connections(), 1);
        assert.deepEqual(resolved, ["allowed.example"]);
        socket.destroy();
      } finally {
        await proxy.close();
      }
    });
  });

  it("refuses a non-CONNECT command", async () => {
    await withServer(async (port, connections) => {
      const proxy = await startPublicProxy({ blocked: (address) => address !== "127.0.0.1" });
      const socket = net.connect(proxy.port, "127.0.0.1");
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once("connect", resolve);
          socket.once("error", reject);
        });
        const replies: Buffer[] = [];
        const reply = new Promise<Buffer>((resolve, reject) => {
          socket.on("data", (chunk: Buffer) => {
            replies.push(chunk);
            const bytes = Buffer.concat(replies);
            if (bytes.length >= 12) resolve(bytes);
          });
          socket.once("error", reject);
          socket.once("close", () => reject(new Error("closed before the complete SOCKS reply")));
        });
        const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
        // Greeting and BIND share the stream as before; an allowed local target
        // makes a missing command guard produce a reply instead of a network wait.
        socket.write(Buffer.from([5, 1, 0]));
        socket.write(Buffer.from([5, 2, 0, 1, 127, 0, 0, 1, port >> 8, port & 0xff]));
        const all = await reply;
        assert.deepEqual([...all.subarray(0, 2)], [5, 0]);
        assert.equal(all[3], 7);
        assert.equal(connections(), 0, "an unsupported command never reaches its target");
        await closed;
      } finally {
        socket.destroy();
        await proxy.close();
      }
    });
  });
});

/** A tiny DNS server on loopback: answers A queries from `answers`, AAAA with nothing; `silent` answers nothing at all. */
async function dnsServer(answers: Record<string, string>, silent = false) {
  const socket = dgram.createSocket("udp4");
  let queries = 0;
  let received!: () => void;
  const queried = new Promise<void>((resolve) => (received = resolve));
  socket.on("message", (message, peer) => {
    queries += 1;
    received();
    if (silent) return;
    // Question: after the 12-byte header, labels until a 0 byte, then type and class.
    let at = 12;
    const labels: string[] = [];
    while (message[at]! !== 0) {
      labels.push(message.subarray(at + 1, at + 1 + message[at]!).toString("latin1"));
      at += message[at]! + 1;
    }
    const type = message.readUInt16BE(at + 1);
    const question = message.subarray(12, at + 5);
    const address = type === 1 ? answers[labels.join(".")] : undefined;
    const header = Buffer.alloc(12);
    message.copy(header, 0, 0, 2);
    header.writeUInt16BE(address ? 0x8180 : 0x8183, 2); // NOERROR or NXDOMAIN
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(address ? 1 : 0, 6);
    const answer = address
      ? Buffer.concat([Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4]), Buffer.from(address.split(".").map(Number))])
      : Buffer.alloc(0);
    socket.send(Buffer.concat([header, question, answer]), peer.port, peer.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return {
    server: `127.0.0.1:${socket.address().port}`,
    queries: () => queries,
    queried,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve()))
  };
}

describe("name resolution (c-ares, bounded)", () => {
  it("resolves through c-ares — the servers it is given, never getaddrinfo", async () => {
    const dns = await dnsServer({ "public.example": "93.184.216.34", "inside.example": "10.0.0.7" });
    const resolver = createDnsResolver({ servers: [dns.server], timeoutMs: 2000 });
    try {
      assert.deepEqual(await resolver.resolve("public.example"), [{ address: "93.184.216.34", family: 4 }]);
      assert.equal(await publicAddresses("inside.example", { resolve: resolver.resolve }), undefined);
      assert.deepEqual(await resolver.resolve("missing.example"), []);
      assert.ok(dns.queries() >= 3);
    } finally {
      resolver.close();
      await dns.close();
    }
  });

  it("a resolver that never answers stalls no file read, and every lookup gives up at its timeout", async (t) => {
    const dns = await dnsServer({}, true);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const resolver = createDnsResolver({ servers: [dns.server], timeoutMs: 1500 });
    try {
      // Twice libuv's default thread pool: with getaddrinfo these would hold every fs thread.
      const lookups = Array.from({ length: 8 }, (_, index) => resolver.resolve(`slow-${index}.example`));
      let settled = 0;
      for (const lookup of lookups) void lookup.then(() => (settled += 1));
      await dns.queried;
      const reads = await Promise.all(Array.from({ length: 8 }, () => readFile(new URL(import.meta.url))));
      assert.ok(reads.every((bytes) => bytes.length > 0));
      assert.equal(settled, 0, "the file reads finished while every lookup was still pending");
      t.mock.timers.tick(1500);
      await Promise.resolve();
      assert.equal(settled, lookups.length, "the fake deadline settled active and queued lookups");
      assert.deepEqual(await Promise.all(lookups), Array.from({ length: 8 }, () => []));
      assert.ok(dns.queries() > 0);
    } finally {
      resolver.close();
      await dns.close();
    }
  });

  it("closing cancels what is still in flight, and a closed resolver answers nothing", async (t) => {
    const dns = await dnsServer({}, true);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const resolver = createDnsResolver({ servers: [dns.server], timeoutMs: 30_000 });
    t.after(async () => {
      resolver.close();
      await dns.close();
    });
    const pending = resolver.resolve("slow.example");
    let cancelled: unknown;
    void pending.then((addresses) => { cancelled = addresses; });
    resolver.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(cancelled, [], "close settled the lookup without firing its timeout");
    assert.deepEqual(await resolver.resolve("after.example"), []);
  });

  it("closing answers the lookups still waiting for a slot too, at once", async (t) => {
    const dns = await dnsServer({}, true);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const resolver = createDnsResolver({ servers: [dns.server], timeoutMs: 60_000 });
    t.after(async () => {
      resolver.close();
      await dns.close();
    });
    // Four in flight, three waiting for a slot.
    const pending = Array.from({ length: 7 }, (_, index) => resolver.resolve(`slow-${index}.example`));
    let cancelled: unknown;
    void Promise.all(pending).then((addresses) => { cancelled = addresses; });
    resolver.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(cancelled, Array.from({ length: 7 }, () => []), "close settled active and queued lookups without firing their timeouts");
  });

  it("the proxy refuses a name whose lookup times out", async (t) => {
    const endings = t.mock.method(net.Socket.prototype, "end");
    const dns = await dnsServer({}, true);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const proxy = await startPublicProxy({ dnsServers: [dns.server], lookupTimeoutMs: 500 });
    try {
      const connecting = socksConnect(proxy.port, "slow.example", 443);
      await dns.queried;
      t.mock.timers.tick(500);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(endings.mock.calls.some(({ arguments: [chunk] }) =>
        Buffer.isBuffer(chunk) && chunk.length === 10 && chunk[0] === 5 && chunk[1] === SOCKS_REFUSED_BY_RULE
      ), "the fake deadline sent the SOCKS refusal before any native DNS timeout");
      const { code, socket } = await connecting;
      assert.equal(code, SOCKS_REFUSED_BY_RULE);
      socket.destroy();
    } finally {
      await proxy.close();
      await dns.close();
    }
  });
});
