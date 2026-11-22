/**
 * Machines — the owner's policy for every tailnet machine and paired bring-your-own machine
 * (spec docs/superpowers/specs/2026-11-22-tailnet-machines-and-agent-ssh-design.md §4.1, §4.2, §4.8).
 *
 * - `machines.json` ({@link parseMachinesFile}, path helper `machinesStorePath` in `index.ts`):
 *   one record per machine id (`ts:<StableID>` or `box:<boxId>`, see `@orquester/api` `machines.ts`)
 *   with its visibility, capabilities, SSH overrides, the paired box and Wake-on-LAN details.
 *   Discovered facts (hostname, OS, online) are never stored here: they come live from Tailscale.
 * - Tolerant: records are read one by one; a record this build cannot read is kept verbatim, and
 *   unknown keys (top level and inside records) survive a rewrite. Enum-like fields are plain
 *   strings so a newer build's values are not dropped; {@link resolveMachinePolicy} narrows them.
 *
 * The transport contracts (`@orquester/api` `machines.ts`) re-export the policy types.
 */

import { z } from "zod";

export const MACHINES_STORE_VERSION = 1;

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Who may use a machine (spec §4.1.3): `hidden` — only the owner sees it, in Settings, and
 * Orquester never connects to it; `ask` — visible to agents, every use goes through an approval
 * card; `free` — visible to agents and used without a card.
 */
export type MachineVisibility = "hidden" | "ask" | "free";
export const MACHINE_VISIBILITIES: readonly MachineVisibility[] = ["hidden", "ask", "free"];

export function isMachineVisibility(value: unknown): value is MachineVisibility {
  return typeof value === "string" && (MACHINE_VISIBILITIES as readonly string[]).includes(value);
}

/**
 * What a visible machine may be used for (spec §4.1.4); a capability that is off behaves like
 * `hidden` for that purpose. `devices`: device simulators; `commands`: commands and SSH (`ssh
 * orq-<name>`, box exec); `chats`: agent chats and projects placed on it.
 */
export interface MachineCapabilities {
  devices: boolean;
  commands: boolean;
  chats: boolean;
}

export type MachineCapability = keyof MachineCapabilities;
export const MACHINE_CAPABILITIES: readonly MachineCapability[] = ["devices", "commands", "chats"];

/** A machine's effective visibility and capabilities. */
export interface MachinePolicy {
  visibility: MachineVisibility;
  capabilities: MachineCapabilities;
}

/** Every newly discovered tailnet peer: hidden, with every capability off (spec §4.1.3). */
export const NEW_TAILNET_PEER_POLICY: Readonly<MachinePolicy> = Object.freeze({
  visibility: "hidden",
  capabilities: Object.freeze({ devices: false, commands: false, chats: false })
});

/**
 * The migration rule for a bring-your-own machine paired before machine policies existed (spec
 * §4.1.5): `ask`, with `devices` carried over from its box record's `deviceHost` flag and commands
 * and chats on — so nothing changes until the owner chooses.
 */
export function migratedByoMachinePolicy(box: { deviceHost?: boolean }): MachinePolicy {
  return { visibility: "ask", capabilities: { devices: box.deviceHost === true, commands: true, chats: true } };
}

/**
 * The policy a machine runs under, the single resolution point:
 * - a stored record with a known `visibility` wins; a capability it lacks (or holds as a
 *   non-boolean) reads as off;
 * - a stored `visibility` this build does not know reads as `hidden` with everything off — never
 *   more open than the owner chose;
 * - no record: a paired box (`byo` given) gets {@link migratedByoMachinePolicy}; anything else
 *   {@link NEW_TAILNET_PEER_POLICY}.
 */
export function resolveMachinePolicy(stored: StoredMachine | undefined, byo?: { deviceHost?: boolean }): MachinePolicy {
  if (!stored || stored.visibility === undefined) {
    return byo ? migratedByoMachinePolicy(byo) : { ...NEW_TAILNET_PEER_POLICY, capabilities: { ...NEW_TAILNET_PEER_POLICY.capabilities } };
  }
  if (!isMachineVisibility(stored.visibility)) {
    return { ...NEW_TAILNET_PEER_POLICY, capabilities: { ...NEW_TAILNET_PEER_POLICY.capabilities } };
  }
  const caps = stored.capabilities ?? {};
  return {
    visibility: stored.visibility,
    capabilities: { devices: caps.devices === true, commands: caps.commands === true, chats: caps.chats === true }
  };
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * Per-machine SSH overrides for "Pair over SSH" (spec §4.2.1). Absent fields use the host's SSH
 * setup (`~/.ssh/config`, default key `~/.ssh/id_ed25519`). `alias` names an existing
 * `~/.ssh/config` host to connect through instead of the machine's tailnet name.
 */
export const storedMachineSshSchema = z
  .object({
    user: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    /** Absolute path of the private key on the daemon's machine (never its contents). */
    identityFile: z.string().min(1).optional(),
    alias: z.string().min(1).optional()
  })
  .passthrough();
export type StoredMachineSsh = z.infer<typeof storedMachineSshSchema>;

/** One wired NIC as `orq-agent` last reported it (box protocol `BoxNic`), for Wake-on-LAN (spec §4.8). */
export const storedWolNicSchema = z
  .object({
    /** Interface name on the machine (`enp5s0`, `Ethernet`). */
    name: z.string().optional(),
    /** `aa:bb:cc:dd:ee:ff`, lowercase. */
    mac: z.string().min(1),
    ipv4: z.string().nullable().default(null),
    prefixLength: z.number().int().min(0).max(32).nullable().default(null),
    broadcast: z.string().nullable().default(null),
    /** Wake-on-magic-packet is enabled on the NIC; null when the OS would not say. */
    wolEnabled: z.boolean().nullable().default(null)
  })
  .passthrough();
export type StoredWolNic = z.infer<typeof storedWolNicSchema>;

/** The Wake-on-LAN details of a machine; `nics` is read entry by entry (an unreadable NIC is dropped). */
export const storedMachineWolSchema = z
  .object({
    nics: z
      .array(z.unknown())
      .default([])
      .transform((entries) => entries.flatMap((entry) => {
        const parsed = storedWolNicSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      })),
    /** ISO time of the report these came from. */
    updatedAt: z.string()
  })
  .passthrough();
export type StoredMachineWol = z.infer<typeof storedMachineWolSchema>;

/**
 * One machine's record, keyed by machine id in {@link MachinesFile.machines}. `visibility` is a
 * plain string (read it through {@link resolveMachinePolicy}); `capabilities` fields are optional
 * so a partial record still parses.
 */
export const storedMachineSchema = z
  .object({
    visibility: z.string().optional(),
    capabilities: z
      .object({ devices: z.boolean().optional(), commands: z.boolean().optional(), chats: z.boolean().optional() })
      .passthrough()
      .optional(),
    ssh: storedMachineSshSchema.optional(),
    /** The paired bring-your-own box record (`boxes.json`) this machine is, when paired. */
    byoBoxId: z.string().min(1).optional(),
    wol: storedMachineWolSchema.optional(),
    /** ISO time the owner last changed this record. */
    updatedAt: z.string().optional()
  })
  .passthrough();
export type StoredMachine = z.infer<typeof storedMachineSchema>;

/** A read `machines.json`, with everything this build cannot use kept verbatim. */
export interface MachinesFile {
  version: typeof MACHINES_STORE_VERSION;
  /** Machine id → readable record. */
  machines: Record<string, StoredMachine>;
  /** Machine id → a record that failed the schema, as found (written back unchanged). */
  rejected: Record<string, unknown>;
  /** Every top-level key but `version` and `machines`, as found. */
  extra: Record<string, unknown>;
}

export function createDefaultMachinesFile(): MachinesFile {
  return { version: MACHINES_STORE_VERSION, machines: {}, rejected: {}, extra: {} };
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Record-wise tolerant read. The OUTER shape throws (not an object, `machines` not an object, a
 * `version` other than 1), like the device stores: the daemon then moves the file aside.
 */
export function parseMachinesFile(raw: unknown): MachinesFile {
  if (!isRecord(raw)) throw new Error("Not a machines file (the file is not a JSON object)");
  if (raw.version !== undefined && raw.version !== MACHINES_STORE_VERSION) {
    throw new Error(`Not a version-${MACHINES_STORE_VERSION} machines file (version ${JSON.stringify(raw.version)})`);
  }
  if (raw.machines !== undefined && !isRecord(raw.machines)) throw new Error("Not a machines file (machines: expected an object)");
  const machines: Record<string, StoredMachine> = {};
  const rejected: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(raw.machines ?? {})) {
    const parsed = storedMachineSchema.safeParse(entry);
    if (parsed.success && id.length > 0) machines[id] = parsed.data;
    else rejected[id] = entry;
  }
  const extra = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "version" && key !== "machines"));
  return { version: MACHINES_STORE_VERSION, machines, rejected, extra };
}

/** The on-disk JSON. A readable record replaces an unreadable one under the same id. */
export function serializeMachinesFile(file: MachinesFile): Record<string, unknown> {
  return { ...file.extra, version: MACHINES_STORE_VERSION, machines: { ...file.rejected, ...file.machines } };
}
