/**
 * The preview browser's only way out (design 2026-10-14 §2.1): a SOCKS5
 * proxy on loopback that connects to public addresses only.
 *
 * Ported from T3 Code (MIT): `apps/server/src/htmlRender/publicProxy.ts`,
 * from Effect to plain Node.
 *
 * The headless Chromium that previews and measures agent pages sends every
 * connection here (`--proxy-server=socks5://…`, loopback included). A target
 * is resolved HERE, every address it resolves to is checked, and the upstream
 * socket connects only to those checked addresses — so a name that resolves
 * to a public address for the check and to a private one a moment later (DNS
 * rebinding) still never reaches this machine or its networks. It carries
 * bytes only: HTTP, TLS and WebSockets pass through unchanged.
 *
 * Limit (S-M3): "this machine" is the local ranges below plus the addresses
 * its interfaces hold. A host whose public address is NOT on an interface —
 * behind NAT, or with a cloud provider's elastic/floating IP — is reachable
 * by a preview through that public address like any public server: a page can
 * reach the host's own public listeners (its reverse proxy, e.g. Caddy), and
 * through them only what they serve without authentication (the daemon's
 * routes behind it require the bearer). Such an operator who wants the public
 * address refused too can firewall the host from itself, or keep previews
 * off (no Chromium-family browser enabled).
 */

import { Resolver } from "node:dns/promises";
import * as net from "node:net";
import { networkInterfaces } from "node:os";

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** This machine and its local networks, which a preview must never reach. */
const LOCAL_ADDRESSES = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata (169.254.169.254)
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments (incl. 192.0.0.192 metadata)
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 3] // multicast and reserved
] as const) {
  LOCAL_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
// Also the IPv6 ranges that carry an IPv4 address a translator may route to
// without checking it: IPv4-compatible, local-use NAT64, and Teredo; plus
// unique-local (fd00::/8 holds AWS's fd00:ec2::254 metadata), link-local and
// multicast.
for (const [network, prefix] of [
  ["::", 96],
  ["64:ff9b:1::", 48],
  ["2001::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8]
] as const) {
  LOCAL_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

const NAT64 = new net.BlockList();
NAT64.addSubnet("64:ff9b::", 96, "ipv6");
const SIX_TO_FOUR = new net.BlockList();
SIX_TO_FOUR.addSubnet("2002::", 16, "ipv6");

/** The sixteen-bit groups of an IPv6 address, which may end in dotted IPv4. */
function ipv6Groups(address: string): number[] {
  const bare = address.split("%", 1)[0]!;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(bare);
  const text = dotted
    ? `${bare.slice(0, dotted.index)}${((+dotted[1]! << 8) | +dotted[2]!).toString(16)}:${((+dotted[3]! << 8) | +dotted[4]!).toString(16)}`
    : bare;
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(Math.max(0, fill)).fill("0"), ...right].map((group) => Number.parseInt(group, 16));
}

/**
 * The IPv4 address a NAT64 or 6to4 address stands for, which a translator
 * will route to, so it is checked as well. Public NAT64 targets stay
 * reachable, as on IPv6-only networks.
 */
function embeddedIPv4(address: string): string | undefined {
  const at = NAT64.check(address, "ipv6") ? 6 : SIX_TO_FOUR.check(address, "ipv6") ? 1 : -1;
  if (at === -1) return undefined;
  const groups = ipv6Groups(address);
  const high = groups[at] ?? 0;
  const low = groups[at + 1] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/** The addresses this machine's interfaces hold right now. */
function ownAddresses(): net.BlockList {
  const own = new net.BlockList();
  for (const entry of Object.values(networkInterfaces()).flat()) {
    if (entry) own.addAddress(entry.address, entry.family === "IPv6" ? "ipv6" : "ipv4");
  }
  return own;
}

/**
 * Whether `address` belongs to a local network or to this machine itself,
 * including a public address one of its interfaces holds. Both lists match
 * IPv4-mapped IPv6 (`::ffff:a.b.c.d`) against their IPv4 entries.
 */
export function isLocalAddress(address: string, family: number): boolean {
  const type = family === 6 ? "ipv6" : "ipv4";
  if (LOCAL_ADDRESSES.check(address, type) || ownAddresses().check(address, type)) return true;
  const embedded = family === 6 ? embeddedIPv4(address) : undefined;
  return embedded !== undefined && isLocalAddress(embedded, 4);
}

export interface PublicProxyOptions {
  /** Name resolution; c-ares (see {@link createDnsResolver}) by default. Tests inject one. */
  resolve?: (host: string) => Promise<ResolvedAddress[]>;
  /** Whether an address is off limits; {@link isLocalAddress} by default. */
  blocked?: (address: string, family: number) => boolean;
  /** The DNS servers the default resolver asks (`host[:port]`); the system's by default. For tests. */
  dnsServers?: string[];
  /** A name answers within this, or not at all (default 5 s, the wait for a lookup slot included). */
  lookupTimeoutMs?: number;
}

const LOOKUP_TIMEOUT_MS = 5_000;
/** At most this many lookups of one proxy in flight; the rest wait their turn. */
const MAX_CONCURRENT_LOOKUPS = 4;
/** And at most this many waiting; past it a name is refused outright. */
const MAX_WAITING_LOOKUPS = 64;

export interface DnsResolver {
  resolve(host: string): Promise<ResolvedAddress[]>;
  /** Cancels every query still in flight (each answers nothing). */
  close(): void;
}

/**
 * Name resolution on c-ares (`dns.promises.Resolver`), never `dns.lookup`:
 * getaddrinfo runs on libuv's shared four-thread pool and cannot be
 * cancelled, so a page naming many hosts behind a slow resolver would stall
 * every file operation of the daemon. c-ares is asynchronous on the event
 * loop. It reads no hosts file — harmless, since the proxy connects only to
 * addresses it checked, and a name a hosts file maps is local more often than
 * not. Bounded: {@link MAX_CONCURRENT_LOOKUPS} at once, a per-lookup timeout,
 * all cancelled on close.
 */
export function createDnsResolver(options: { servers?: string[]; timeoutMs?: number } = {}): DnsResolver {
  const timeoutMs = options.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  const resolver = new Resolver({ timeout: Math.max(1, Math.ceil(timeoutMs / 2)), tries: 2 });
  if (options.servers) resolver.setServers(options.servers);
  let active = 0;
  /** Lookups waiting for a slot: `start` runs one, `drop` answers it nothing. */
  const waiting: Array<{ start: () => void; drop: () => void }> = [];
  let closed = false;
  const lookup = async (host: string): Promise<ResolvedAddress[]> => {
    const answers = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    return [
      ...(answers[0].status === "fulfilled" ? answers[0].value.map((address) => ({ address, family: 4 })) : []),
      ...(answers[1].status === "fulfilled" ? answers[1].value.map((address) => ({ address, family: 6 })) : [])
    ];
  };
  return {
    resolve: (host) =>
      new Promise<ResolvedAddress[]>((resolve) => {
        let settled = false;
        const finish = (addresses: ResolvedAddress[]): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(addresses);
        };
        const timer = setTimeout(() => {
          const index = waiting.indexOf(entry);
          if (index !== -1) waiting.splice(index, 1);
          finish([]);
        }, timeoutMs);
        const start = (): void => {
          active += 1;
          lookup(host)
            .catch(() => [] as ResolvedAddress[])
            .then((addresses) => {
              active -= 1;
              waiting.shift()?.start();
              finish(addresses);
            });
        };
        const entry = { start, drop: () => finish([]) };
        if (closed) finish([]);
        else if (active < MAX_CONCURRENT_LOOKUPS) start();
        else if (waiting.length < MAX_WAITING_LOOKUPS) waiting.push(entry);
        else finish([]);
      }),
    close: () => {
      closed = true;
      // Every waiting lookup answers now (and clears its timer): nothing waits past close.
      for (const entry of waiting.splice(0)) entry.drop();
      resolver.cancel();
    }
  };
}

/** Names that are this machine by definition (RFC 6761), refused unresolved. */
function isLocalhostName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return name === "localhost" || name.endsWith(".localhost");
}

/**
 * The addresses to connect to for `host`, or undefined when it resolves to
 * nothing or ANY address it resolves to is blocked. The caller connects only
 * to addresses checked here.
 */
export async function publicAddresses(
  host: string,
  options: PublicProxyOptions = {}
): Promise<ResolvedAddress[] | undefined> {
  const blocked = options.blocked ?? isLocalAddress;
  // A bracketed or zone-scoped IPv6 literal is still a literal.
  const literal = host.replace(/^\[(.*)\]$/, "$1");
  const family = net.isIP(literal);
  if (family === 0 && isLocalhostName(host)) return undefined;
  const addresses =
    family !== 0
      ? [{ address: literal, family }]
      : options.resolve
        ? await options.resolve(host).catch(() => [] as ResolvedAddress[])
        : [];
  if (addresses.length === 0) return undefined;
  return addresses.some(({ address, family: addressFamily }) => blocked(address, addressFamily)) ? undefined : addresses;
}

// SOCKS5 (RFC 1928) replies: success, refused by rule, host unreachable, command unsupported.
const reply = (code: number): Buffer => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
export const SOCKS_REFUSED_BY_RULE = 2;

// What a client may send before its tunnel opens; a TLS hello fits easily.
const MAX_EARLY_BYTES = 64 * 1024;

/** Answers and closes; anything the client sent after its request is dropped. */
function refuse(client: net.Socket, code: number): void {
  client.end(reply(code), () => client.destroy());
}

type SocksRequest = { command: number; host: string; port: number; rest: Buffer };

/** The CONNECT target in a complete SOCKS5 request, "short" when more bytes are needed. */
function readRequest(data: Buffer): SocksRequest | "short" | undefined {
  if (data.length < 5) return "short";
  // Version 5, reserved byte 0.
  if (data[0] !== 5 || data[2] !== 0) return undefined;
  const type = data[3];
  const end = type === 1 ? 10 : type === 3 ? 7 + data[4]! : type === 4 ? 22 : -1;
  if (end === -1) return undefined;
  if (data.length < end) return "short";
  const host =
    type === 1
      ? [...data.subarray(4, 8)].join(".")
      : type === 3
        ? data.subarray(5, 5 + data[4]!).toString("latin1")
        : Array.from({ length: 8 }, (_, index) => data.readUInt16BE(4 + index * 2).toString(16)).join(":");
  return { command: data[1]!, host, port: data.readUInt16BE(end - 2), rest: data.subarray(end) };
}

export interface PublicProxy {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Starts the proxy on `127.0.0.1:<ephemeral>`. Chrome's own Local Network
 * Access misses some requests (speculation-rules prefetches, for one);
 * nothing misses this.
 */
export function startPublicProxy(options: PublicProxyOptions = {}): Promise<PublicProxy> {
  const dns = options.resolve
    ? null
    : createDnsResolver({
        ...(options.dnsServers ? { servers: options.dnsServers } : {}),
        ...(options.lookupTimeoutMs !== undefined ? { timeoutMs: options.lookupTimeoutMs } : {})
      });
  const checks: PublicProxyOptions = { ...options, resolve: options.resolve ?? dns!.resolve };
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket): net.Socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    return socket;
  };
  const server = net.createServer((client) => {
    track(client);
    let data = Buffer.alloc(0);
    let greeted = false;
    const onData = (chunk: Buffer): void => {
      data = Buffer.concat([data, chunk]);
      if (data.length > MAX_EARLY_BYTES) {
        client.destroy();
        return;
      }
      if (!greeted) {
        if (data.length < 2 || data.length < 2 + data[1]!) return;
        // Version 5, offering "no authentication".
        if (data[0] !== 5 || !data.subarray(2, 2 + data[1]!).includes(0)) {
          client.end(Buffer.from([5, 0xff]));
          return;
        }
        data = data.subarray(2 + data[1]!);
        greeted = true;
        client.write(Buffer.from([5, 0]));
      }
      const request = readRequest(data);
      if (request === "short") return;
      client.off("data", onData);
      if (request === undefined || request.command !== 1 || request.port === 0) {
        refuse(client, 7);
        return;
      }
      // Keeps reading while the target resolves, so a client that leaves is
      // noticed, and holds what it sends early up to a small cap.
      const early: Buffer[] = [request.rest];
      let earlyBytes = request.rest.length;
      const holdEarly = (chunk: Buffer): void => {
        earlyBytes += chunk.length;
        if (earlyBytes > MAX_EARLY_BYTES) {
          client.destroy();
          return;
        }
        early.push(chunk);
      };
      client.on("data", holdEarly);
      void publicAddresses(request.host, checks).then((addresses) => {
        if (client.destroyed) return;
        client.off("data", holdEarly);
        if (addresses === undefined) {
          refuse(client, SOCKS_REFUSED_BY_RULE);
          return;
        }
        client.pause();
        // Every checked address is tried, IPv6 and IPv4 alike; a name goes
        // through `lookup`, which hands back only the checked addresses.
        const first = addresses[0]!;
        const upstream = track(
          net.connect({
            host: request.host,
            port: request.port,
            autoSelectFamily: true,
            lookup: (_host, lookupOptions, callback) => {
              if ((lookupOptions as { all?: boolean }).all) {
                (callback as (error: null, addresses: ResolvedAddress[]) => void)(null, addresses);
              } else {
                (callback as (error: null, address: string, family: number) => void)(null, first.address, first.family);
              }
            }
          })
        );
        let connected = false;
        upstream.once("connect", () => {
          connected = true;
          client.write(reply(0));
          for (const chunk of early) upstream.write(chunk);
          upstream.pipe(client);
          client.pipe(upstream);
          client.resume();
        });
        // Unreachable before the tunnel opens: say so; after, the close ends both.
        upstream.once("error", () => {
          if (!connected && !client.destroyed) refuse(client, 4);
        });
        upstream.on("close", () => client.destroy());
        client.on("close", () => upstream.destroy());
      });
    };
    client.on("data", onData);
  });
  return new Promise((resolve, reject) => {
    let listening = false;
    // A failure to listen fails this preview; once listening, a server error
    // must not reach Node as an unhandled event either.
    server.on("error", (error) => {
      if (!listening) {
        dns?.close();
        reject(error);
      }
    });
    server.listen(0, "127.0.0.1", () => {
      listening = true;
      const address = server.address();
      resolve({
        port: typeof address === "object" && address !== null ? address.port : 0,
        close: () =>
          new Promise<void>((done) => {
            dns?.close();
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          })
      });
    });
  });
}
