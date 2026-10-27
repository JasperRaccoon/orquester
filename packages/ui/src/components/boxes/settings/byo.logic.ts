/**
 * Settings → Plugins → Ephemeral AI VMs: the "Your machines" card (Devices
 * phase 3 §2.1) — the owner's own always-on Mac or Linux machines, paired with
 * a one-line command, their live status, "Use for device simulators", and
 * removal. Pure: the component renders what these return.
 */

import { BOX_KIND_LABELS, type BoxSummary, type ByoMachineKind } from "@orquester/api";

import type { Tone } from "../../settings/primitives";

export const MACHINE_NAME_MAX = 60;

/** The owner's machines (paired, pairing or in use), oldest first. */
export function byoMachines(boxes: readonly BoxSummary[]): BoxSummary[] {
  return boxes
    .filter((box) => box.provider === "byo" && box.state !== "destroyed")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Why a typed name cannot be saved, or null. */
export function machineNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Give the machine a name.";
  if (trimmed.length > MACHINE_NAME_MAX) return `At most ${MACHINE_NAME_MAX} characters.`;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return "One line of text.";
  return null;
}

function pairingExpired(box: BoxSummary, now: number): boolean {
  const at = box.byo?.pairingExpiresAt ? Date.parse(box.byo.pairingExpiresAt) : Number.NaN;
  return Number.isFinite(at) && at <= now;
}

/** The status pill of a machine's row. */
export function byoStatusView(box: BoxSummary, now: number): { tone: Tone; label: string; title: string | null } {
  const title = box.stateReason;
  if (box.state === "pairing") {
    return pairingExpired(box, now) ? { tone: "warn", label: "Command expired", title } : { tone: "info", label: "Waiting to pair…", title };
  }
  if (box.state === "offline") return { tone: "warn", label: "Offline", title };
  if (box.purpose === "project") {
    const project = box.project ? `${box.project.workspace ? `${box.project.workspace} / ` : ""}${box.project.name}` : "a project";
    return { tone: box.state === "provisioning" ? "info" : "neutral", label: box.state === "provisioning" ? "Setting up a project…" : `In use: ${project}`, title };
  }
  if (box.purpose === "temporary") return { tone: "neutral", label: "Lent to an agent chat", title: box.purposeNote ?? title };
  if (box.state === "ready" && box.connected) return { tone: "ok", label: "Online", title };
  return { tone: "warn", label: "Reconnecting…", title };
}

/** "macOS · arm64" once it connected; the kind alone before. */
export function byoSubline(box: BoxSummary): string {
  return [BOX_KIND_LABELS[box.kind], box.arch].filter(Boolean).join(" · ");
}

/** What happens when the machine is removed, for the confirmation. */
export function removeMachineText(box: BoxSummary): string {
  if (box.state === "pairing") return "Its pairing command stops working.";
  if (box.connected) {
    return "Its orq-agent removes its service and stops; its credential is revoked. Nothing else on the machine changes.";
  }
  return "It is offline, so it can't uninstall itself: its credential is revoked now. Run `orq-agent uninstall-service` on the machine to remove the service.";
}

/** Remove is offered while nothing uses the machine (a project or chat must give it back first). */
export function canRemoveMachine(box: BoxSummary): boolean {
  return box.purpose === "machine";
}

/** "Use for device simulators" can be switched on a paired machine of a kind that can host devices. */
export function canHostDevices(box: BoxSummary): boolean {
  return box.state !== "pairing";
}

/** What to tell the owner about where the pairing command runs. */
export function pairingHint(kind: ByoMachineKind): string {
  return kind === "macos"
    ? "Run it in Terminal on the Mac, as the user who stays logged in (not with sudo): orq-agent runs in that user's session, which Simulator needs."
    : "Run it in a terminal on the machine. As root it installs a system service; as yourself, a user service (it tells you how to keep it running after you log out).";
}

export type PairingPhase =
  /** The command is shown; nothing ran it yet. */
  | { kind: "waiting"; expiresInMinutes: number }
  /** The script was downloaded; orq-agent has not connected yet. */
  | { kind: "downloaded" }
  | { kind: "connected"; detail: string }
  | { kind: "expired" }
  /** The machine was removed (cancelled) meanwhile. */
  | { kind: "gone" };

/**
 * Where a pairing the dialog started stands, from the live box (`undefined`:
 * no longer listed). `expiresAt` is the command's own expiry.
 */
export function pairingPhase(box: BoxSummary | undefined, expiresAt: string, now: number): PairingPhase {
  if (!box) return { kind: "gone" };
  if (box.state !== "pairing") {
    return { kind: "connected", detail: [box.os === "darwin" ? "macOS" : box.os === "linux" ? "Linux" : null, box.arch].filter(Boolean).join(", ") };
  }
  // The daemon drops the expiry once the script was fetched (the code is spent).
  if (box.byo && box.byo.pairingExpiresAt === null) return { kind: "downloaded" };
  const left = Date.parse(expiresAt) - now;
  if (!Number.isFinite(left) || left <= 0) return { kind: "expired" };
  return { kind: "waiting", expiresInMinutes: Math.max(1, Math.ceil(left / 60_000)) };
}
