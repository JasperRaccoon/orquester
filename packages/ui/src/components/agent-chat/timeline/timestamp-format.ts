/**
 * Row timestamps (§5.4 of the design reference).
 *
 * Day-aware and deliberately terse: inside a thread you are reading, the time
 * of day is the whole answer, and the date only starts mattering once a thread
 * spans days. The full stamp is always one hover away in the `title`.
 *
 * Returns `""` — never `"Invalid Date"` — for an unparseable value. These
 * stamps come off four different agent CLIs; a malformed one must shrink the
 * row, not poison it.
 */
export function formatRowTimestamp(iso: string, now = new Date()): string {
  const then = new Date(iso);
  const time = then.getTime();
  if (!Number.isFinite(time)) return "";
  const clock = `${String(then.getHours()).padStart(2, "0")}:${String(then.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    then.getFullYear() === now.getFullYear() &&
    then.getMonth() === now.getMonth() &&
    then.getDate() === now.getDate();
  if (sameDay) return clock;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const isYesterday =
    then.getFullYear() === yesterday.getFullYear() &&
    then.getMonth() === yesterday.getMonth() &&
    then.getDate() === yesterday.getDate();
  if (isYesterday) return `Yesterday ${clock}`;
  const day = then.getDate();
  const month = then.toLocaleDateString(undefined, { month: "short" });
  const year = then.getFullYear() === now.getFullYear() ? "" : ` ${then.getFullYear()}`;
  return `${day} ${month}${year} ${clock}`;
}

/** The full stamp, for the tooltip. */
export function formatRowTimestampTooltip(iso: string): string {
  const then = new Date(iso);
  if (!Number.isFinite(then.getTime())) return "";
  return then.toLocaleString();
}
