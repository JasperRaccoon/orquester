/**
 * The local Android host (devices spec §6.2): Android emulators on this machine, booted by a
 * supervised `expo-device-hub --platform android` child from per-profile AVDs with a golden
 * snapshot, capacity `min(maxLocalDevices, (freeMem − 6 GB) / 3 GB, (cores − 2) / 2)`.
 *
 * SEAM — owned by the local-android work package. {@link createLocalAndroidHostFactory}'s
 * signature is what `wiring.ts` calls; today it adds a placeholder host (while Android is enabled
 * in Settings → Devices) whose readiness lists the checks the real host will probe — KVM, Node ≥ 22,
 * ffmpeg with libx264, the SDK packages, an AVD and snapshot per profile, the pinned tools — so
 * every surface already shows it. Replace the placeholder with the real host here; nothing else
 * needs to change.
 */

import { LOCAL_DEVICE_HOST_ID, LOCAL_DEVICE_HOST_LABEL, type DeviceReadinessCheck, type DevicesSettings } from "@orquester/api";

import type { DeviceHostFactory, DeviceHostFactoryContext } from "../host.ts";
import type { DeviceToolchain } from "../toolchain/index.ts";
import { PlaceholderDeviceHost } from "./placeholder.ts";

export interface LocalAndroidHostDeps {
  appDir: string;
  env: NodeJS.ProcessEnv;
  toolchain: DeviceToolchain;
  logger: Pick<Console, "info" | "warn" | "error">;
}

const PENDING = "Android emulators on this host are not available in this build yet.";

function placeholderChecks(settings: DevicesSettings): DeviceReadinessCheck[] {
  const missing = (id: string, label: string): DeviceReadinessCheck => ({ id, label, state: "missing", detail: "Not checked yet" });
  return [
    missing("kvm", "Hardware virtualization (/dev/kvm)"),
    missing("node", "Node.js 22 or newer"),
    missing("ffmpeg", "ffmpeg with libx264"),
    missing("android-sdk", "Android SDK (platform-tools, emulator)"),
    missing("system-image", "Android 15 system image"),
    ...settings.android.profiles.map((profile) => missing(`avd:${profile}`, `Emulator for ${profile}`)),
    missing("tool:expo-device-hub", "expo-device-hub"),
    missing("tool:agent-device", "agent-device")
  ];
}

export function createLocalAndroidHostFactory(_deps: LocalAndroidHostDeps): DeviceHostFactory {
  let ctx: DeviceHostFactoryContext | null = null;
  let present = false;

  const follow = (settings: DevicesSettings): void => {
    if (!ctx) return;
    if (settings.android.enabled) {
      ctx.addHost(new PlaceholderDeviceHost(LOCAL_DEVICE_HOST_ID, "local", LOCAL_DEVICE_HOST_LABEL, ["android"], placeholderChecks(settings), PENDING));
      present = true;
    } else if (present) {
      ctx.removeHost(LOCAL_DEVICE_HOST_ID);
      present = false;
    }
  };

  return {
    kind: "local",
    platforms: ["android"],
    async start(context) {
      ctx = context;
      follow(context.settings());
    },
    settingsChanged(settings) {
      follow(settings);
    },
    async stop() {
      if (ctx && present) ctx.removeHost(LOCAL_DEVICE_HOST_ID);
      present = false;
      ctx = null;
    }
  };
}
