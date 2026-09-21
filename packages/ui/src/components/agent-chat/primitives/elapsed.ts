// Ported from T3 Code (MIT): apps/web/src/components/AgentsPanel.tsx:60-80

/**
 * Elapsed-time formatting for the roster, the working row and the status line.
 *
 * The shape is T3's and it is chosen so the string only ever *grows* a unit,
 * never its digit count inside a unit: `9s → 59s → 1m 00s → 59m 59s → 1h 00m`.
 * Pair every rendered value with the `ac-tabular` class — a proportional "1"
 * is narrower than a "0", so without tabular figures a once-a-second tick
 * visibly twitches the row.
 */
export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** An ISO-8601 stamp, epoch milliseconds, or `null` for "not started". */
export type ElapsedStamp = string | number | null | undefined;

function parseStamp(stamp: ElapsedStamp): number {
  if (stamp === null || stamp === undefined) return Number.NaN;
  return typeof stamp === "number" ? stamp : Date.parse(stamp);
}

/**
 * Formats `end - start`, defaulting `end` to now. Returns `""` — never
 * `"NaNs"` — when either stamp is unparseable: this reads timestamps produced
 * by four different agent CLIs, so a malformed one must shrink the output, not
 * poison the row.
 */
export function elapsedBetween(start: ElapsedStamp, end: ElapsedStamp, now = Date.now()): string {
  const from = parseStamp(start);
  if (Number.isNaN(from)) return "";
  const to = end === null || end === undefined ? now : parseStamp(end);
  if (Number.isNaN(to)) return "";
  return formatElapsed((to - from) / 1000);
}
