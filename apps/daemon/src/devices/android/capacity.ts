/**
 * How many emulators this machine may run (spikes §2 "Density"): each booted instance holds
 * ≈3.0–3.2 GB of private RAM (snapshot RAM is not shared) and the host keeps 8 GB for itself;
 * a device that is streamed and driven costs 6–10 threads, so about one per 8 threads can be
 * actively used at once.
 */

const GB = 1024 ** 3;
/** Kept free for the host itself. */
export const HOST_RESERVED_BYTES = 8 * GB;
/** One booted emulator. */
export const EMULATOR_BYTES = 3.2 * GB;
/** Threads one actively streamed and driven emulator uses. */
export const THREADS_PER_ACTIVE = 8;

export interface CapacityInput {
  /** Settings → Devices `maxLocalDevices`. */
  maxLocalDevices: number;
  /** `MemAvailable` now, in bytes (null: unknown → the setting alone). */
  memAvailableBytes: number | null;
  /** Emulators of this host running now: their RAM is already out of `MemAvailable`. */
  running: number;
  /** Hardware threads. */
  threads: number;
}

export interface LocalCapacity {
  /** Booted devices it may run at once. */
  total: number;
  /** About how many of those can be streamed and driven at once without slowing each other down. */
  active: number;
}

export function localCapacity(input: CapacityInput): LocalCapacity {
  const roomNow = input.memAvailableBytes === null ? Number.POSITIVE_INFINITY : Math.floor((input.memAvailableBytes - HOST_RESERVED_BYTES) / EMULATOR_BYTES);
  const byMemory = input.running + Math.max(0, roomNow);
  const total = Math.max(0, Math.min(input.maxLocalDevices, byMemory));
  return { total, active: Math.max(1, Math.floor(input.threads / THREADS_PER_ACTIVE)) };
}
