/**
 * How devices read the machines registry (tailnet machines spec 2026-11-22 §4.1, §4.4.5): the
 * registry's {@link MachineAccessPort} is an optional dependency. With it, a paired machine's
 * policy decides whether it is a device host at all — a Hidden machine, or one with "Device
 * simulators" off, is never prepared, listed, placed on or opened by id. Without it (or for a box
 * the registry does not know as a machine), the box's own "Use for device simulators" flag decides,
 * as before the registry existed. Rented boxes are always allowed.
 */

import { boxMachineId } from "@orquester/api";

import type { MachineAccessPort } from "../machines/ports.ts";

/** The part of the registry devices use. */
export type DeviceMachineAccess = Pick<MachineAccessPort, "policyOfBox" | "allowsBox" | "onChange">;

/**
 * Whether the owner's machine behind a BYO box runs devices now: the registry's policy when it
 * knows the machine (visible and "Device simulators" on), else the box record's `deviceHost` flag.
 */
export function byoRunsDevices(boxId: string, deviceHostFlag: boolean | undefined, access: DeviceMachineAccess | null): boolean {
  if (access && access.policyOfBox(boxId) !== null) return access.allowsBox(boxId, "devices");
  return deviceHostFlag === true;
}

/** Whether agents and placement may use a box for devices (rentals always; a paired machine by its policy). */
export function boxAllowsDevices(boxId: string, access: DeviceMachineAccess | null): boolean {
  return access ? access.allowsBox(boxId, "devices") : true;
}

/** The machine id of a paired box: the registry's (a `ts:` id once matched to a tailnet peer), else `box:<boxId>`. */
export function machineIdOfBox(boxId: string, access: DeviceMachineAccess | null): string {
  return access?.policyOfBox(boxId)?.machineId ?? boxMachineId(boxId);
}
