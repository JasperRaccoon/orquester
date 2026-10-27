/**
 * Mac device hosts (devices spec §6.3): Blacksmith macOS boxes (`BoxPurpose` `"device-host"`,
 * `threadId: null`) the device service rents on demand and shares between chats; each lease gets
 * its own simulator (`orq-<leaseId>`), streamed by serve-sim through the box link
 * (`BoxConnection.forwardToHost`). Phase 2 adds Linux (KVM) pool boxes for Android; phase 3
 * paired BYO machines (`kind: "byo"`).
 *
 * SEAM — owned by the box-host work package. {@link createBoxHostFactory}'s signature is what
 * `wiring.ts` calls; today it adds no host and cannot `provision`, so an iOS request answers
 * `PLATFORM_NOT_READY`. The real factory re-adds the device-host boxes recorded before a restart in
 * `start`, rents one in `provision` (the box setup step `devices` prepares it), and quotes the rental
 * (price, and whether it needs the owner's `spend` card) in `provisionQuote`.
 */

import type { DevicesSettings } from "@orquester/api";

import type { DaemonBoxes } from "../../boxes/wiring.ts";
import type { DeviceHostFactory } from "../host.ts";
import type { DeviceToolchain } from "../toolchain/index.ts";

export interface BoxHostDeps {
  appDir: string;
  /** The Ephemeral AI VMs wiring (the box service, its registry and hub); null while that plugin is unavailable. */
  boxes: () => Pick<DaemonBoxes, "service" | "registry" | "hub"> | null;
  toolchain: DeviceToolchain;
  logger: Pick<Console, "info" | "warn" | "error">;
}

/** Whether renting a Mac host now needs a `spend` card (no standing "rent without asking"; the real factory also checks the monthly cap). */
export function macRentalNeedsApproval(settings: DevicesSettings): boolean {
  return !settings.ios.rentWithoutAsking;
}

export function createBoxHostFactory(_deps: BoxHostDeps): DeviceHostFactory {
  let settings: DevicesSettings | null = null;
  return {
    kind: "box",
    platforms: ["ios"],
    async start(context) {
      settings = context.settings();
    },
    // No `provision` and no quote yet: the real factory rents through the box service.
    provisionQuote() {
      return null;
    },
    settingsChanged(next) {
      settings = next;
    },
    async stop() {
      settings = null;
    }
  };
}
