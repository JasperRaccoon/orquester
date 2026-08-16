/**
 * Compact "how long ago" label for an ISO-8601 timestamp, e.g. `3m ago`.
 *
 * Returns "" for anything unparseable — these timestamps come off the wire from
 * agents' own history files, where a missing/garbage date is a real (if rare)
 * possibility and must render as nothing rather than "NaN ago". A future
 * timestamp (clock skew between the daemon host and this browser) clamps to
 * "just now" instead of a negative age.
 */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) {
    return "";
  }
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
