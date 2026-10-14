import assert from "node:assert/strict";
import * as net from "node:net";
import { describe, it } from "node:test";

import { isLocalAddress, publicAddresses, SOCKS_REFUSED_BY_RULE, startPublicProxy, type PublicProxyOptions } from "./public-proxy.ts";

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
    const proxy = await startPublicProxy();
    try {
      const socket = net.connect(proxy.port, "127.0.0.1");
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      const replies: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => replies.push(chunk));
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      // Greeting, then BIND (command 2) to 1.1.1.1:80.
      socket.write(Buffer.from([5, 1, 0]));
      socket.write(Buffer.from([5, 2, 0, 1, 1, 1, 1, 1, 0, 80]));
      await closed;
      const all = Buffer.concat(replies);
      assert.deepEqual([...all.subarray(0, 2)], [5, 0]);
      assert.equal(all[3], 7);
    } finally {
      await proxy.close();
    }
  });
});
