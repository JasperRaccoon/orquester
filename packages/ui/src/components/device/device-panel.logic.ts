/**
 * The Device panel's words, pure (testable without a DOM): how a lease's state, controller and
 * platform read in the list.
 */

import { DEVICE_PLATFORM_LABELS, type DeviceLeaseSummary } from "@orquester/api";

/** "Starting…", "Ready", "Unreachable", "Lost — its host is gone". */
export function leaseStateLabel(lease: Pick<DeviceLeaseSummary, "state" | "error" | "progress">): string {
  switch (lease.state) {
    case "starting":
      return lease.progress ? `${lease.progress.label}…` : "Starting…";
    case "ready":
      return "Ready";
    case "suspended":
      return "Unreachable — still running";
    case "lost":
      return lease.error ? `Lost — ${lease.error}` : "Lost";
    case "released":
      return "Released";
  }
}

/** Who drives it now, as the controller pill says it. */
export function controllerLabel(lease: Pick<DeviceLeaseSummary, "controller" | "state">): string | null {
  if (lease.state !== "ready") return null;
  return lease.controller === "user" ? "You have control" : "The agent is controlling";
}

/** "iPhone 17 Pro · iOS 26" with the platform group when the OS is unknown. */
export function leaseSubtitle(lease: Pick<DeviceLeaseSummary, "platform" | "osVersion">): string {
  return lease.osVersion || DEVICE_PLATFORM_LABELS[lease.platform];
}
