/**
 * The local Android host's readiness checklist (devices spec §6.2), built from one probe. Pure:
 * `local-android.ts` gathers the probe, this turns it into checks with fix action ids the setup
 * job runs. KVM, Node, ffmpeg and Java have no fix action: the owner fixes those on the machine.
 * Golden snapshots are not a check: each is made the first time its profile is opened.
 */

import { ANDROID_SYSTEM_IMAGE, type DeviceReadinessCheck } from "@orquester/api";

export const FIX_ACTIONS = {
  sdk: "install-android-sdk",
  systemImage: "install-system-image",
  avd: (profile: string) => `create-avd:${profile}`,
  snapshot: (profile: string) => `create-snapshot:${profile}`,
  tool: (name: string) => `install-tool:${name}`
} as const;

/** How this process can open /dev/kvm. */
export type KvmProbe = { access: "direct" } | { access: "sg" } | { access: "denied"; detail: string } | { access: "missing" };

export interface ReadinessProbe {
  kvm: KvmProbe;
  nodeVersion: string;
  ffmpeg: "libx264" | "no-libx264" | "missing";
  java: boolean;
  packages: { cmdlineTools: boolean; platformTools: boolean; emulator: boolean; systemImage: boolean };
  /** `outdated`: made for an older config; it is made again on the profile's next open (not a blocker). */
  avds: { profile: string; label: string; created: boolean; snapshot: boolean; outdated?: boolean }[];
  tools: { name: string; version: string; installed: boolean }[];
}

export const MIN_NODE_MAJOR = 22;

export function nodeMajor(version: string): number {
  return Number(/^v?(\d+)/.exec(version)?.[1] ?? 0);
}

export function evaluateReadiness(probe: ReadinessProbe): DeviceReadinessCheck[] {
  const checks: DeviceReadinessCheck[] = [];
  const ok = (id: string, label: string, detail: string | null, fixActionId?: string): DeviceReadinessCheck => ({ id, label, state: "ok", detail, ...(fixActionId ? { fixActionId } : {}) });
  const missing = (id: string, label: string, detail: string | null, fixActionId?: string): DeviceReadinessCheck => ({ id, label, state: "missing", detail, ...(fixActionId ? { fixActionId } : {}) });
  const error = (id: string, label: string, detail: string): DeviceReadinessCheck => ({ id, label, state: "error", detail });

  const kvmLabel = "Hardware virtualization (/dev/kvm)";
  switch (probe.kvm.access) {
    case "direct":
      checks.push(ok("kvm", kvmLabel, "Available"));
      break;
    case "sg":
      checks.push(ok("kvm", kvmLabel, "Available through the kvm group (sg kvm); restart Orquester with SupplementaryGroups=kvm to use it directly"));
      break;
    case "denied":
      checks.push(error("kvm", kvmLabel, probe.kvm.detail));
      break;
    case "missing":
      checks.push(error("kvm", kvmLabel, "This machine has no /dev/kvm: enable virtualization (VT-x/AMD-V) or nested virtualization."));
      break;
  }

  const major = nodeMajor(probe.nodeVersion);
  checks.push(major >= MIN_NODE_MAJOR ? ok("node", "Node.js 22 or newer", probe.nodeVersion) : error("node", "Node.js 22 or newer", `Orquester runs on Node ${probe.nodeVersion}; the device tools need ${MIN_NODE_MAJOR} or newer.`));

  const ffmpegLabel = "ffmpeg with libx264";
  if (probe.ffmpeg === "libx264") checks.push(ok("ffmpeg", ffmpegLabel, "Found"));
  else if (probe.ffmpeg === "no-libx264") checks.push(error("ffmpeg", ffmpegLabel, "ffmpeg has no libx264 encoder; install a build with it (apt install ffmpeg)."));
  else checks.push(missing("ffmpeg", ffmpegLabel, "Install ffmpeg on this machine (apt install ffmpeg)."));

  const sdkReady = probe.packages.cmdlineTools && probe.packages.platformTools && probe.packages.emulator;
  const needsJava = !sdkReady || !probe.packages.systemImage || probe.avds.some((avd) => !avd.created);
  if (needsJava) {
    checks.push(probe.java ? ok("java", "Java 17 or newer", "Found") : missing("java", "Java 17 or newer", "The Android SDK tools need Java: install a JDK 17 (apt install openjdk-17-jre-headless)."));
  }

  const sdkLabel = "Android SDK (platform-tools, emulator)";
  if (sdkReady) checks.push(ok("android-sdk", sdkLabel, "Installed", FIX_ACTIONS.sdk));
  else {
    const absent = [!probe.packages.cmdlineTools && "command-line tools", !probe.packages.platformTools && "platform-tools", !probe.packages.emulator && "emulator"].filter(Boolean).join(", ");
    checks.push(missing("android-sdk", sdkLabel, `Not installed: ${absent}`, FIX_ACTIONS.sdk));
  }
  const imageLabel = "Android 15 system image";
  checks.push(probe.packages.systemImage ? ok("system-image", imageLabel, ANDROID_SYSTEM_IMAGE, FIX_ACTIONS.systemImage) : missing("system-image", imageLabel, "Not installed (about 2.3 GB to download)", FIX_ACTIONS.systemImage));

  for (const avd of probe.avds) {
    const id = `avd:${avd.profile}`;
    const label = `Emulator for ${avd.label}`;
    checks.push(
      avd.created
        ? ok(id, label, avd.snapshot ? "Ready" : "Ready; prepared on first use (about 4 minutes, once)", FIX_ACTIONS.avd(avd.profile))
        : avd.outdated
          ? ok(id, label, "Updated on its next open (about 4 minutes, once)", FIX_ACTIONS.avd(avd.profile))
          : missing(id, label, "Not created yet", FIX_ACTIONS.avd(avd.profile))
    );
  }

  for (const tool of probe.tools) {
    const id = `tool:${tool.name}`;
    checks.push(tool.installed ? ok(id, tool.name, tool.version, FIX_ACTIONS.tool(tool.name)) : missing(id, tool.name, `Not installed (${tool.version})`, FIX_ACTIONS.tool(tool.name)));
  }
  return checks;
}

/** `ffmpeg -encoders` output → whether libx264 is there. */
export function ffmpegHasLibx264(encoders: string): boolean {
  return /\blibx264\b/.test(encoders);
}

/** The members of a group in `/etc/group` text. */
export function groupMembers(etcGroup: string, group: string): string[] {
  for (const line of etcGroup.split("\n")) {
    const [name, , , members] = line.split(":");
    if (name === group) return (members ?? "").split(",").map((member) => member.trim()).filter(Boolean);
  }
  return [];
}
