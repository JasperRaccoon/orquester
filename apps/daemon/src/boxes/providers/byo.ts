/**
 * Bring-your-own machines (Devices phase 3 §2.1): the owner's own always-on Mac or Linux machine,
 * paired once with a one-line command (`service/byo.ts`). Nothing is rented, so this adapter makes
 * no call anywhere: it costs nothing, has no credentials and no deadline, lists no managed
 * instances (the reconciler never sweeps or destroys a machine), and `create` refuses — a machine
 * is paired, never created. Its offers are the machines themselves ({@link byoOffers}), built by
 * the box settings from the records: one "size" per idle, connected machine of the kind.
 */

import { BYO_MACHINE_KINDS, type BoxKind, type BoxRegionOffer, type BoxSizeOffer } from "@orquester/api";
import type { StoredBox } from "@orquester/config";

import type { BoxProviderAdapter, ProviderOffers } from "../contracts.ts";

/** The one "region" of every machine. */
export const BYO_REGION: BoxRegionOffer = { id: "own", label: "Your machine", country: null };

export const byoAdapter: BoxProviderAdapter = {
  id: "byo",
  label: "Your machines",
  kinds: BYO_MACHINE_KINDS,
  website: "",
  credentialsUrl: "",
  credentialFields: [],
  accountNote: "Your own always-on Mac or Linux machine, paired with a one-line command. Free; Orquester never deletes it.",
  maxLifetimeMinutes: null,
  validate: async () => ({ ok: true }),
  offers: async (): Promise<ProviderOffers> => ({ sizes: [], regions: [BYO_REGION], images: [], priceSource: "table" }),
  create: async () => {
    throw new Error("Bring-your-own machines are paired (Settings → Plugins → Ephemeral AI VMs → Add your machine), not created.");
  },
  // Never reached (no credentials, so the reconciler asks nothing): a machine is there while it is paired.
  status: async () => ({ state: "running", detail: null, publicIp: null, hourlyUsd: 0 }),
  destroy: async () => undefined,
  listManaged: async () => []
};

/**
 * A paired machine nobody uses that is connected now: a project or a chat may take it. A machine
 * marked "Use for device simulators" never is — the device service owns it (its hub, simulators
 * and the owner's account), so a chat or project must not run commands there.
 */
export function byoMachineIdle(record: StoredBox, connected: boolean): boolean {
  return record.provider === "byo" && record.purpose === "machine" && record.deviceHost !== true && record.state === "ready" && connected;
}

/** "Mac mini (macOS, arm64)". */
export function byoMachineLabel(record: StoredBox): string {
  const name = record.machineName ?? record.name;
  const details = [record.os === "darwin" ? "macOS" : record.os === "linux" ? "Linux" : null, record.arch ?? null].filter(Boolean);
  return details.length > 0 ? `${name} (${details.join(", ")})` : name;
}

/**
 * The machines a project or a chat may use for `kind`, as offers: one size per idle, connected
 * machine (price 0), in the one {@link BYO_REGION}. Machines marked as device hosts are never
 * offered ({@link byoMachineIdle}).
 */
export function byoOffers(records: readonly StoredBox[], kind: BoxKind, connected: (boxId: string) => boolean): ProviderOffers {
  const sizes: BoxSizeOffer[] = records
    .filter((record) => record.kind === kind && byoMachineIdle(record, connected(record.id)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((record) => ({
      id: record.id,
      label: byoMachineLabel(record),
      vcpu: 0,
      ramGb: 0,
      diskGb: null,
      gpu: null,
      hourlyUsd: 0,
      regions: []
    }));
  return { sizes, regions: [BYO_REGION], images: [], priceSource: "table" };
}
