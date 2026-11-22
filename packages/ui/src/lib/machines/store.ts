/**
 * Machines (tailnet machines spec 2026-11-22 §4.1, §6) — the client's copy of the daemon's machine
 * list: loaded by Settings → Machines, kept live by `MACHINES_CHANGED_EVENT` on
 * `MACHINES_CHANNEL` (routed here by the app store), forgotten on a connection switch.
 *
 * Everything the daemon sends is shape-checked first ({@link sanitizeMachinesResponse}): a machine
 * this client cannot read is dropped, never half-applied; a payload whose outer shape is wrong is
 * ignored. The daemon decides and enforces every policy; this store only shows it.
 */

import { useSyncExternalStore } from "react";
import { createStore } from "zustand/vanilla";

import {
  isMachineProblemCode,
  isMachineVisibility,
  MACHINE_STATES,
  MACHINES_CHANGED_EVENT,
  type MachineOs,
  type MachineProblem,
  type MachineResponse,
  type MachinesResponse,
  type MachineState,
  type MachineSummary,
  type PairMachineOverSshRequest,
  type PairMachineOverSshResponse,
  type RemoveMachineResponse,
  type UpdateMachineRequest,
  type WakeMachineResponse
} from "@orquester/api";

/** The client calls the store makes (`ApiClient` satisfies it; tests pass a fake). */
export interface MachinesApi {
  readonly connection?: { id: string };
  listMachines(signal?: AbortSignal): Promise<MachinesResponse>;
  updateMachine(id: string, req: UpdateMachineRequest): Promise<MachineResponse>;
  removeMachine(id: string): Promise<RemoveMachineResponse>;
  pairMachineOverSsh(id: string, req: PairMachineOverSshRequest): Promise<PairMachineOverSshResponse>;
  wakeMachine(id: string): Promise<WakeMachineResponse>;
}

export interface MachinesState {
  /** Null until the first list arrived on this connection. */
  machines: readonly MachineSummary[] | null;
  /** Daemon-wide problems (Tailscale unavailable on the Orquester host). */
  problems: readonly MachineProblem[];
}

const INITIAL: MachinesState = { machines: null, problems: [] };

export const machinesStore = createStore<MachinesState>(() => INITIAL);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): value is string => typeof value === "string";
const strOrNull = (value: unknown): string | null => (str(value) ? value : null);
const OSES: readonly MachineOs[] = ["linux", "macos", "windows", "other"];

function readProblem(value: unknown): MachineProblem | null {
  if (!isRecord(value) || !isMachineProblemCode(value.code) || !str(value.message)) return null;
  return {
    code: value.code,
    message: value.message,
    ...(str(value.machineId) ? { machineId: value.machineId } : {}),
    ...(str(value.fix) ? { fix: value.fix } : {})
  };
}

const problemsOf = (value: unknown): MachineProblem[] => (Array.isArray(value) ? value.flatMap((entry) => readProblem(entry) ?? []) : []);

/** One machine, or null when its id, state, visibility or capabilities cannot be read. */
export function sanitizeMachine(value: unknown): MachineSummary | null {
  if (!isRecord(value) || !str(value.id) || !str(value.name)) return null;
  if (!(MACHINE_STATES as readonly unknown[]).includes(value.state) || !isMachineVisibility(value.visibility)) return null;
  const caps = value.capabilities;
  if (!isRecord(caps) || typeof caps.devices !== "boolean" || typeof caps.commands !== "boolean" || typeof caps.chats !== "boolean") return null;
  const wake = isRecord(value.wake) ? value.wake : {};
  const sudo = isRecord(value.sudo) ? value.sudo : {};
  return {
    id: value.id,
    name: value.name,
    hostname: strOrNull(value.hostname),
    dnsName: strOrNull(value.dnsName),
    os: (OSES as readonly unknown[]).includes(value.os) ? (value.os as MachineOs) : "other",
    tailnetIps: Array.isArray(value.tailnetIps) ? value.tailnetIps.filter(str) : [],
    online: value.online === true,
    lastSeenAt: strOrNull(value.lastSeenAt),
    state: value.state as MachineState,
    visibility: value.visibility,
    capabilities: { devices: caps.devices, commands: caps.commands, chats: caps.chats },
    boxId: strOrNull(value.boxId),
    ...(value.self === true ? { self: true } : {}),
    ...(str(value.sshAlias) ? { sshAlias: value.sshAlias } : {}),
    wake: { canWake: wake.canWake === true, ...(str(wake.via) ? { via: wake.via } : {}) },
    sudo: typeof sudo.passwordless === "boolean" ? { passwordless: sudo.passwordless } : {},
    problems: problemsOf(value.problems)
  };
}

/** A list answer or `machines.changed` payload; null when it is not one. */
export function sanitizeMachinesResponse(value: unknown): MachinesResponse | null {
  if (!isRecord(value) || !Array.isArray(value.machines)) return null;
  return { machines: value.machines.flatMap((entry) => sanitizeMachine(entry) ?? []), problems: problemsOf(value.problems) };
}

// ---------------------------------------------------------------------------
// Loading, events, mutations
// ---------------------------------------------------------------------------

/** Bumped by every list written (event or answer): a load that started before is stale. */
let revision = 0;
/** Bumped by a reset: an answer from before it is dropped. */
let generation = 0;
let boundConnectionId: string | null = null;

function bind(api: MachinesApi): void {
  const id = api.connection?.id;
  if (id === undefined) return;
  if (boundConnectionId !== null && boundConnectionId !== id) resetMachines();
  boundConnectionId = id;
}

function write(response: MachinesResponse): void {
  revision += 1;
  machinesStore.setState({ machines: response.machines, problems: response.problems });
}

/** Forget everything (a connection switch). */
export function resetMachines(): void {
  generation += 1;
  revision += 1;
  boundConnectionId = null;
  machinesStore.setState(INITIAL);
}

/** Load the list; rejects with the request's error (the section shows it). */
export async function loadMachines(api: MachinesApi, signal?: AbortSignal): Promise<void> {
  bind(api);
  const startedGeneration = generation;
  const startedRevision = revision;
  const answer = sanitizeMachinesResponse(await api.listMachines(signal));
  if (!answer || generation !== startedGeneration || revision !== startedRevision) return;
  write(answer);
}

/** `MACHINES_CHANNEL` events (the app store routes them here). */
export function applyMachinesEvent(event: { type: string; payload?: unknown }): void {
  if (event.type !== MACHINES_CHANGED_EVENT) return;
  const payload = sanitizeMachinesResponse(event.payload);
  if (payload) write(payload);
}

/** Put one machine's new summary in place (the change event follows with the whole list). */
function upsert(machine: MachineSummary | null): void {
  const current = machinesStore.getState().machines;
  if (!machine || !current) return;
  const index = current.findIndex((entry) => entry.id === machine.id);
  if (index === -1) return;
  const machines = [...current];
  machines[index] = machine;
  write({ machines, problems: [...machinesStore.getState().problems] });
}

export async function updateMachine(api: MachinesApi, id: string, req: UpdateMachineRequest): Promise<void> {
  const answer = await api.updateMachine(id, req);
  upsert(sanitizeMachine(isRecord(answer) ? answer.machine : null));
}

export async function removeMachine(api: MachinesApi, id: string): Promise<RemoveMachineResponse> {
  const answer = await api.removeMachine(id);
  void loadMachines(api).catch(() => undefined);
  return { uninstalled: isRecord(answer) && answer.uninstalled === true, problems: problemsOf(isRecord(answer) ? answer.problems : null) };
}

/** "Pair over SSH": the daemon's answer, shape-checked (an unreadable one reads as a failure). */
export async function pairMachineOverSsh(api: MachinesApi, id: string, req: PairMachineOverSshRequest): Promise<PairMachineOverSshResponse> {
  const answer: unknown = await api.pairMachineOverSsh(id, req);
  if (isRecord(answer)) {
    if (answer.status === "confirm-host-key" && isRecord(answer.hostKey) && str(answer.hostKey.fingerprint) && str(answer.hostKey.keyType) && str(answer.hostKey.host)) {
      return { status: "confirm-host-key", hostKey: { keyType: answer.hostKey.keyType, fingerprint: answer.hostKey.fingerprint, host: answer.hostKey.host } };
    }
    if (answer.status === "pairing") {
      const machine = sanitizeMachine(answer.machine);
      if (machine) {
        upsert(machine);
        return { status: "pairing", machine };
      }
    }
    if (answer.status === "failed") {
      const problem = readProblem(answer.problem);
      if (problem) return { status: "failed", problem };
    }
  }
  return { status: "failed", problem: { code: "pair-bootstrap-failed", machineId: id, message: "Orquester sent an answer this app can't read.", fix: "Reload the app and try again." } };
}

export async function wakeMachine(api: MachinesApi, id: string): Promise<WakeMachineResponse> {
  const answer: unknown = await api.wakeMachine(id);
  if (!isRecord(answer)) return { sent: false, via: null };
  const problem = readProblem(answer.problem);
  return { sent: answer.sent === true, via: strOrNull(answer.via), ...(problem ? { problem } : {}) };
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

const subscribe = (listener: () => void) => machinesStore.subscribe(listener);

export function useMachinesState(): MachinesState {
  return useSyncExternalStore(subscribe, machinesStore.getState, machinesStore.getState);
}
