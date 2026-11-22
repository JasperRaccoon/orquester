/**
 * Settings → Machines (tailnet machines spec 2026-11-22 §4.1, §4.2, §6): the pure parts — the state
 * badge, which actions a machine offers, and the "Pair over SSH" form's validation. The daemon
 * decides and enforces every policy; these only choose what to show and what to send.
 */

import type { MachineCapability, MachineState, MachineSummary, MachineVisibility, PairMachineOverSshRequest, WakeMachineResponse } from "@orquester/api";

import type { Tone } from "./primitives";

export const VISIBILITY_OPTIONS: readonly { value: MachineVisibility; label: string; explanation: string }[] = [
  { value: "hidden", label: "Hidden", explanation: "Only you see it, here. Agents are never told about it, and Orquester never connects to it." },
  { value: "ask", label: "Ask first", explanation: "Agents may see it; every chat that wants to use it asks you on an approval card." },
  { value: "free", label: "Free use", explanation: "Agents may see it and use it for what is switched on below, without asking." }
];

export const CAPABILITY_OPTIONS: readonly { value: MachineCapability; label: string; description: string }[] = [
  { value: "devices", label: "Device simulators", description: "iOS simulators and Android emulators for chats run here." },
  { value: "commands", label: "Commands and SSH", description: "Chats may run commands here, and `ssh orq-<name>` reaches it." },
  { value: "chats", label: "Agent chats and projects", description: "Projects and agent chats may be placed on it." }
];

export function machineStateView(machine: Pick<MachineSummary, "state" | "self">): { label: string; tone: Tone } {
  if (machine.self) return { label: "This server", tone: "info" };
  const views: Record<MachineState, { label: string; tone: Tone }> = {
    ready: { label: "Ready", tone: "ok" },
    pairing: { label: "Pairing…", tone: "info" },
    offline: { label: "Offline", tone: "warn" },
    asleep: { label: "Asleep or off", tone: "neutral" },
    "not-paired": { label: "Not paired", tone: "neutral" }
  };
  return views[machine.state];
}

/** "Pair over SSH" is offered on a tailnet machine that is not paired and runs an OS Orquester pairs. */
export function canPairOverSsh(machine: Pick<MachineSummary, "self" | "state" | "os" | "dnsName" | "hostname">): boolean {
  return machine.self !== true && machine.state === "not-paired" && machine.os !== "other" && (machine.dnsName !== null || machine.hostname !== null);
}

/** Wake is offered on a machine that is asleep and that something can send the magic packet to. */
export function canWake(machine: Pick<MachineSummary, "self" | "state" | "wake">): boolean {
  return machine.self !== true && machine.state === "asleep" && machine.wake.canWake;
}

/** The name of the machine that would send (or sent) a wake, when it is in the list. */
export function wakeSenderName(via: string | null | undefined, machines: readonly Pick<MachineSummary, "id" | "name">[] | null): string | null {
  if (!via) return null;
  return machines?.find((machine) => machine.id === via)?.name ?? null;
}

/** What the Wake button reports: the wake went out (through which machine), or why not and the fix. */
export function wakeResultView(
  result: WakeMachineResponse,
  machine: Pick<MachineSummary, "name">,
  machines: readonly Pick<MachineSummary, "id" | "name">[] | null
): { sent: boolean; text: string } {
  if (result.sent) {
    const via = wakeSenderName(result.via, machines);
    return { sent: true, text: `Wake sent${via ? ` through ${via}` : ""}. ${machine.name} shows Ready once it is back on the tailnet.` };
  }
  if (!result.problem) return { sent: false, text: "Nothing could send the wake." };
  return { sent: false, text: result.problem.fix ? `${result.problem.message} Fix: ${result.problem.fix}` : result.problem.message };
}

/** Remove unpairs a paired machine (never the server itself). */
export function canRemove(machine: Pick<MachineSummary, "self" | "boxId">): boolean {
  return machine.self !== true && machine.boxId !== null;
}

/** The passwordless-sudo warning applies where agents may run commands or SSH. */
export function showsRootWarning(machine: Pick<MachineSummary, "sudo" | "visibility" | "capabilities">): boolean {
  return machine.sudo.passwordless === true && machine.visibility !== "hidden" && machine.capabilities.commands;
}

export interface PairForm {
  user: string;
  port: string;
  identityFile: string;
  sshAlias: string;
}

export const EMPTY_PAIR_FORM: PairForm = { user: "", port: "", identityFile: "", sshAlias: "" };

const SSH_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

/** The request for a filled form (blank fields use the server's SSH setup), or the first problem with it. */
export function pairRequestOf(form: PairForm): { request: PairMachineOverSshRequest } | { error: string; field: keyof PairForm } {
  const user = form.user.trim();
  const port = form.port.trim();
  const identityFile = form.identityFile.trim();
  const sshAlias = form.sshAlias.trim();
  if (user && !SSH_TOKEN.test(user)) return { error: "The user is one word: letters, digits, '.', '_', '@' or '-'.", field: "user" };
  if (port && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return { error: "The port is a number from 1 to 65535.", field: "port" };
  if (identityFile && !identityFile.startsWith("/")) return { error: "Give the key's full path on the Orquester server, starting with /.", field: "identityFile" };
  if (sshAlias && !SSH_TOKEN.test(sshAlias)) return { error: "The alias is a Host name from ~/.ssh/config on the Orquester server.", field: "sshAlias" };
  return {
    request: {
      ...(user ? { user } : {}),
      ...(port ? { port: Number(port) } : {}),
      ...(identityFile ? { identityFile } : {}),
      ...(sshAlias ? { sshAlias } : {})
    }
  };
}
