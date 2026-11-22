/**
 * One machine, two device hosts (tailnet machines spec §4.4 item 2): an Apple Silicon Mac runs iOS
 * simulators (`host.ts`, `box:<boxId>`) and Android emulators (`android-host.ts`,
 * `box:<boxId>:android`) out of the same RAM and cores. Each host's capacity counts what the other
 * holds now ({@link MachineDeviceLoad}, read synchronously from the other host through the
 * factory), so placement and the service's capacity re-check never fill the Mac twice over.
 */

/** What one device host holds of its machine now: its active leases (booting ones too) and their memory budget. */
export interface MachineDeviceLoad {
  devices: number;
  /** Memory those devices are budgeted (per-device budget × devices). */
  bytes: number;
}

export const NO_LOAD: MachineDeviceLoad = { devices: 0, bytes: 0 };

/** Cores an iOS simulator takes from Android's CPU budget on the same Mac (slim ones idle near 20 %, a driven one near a core). */
export const IOS_SIM_CPUS = 1;
