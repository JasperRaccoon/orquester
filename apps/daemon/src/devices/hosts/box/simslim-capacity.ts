/**
 * How many simulators a Mac device host may run at once (devices phase 2 §2 goal 7): memory decides
 * it. Every booted simulator costs its launchd tree (simslim `measure`/`top`: phys_footprint, what
 * decides swapping) plus what runs outside that tree for it (CoreSimulator's per-device services,
 * serve-sim's capture, agent-device's `xcodebuild` runner host process) and the app under test.
 *
 * - The ceiling: `(host RAM − reserve) / per-simulator budget` (24 GB host: 8 slim, 3 stock).
 * - Admission: `simslim top --json` now — what booted simulators really use (the owner's own ones on
 *   their Mac included) — leaves room for another budget.
 * - Settings → Devices `maxSimulatorsPerHost` caps both.
 *
 * Boots stay one at a time per host whatever this says (`BoxDeviceHost.oneBootAtATime`).
 *
 * Measured on a Blacksmith `macos-26` 6 vCPU / 24 GB runner (iOS 27.0, iPhone 17 Pro, 45 s after
 * the home screen; `simslim measure`): stock 2.4–2.6 GiB, ~270–290 processes, ~550 % CPU (still
 * settling); slim 0.59–0.81 GiB, 80–90 processes, ~20 % CPU. Seven slim simulators booted: their
 * trees 5.4 GiB, no swap, 123 MB compressed, `memory_pressure` 86 % free; the 7th slim boot took
 * 38 s (23 s for the 3rd) — CPU, not memory, is the next limit, so the ceiling stays at 8.
 */

import { isSlim, type SimslimTop } from "./simslim.ts";

const GiB = 1024 ** 3;

/** Kept free for macOS itself, the hub, agent-device's daemon and orq-agent. */
const MAC_HOST_RESERVED_BYTES = 8 * GiB;
/** A slim simulator's launchd tree after it settled (measured 0.59–0.81 GiB; 1.06 with the runner app). */
const SLIM_SIM_BYTES = 1 * GiB;
/** A stock simulator's launchd tree (measured 2.4–2.6 GiB 45 s after boot and climbing; simslim README: 4.0 GB settled). */
const STOCK_SIM_BYTES = 4 * GiB;
/** Per booted simulator outside its launchd tree, plus the app under test. */
const PER_SIM_EXTRA_BYTES = 1 * GiB;

export interface SimCapacityInput {
  /** Settings → Devices `ios.maxSimulatorsPerHost`. */
  settingCap: number;
  /** `hw.memsize`; null: unknown (the setting alone decides). */
  hostBytes: number | null;
  /** Simulators boot slim on this host. */
  slim: boolean;
  /** The latest `simslim top --json`; null: none yet. */
  top: SimslimTop | null;
  /** Leased simulators now (each booted, so counted in `top` too). */
  leased: number;
}

export interface SimCapacity {
  /** Simulators this host may run at once (leased ones included). */
  total: number;
  /** The memory one more simulator is budgeted. */
  perSimBytes: number;
  /** The ceiling by host RAM; null when the RAM is unknown. */
  byMemory: number | null;
  /** More that fit now by `top`; null without a sample. */
  roomNow: number | null;
}

/**
 * The per-simulator budget: the larger of the default tree size and what this host's booted
 * simulators of the same kind (slim or stock) measure on average, plus {@link PER_SIM_EXTRA_BYTES}.
 */
function perSimulatorBytes(slim: boolean, top: SimslimTop | null): number {
  const base = slim ? SLIM_SIM_BYTES : STOCK_SIM_BYTES;
  const measured = (top?.sims ?? []).filter((sim) => sim.memory !== null && isSlim(sim) === slim).map((sim) => sim.memory!.bytes);
  const mean = measured.length > 0 ? measured.reduce((a, b) => a + b, 0) / measured.length : 0;
  return Math.max(base, mean) + PER_SIM_EXTRA_BYTES;
}

export function simulatorCapacity(input: SimCapacityInput): SimCapacity {
  const perSimBytes = perSimulatorBytes(input.slim, input.top);
  const cap = Math.max(0, input.settingCap);
  if (input.hostBytes === null || !(input.hostBytes > 0)) return { total: cap, perSimBytes, byMemory: null, roomNow: null };
  const usable = input.hostBytes - MAC_HOST_RESERVED_BYTES;
  const byMemory = Math.max(0, Math.floor(usable / perSimBytes));
  let roomNow: number | null = null;
  let total = Math.min(cap, byMemory);
  if (input.top) {
    // Booted simulators use their measured tree plus the outside-the-tree share each.
    const inUse = input.top.totalBytes + input.top.sims.length * PER_SIM_EXTRA_BYTES;
    roomNow = Math.max(0, Math.floor((usable - inUse) / perSimBytes));
    total = Math.min(total, input.leased + roomNow);
  }
  return { total: Math.max(0, total), perSimBytes, byMemory, roomNow };
}
