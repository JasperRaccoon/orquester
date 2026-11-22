/**
 * Telling a Tailscale (tailnet) address from any other (spec
 * docs/superpowers/specs/2026-11-22-tailnet-machines-and-agent-ssh-design.md §4.7.5). Everywhere
 * Orquester labels an address as tailnet uses these helpers.
 *
 * An address is tailnet when:
 * - it is in Tailscale's IPv6 range `fd7a:115c:a1e0::/48` (only Tailscale hands those out), or
 * - it sits on an interface named `tailscale*` (Linux, Windows), or
 * - it sits on a `utun*` interface (macOS) that also carries a Tailscale IPv6 address.
 *
 * `100.64.0.0/10` alone is NOT enough: that CGNAT range is shared with other VPNs (Cloudflare WARP
 * hands out `100.96.x.y` on its own `utun`/`CloudflareWARP` interface) and with carrier NAT. Host
 * names under `.ts.net` are MagicDNS names, so tailnet too.
 *
 * Pure: the daemon passes `os.networkInterfaces()`, a client passes the host it dials.
 */

/** Tailscale's IPv6 ULA prefix (`fd7a:115c:a1e0::/48`), as its first three 16-bit groups. */
export const TAILSCALE_IPV6_PREFIX = "fd7a:115c:a1e0::/48";
const TAILSCALE_IPV6_GROUPS = [0xfd7a, 0x115c, 0xa1e0] as const;

/** The 8 groups of an IPv6 address (brackets and a `%zone` allowed), or null when it is not one. */
function ipv6Groups(text: string): number[] | null {
  let value = text.trim();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  if (!value.includes(":")) return null;
  // An embedded IPv4 tail (`::ffff:1.2.3.4`) counts as two groups.
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) {
    const bytes = v4.slice(1).map(Number);
    if (bytes.some((byte) => byte > 255)) return null;
    value = `${value.slice(0, v4.index)}${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    if (groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
    return groups.map((group) => parseInt(group, 16));
  };
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/** Whether `address` is in Tailscale's IPv6 range `fd7a:115c:a1e0::/48`. */
export function isTailscaleIpv6(address: string): boolean {
  const groups = ipv6Groups(address);
  return groups !== null && TAILSCALE_IPV6_GROUPS.every((group, index) => groups[index] === group);
}

/** Whether an interface name is Tailscale's own (`tailscale0`, Windows' `Tailscale`). */
export function isTailscaleInterfaceName(name: string): boolean {
  return /^tailscale/i.test(name.trim());
}

/** One interface address, as `os.networkInterfaces()` lists them. */
export interface InterfaceAddress {
  address: string;
  family?: string | number;
}

/**
 * Whether `address` is a tailnet address. Give the interface it sits on (`interfaceName`, and every
 * address on that interface) when known: without them only the Tailscale IPv6 range counts.
 */
export function isTailnetAddress(address: string, iface?: { name: string; addresses?: readonly InterfaceAddress[] }): boolean {
  if (isTailscaleIpv6(address)) return true;
  if (!iface) return false;
  if (isTailscaleInterfaceName(iface.name)) return true;
  // macOS names every tunnel utunN: Tailscale's is the one that also carries a Tailscale IPv6.
  if (/^utun\d*$/i.test(iface.name.trim())) return (iface.addresses ?? []).some((entry) => isTailscaleIpv6(entry.address));
  return false;
}

/** A tailnet address of this machine, with the interface it was found on. */
export interface TailnetInterfaceAddress {
  interface: string;
  address: string;
  family: "IPv4" | "IPv6";
}

/**
 * The tailnet addresses in an `os.networkInterfaces()` map, IPv4 first, link-local addresses left out
 * (they are the interface's own, not the tailnet's).
 */
export function tailnetAddressesOf(interfaces: Readonly<Record<string, readonly InterfaceAddress[] | undefined>>): TailnetInterfaceAddress[] {
  const found: TailnetInterfaceAddress[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    const addresses = entries ?? [];
    for (const entry of addresses) {
      const family = entry.family === 6 || entry.family === "IPv6" || entry.address.includes(":") ? "IPv6" : "IPv4";
      if (family === "IPv6" && /^fe80:/i.test(entry.address)) continue;
      if (isTailnetAddress(entry.address, { name, addresses })) found.push({ interface: name, address: entry.address, family });
    }
  }
  return found.sort((a, b) => (a.family === b.family ? 0 : a.family === "IPv4" ? -1 : 1));
}

/**
 * Whether a host a client dials (a URL's hostname, bracketed IPv6 allowed) is on the tailnet: a
 * MagicDNS name (`*.ts.net`) or a Tailscale IPv6 address. A bare `100.x.y.z` is not enough (see the
 * module note).
 */
export function isTailnetHost(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/\.$/, "");
  if (name.endsWith(".ts.net")) return true;
  return isTailscaleIpv6(name);
}
