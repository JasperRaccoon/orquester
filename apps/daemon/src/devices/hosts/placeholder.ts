/**
 * A host that exists but cannot run anything yet: its readiness lists what it lacks and every
 * operation refuses. The stand-in factories (`local-android.ts`, `box-host.ts`) add one until the
 * real host lands, so the service, routes, tools and UI already see the host and its checklist.
 */

import { EventEmitter } from "node:events";

import type { DeviceHostKind, DeviceHostReadiness, DevicePlatform, DeviceReadinessCheck } from "@orquester/api";

import { DeviceError } from "../errors.ts";
import type { DeviceHost, DeviceHostState } from "../host.ts";

export class PlaceholderDeviceHost implements DeviceHost {
  private readonly events = new EventEmitter();
  private readonly checks: DeviceReadinessCheck[];

  constructor(
    readonly id: string,
    readonly kind: DeviceHostKind,
    readonly label: string,
    readonly platforms: readonly DevicePlatform[],
    checks: readonly DeviceReadinessCheck[],
    private readonly reason: string
  ) {
    this.checks = checks.map((check) => ({ ...check }));
  }

  state(): DeviceHostState {
    return { status: "needs-setup", detail: this.reason };
  }

  readiness(): DeviceHostReadiness {
    return { ready: false, checks: this.checks.map((check) => ({ ...check })), checkedAt: null };
  }

  async refreshReadiness(): Promise<DeviceHostReadiness> {
    return this.readiness();
  }

  capacity() {
    return { used: 0, total: 0 };
  }

  async ensureReady(): Promise<void> {
    throw this.refusal();
  }

  hubOrigin(): string | null {
    return null;
  }

  agentDeviceConfigPath(): string | null {
    return null;
  }

  async listDevices() {
    return [];
  }

  async boot(): Promise<never> {
    throw this.refusal();
  }

  async shutdown(): Promise<void> {}

  async release(): Promise<void> {}

  async run(): Promise<never> {
    throw this.refusal();
  }

  async uploadFile(): Promise<never> {
    throw this.refusal();
  }

  onChange(listener: () => void): () => void {
    this.events.on("change", listener);
    return () => void this.events.off("change", listener);
  }

  async dispose(): Promise<void> {
    this.events.removeAllListeners();
  }

  private refusal(): DeviceError {
    return new DeviceError("PLATFORM_NOT_READY", this.reason);
  }
}
