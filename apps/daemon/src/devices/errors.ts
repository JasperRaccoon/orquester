/**
 * Device refusals: a code from `DEVICE_ERROR_CODES` (or a generic one), a message written for
 * whoever reads it — the owner in the panel, or an agent through its tool (then it names the next
 * call) — and the HTTP status the routes answer with.
 */

import { DEVICE_ERROR_CODES, type DeviceErrorCode } from "@orquester/api";

export type DeviceErrorCodeOrGeneric = DeviceErrorCode | "INVALID_ARGUMENT" | "PERMISSION_DENIED" | "UNAVAILABLE" | "CANCELLED" | "INTERNAL";

const STATUS: Readonly<Record<DeviceErrorCodeOrGeneric, number>> = {
  DEVICES_DISABLED: 409,
  DEVICE_NOT_LEASED: 404,
  DEVICE_LOST: 410,
  DEVICE_CONTROLLED_BY_USER: 409,
  DEVICE_CAPACITY: 503,
  DEVICE_LEASE_LIMIT: 409,
  DEVICE_BUSY: 409,
  PLATFORM_NOT_READY: 409,
  DEVICE_NOT_FOUND: 404,
  HOST_NOT_FOUND: 404,
  INVALID_ARGUMENT: 400,
  PERMISSION_DENIED: 403,
  UNAVAILABLE: 503,
  CANCELLED: 499,
  INTERNAL: 500
};

export class DeviceError extends Error {
  readonly status: number;

  constructor(
    readonly code: DeviceErrorCodeOrGeneric,
    message: string
  ) {
    super(message);
    this.name = "DeviceError";
    this.status = STATUS[code];
  }
}

export function isDeviceError(error: unknown): error is DeviceError {
  return error instanceof DeviceError;
}

const DEVICES_DISABLED_MESSAGE = "Device simulators are off. Ask the owner to turn the plugin on in Settings → Plugins.";

export function devicesDisabled(): DeviceError {
  return new DeviceError(DEVICE_ERROR_CODES.DEVICES_DISABLED, DEVICES_DISABLED_MESSAGE);
}
