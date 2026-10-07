import type { KillProcessErrorCode, SystemProcessInfo } from "@orquester/api";

/**
 * Pure helpers behind the System status surfaces (top-bar chip, Settings →
 * Host status). Kept free of React and of any transport import so `system-format.check.ts`
 * can assert them with plain `node --import tsx`.
 */

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/**
 * Human bytes. `null`/`undefined` is *unknown* and renders as an em-dash — the
 * daemon reports an unmeasurable volume as null and that must never be shown as
 * a genuine 0 bytes.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) {
    return "—";
  }
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** Percent with the same unknown-is-an-em-dash rule as {@link formatBytes}. */
export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "—";
  }
  return `${Math.round(Math.max(0, Math.min(100, value)))}%`;
}

/** Bytes per second ("4.1 MB/s"), em-dash when unknown. */
export function formatByteRate(bytesPerSecond: number | null | undefined): string {
  return bytesPerSecond == null || !Number.isFinite(bytesPerSecond) ? "—" : `${formatBytes(bytesPerSecond)}/s`;
}

const BIT_UNITS = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"] as const;

/** Network throughput in bits per second, the unit links are sold in ("87.3 Mbps"). */
export function formatBitRate(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond == null || !Number.isFinite(bytesPerSecond)) {
    return "—";
  }
  let value = Math.max(0, bytesPerSecond) * 8;
  let unit = 0;
  while (value >= 1000 && unit < BIT_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value < 100 ? 1 : 0;
  return `${value.toFixed(digits)} ${BIT_UNITS[unit]}`;
}

/** A process's CPU share with one decimal ("62.4%"); em-dash when not measured yet. */
export function formatCpu(percent: number | null | undefined): string {
  if (percent == null || !Number.isFinite(percent)) {
    return "—";
  }
  return `${Math.max(0, percent).toFixed(1)}%`;
}

/** Elapsed time, two most significant units: "45s", "42m", "2h 14m", "5d 3h". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) {
    return "—";
  }
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}

/** Bar width for a possibly-unknown percent: an unknown bar is drawn empty. */
export function barWidth(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "0%";
  }
  return `${Math.max(0, Math.min(100, value))}%`;
}

/**
 * The daemon's refusal code out of a thrown API error, duck-typed on
 * `error.body.code` so this module stays free of the transport layer. Null when
 * the failure carried no recognised code (network drop, 500, …).
 */
export function killErrorCode(error: unknown): KillProcessErrorCode | null {
  const body = (error as { body?: unknown } | null | undefined)?.body;
  const code = (body as { code?: unknown } | null | undefined)?.code;
  switch (code) {
    case "INVALID_PID":
    case "PROCESS_NOT_MANAGED":
    case "PROCESS_PROTECTED":
    case "UNSUPPORTED_PLATFORM":
      return code;
    default:
      return null;
  }
}

/**
 * Distinct copy per refusal reason: "you may not touch that one" and "this host
 * cannot do it at all" call for different reactions, and a single generic
 * "failed" would hide which one happened.
 */
export function killErrorMessage(code: KillProcessErrorCode | null, label: string): string {
  switch (code) {
    case "PROCESS_PROTECTED":
      return `${label} is protected — the daemon, the agent host and the tmux server that keeps your sessions alive can't be stopped from here.`;
    case "PROCESS_NOT_MANAGED":
      return `${label} was not started by Orquester, or has exited since — only Orquester's own processes can be stopped here.`;
    case "INVALID_PID":
      return `${label} is not a valid target. Refresh the list and try again.`;
    case "UNSUPPORTED_PLATFORM":
      return "Stopping processes is only available on Linux hosts.";
    default:
      return `Could not stop ${label}.`;
  }
}

/** "node dev.mjs --port 3000" → the row's title attribute; empty stays empty. */
export function processLabel(proc: SystemProcessInfo): string {
  return `${proc.name} (PID ${proc.pid})`;
}
