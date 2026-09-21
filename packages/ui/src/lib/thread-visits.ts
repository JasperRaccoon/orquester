// Ported from T3 Code (MIT): apps/web/src/uiStateStore.ts:250-296,
// apps/web/src/components/Sidebar.logic.ts:635-644
/**
 * Unread state for chat tabs (spec §7.7).
 *
 * > **Needs-attention and unread are two different things.** Needs-attention is
 * > the §6.4 ladder read off `SessionSummary` — this surface re-derives nothing.
 * > Unread is separate: the latest turn's `completedAt` is newer than this
 * > client's last visit to that tab. A "mark unread" action is just a last-visit
 * > stamp set one millisecond before that completion.
 *
 * Per **device**, not per daemon: "have I read this yet" is a property of the
 * person sitting in front of this browser, and two clients of the same daemon
 * legitimately disagree about it. Hence localStorage, loaded field-wise with a
 * fallback like every other persisted client shape in this codebase.
 */

/** Session id → ISO stamp of this client's last visit to that tab. */
export type ThreadVisits = Record<string, string>;

/**
 * Keep the map bounded. Sessions are closed and their ids never reused, so a
 * long-lived browser profile would otherwise accumulate one entry per thread
 * that ever existed. Eviction is oldest-visit-first.
 */
export const THREAD_VISITS_LIMIT = 300;

const KEY = "orquester.thread-visits";

/** An ISO-8601 stamp we can compare; anything else is dropped on load. */
function isStamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function sanitizeThreadVisits(raw: unknown): ThreadVisits {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  const entries: Array<[string, string]> = [];
  for (const [id, stamp] of Object.entries(raw as Record<string, unknown>)) {
    if (id.length > 0 && isStamp(stamp)) {
      entries.push([id, stamp]);
    }
  }
  return Object.fromEntries(capOldest(entries));
}

/** Newest-visit-first truncation to {@link THREAD_VISITS_LIMIT}. */
function capOldest(entries: Array<[string, string]>): Array<[string, string]> {
  if (entries.length <= THREAD_VISITS_LIMIT) {
    return entries;
  }
  return entries
    .slice()
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
    .slice(0, THREAD_VISITS_LIMIT);
}

export function loadThreadVisits(): ThreadVisits {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? sanitizeThreadVisits(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export function saveThreadVisits(visits: ThreadVisits): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(sanitizeThreadVisits(visits)));
  } catch {
    /* storage unavailable */
  }
}

/**
 * Record a visit. Monotonic: an out-of-order or older stamp is ignored, so a
 * late-arriving "you were here" cannot un-read something you just marked
 * unread. Returns the same object when nothing changed, so a selector on it
 * does not re-render the tab strip on every activation.
 */
export function markThreadVisited(
  visits: ThreadVisits,
  sessionId: string,
  visitedAt: string
): ThreadVisits {
  const at = Date.parse(visitedAt);
  if (Number.isNaN(at)) {
    return visits;
  }
  const previous = visits[sessionId] ? Date.parse(visits[sessionId]) : Number.NaN;
  if (!Number.isNaN(previous) && previous >= at) {
    return visits;
  }
  return { ...visits, [sessionId]: visitedAt };
}

/**
 * Mark a tab unread: stamp the last visit **one millisecond before** the latest
 * turn completed, which is exactly what makes {@link hasUnseenCompletion} true
 * again without inventing a second flag to keep in sync with it.
 *
 * A thread whose latest turn never completed has nothing to be unread about.
 */
export function markThreadUnread(
  visits: ThreadVisits,
  sessionId: string,
  latestTurnCompletedAt: string | null | undefined
): ThreadVisits {
  if (!latestTurnCompletedAt) {
    return visits;
  }
  const completedAt = Date.parse(latestTurnCompletedAt);
  if (Number.isNaN(completedAt)) {
    return visits;
  }
  const stamp = new Date(completedAt - 1).toISOString();
  if (visits[sessionId] === stamp) {
    return visits;
  }
  return { ...visits, [sessionId]: stamp };
}

/**
 * True when the latest turn finished after this client last looked.
 *
 * A thread never visited is **not** unread: it has no completion the user
 * missed, only one they have not asked for yet — which is what the launcher's
 * own "just opened" state already says.
 */
export function hasUnseenCompletion(
  latestTurnCompletedAt: string | null | undefined,
  visitedAt: string | undefined
): boolean {
  if (!latestTurnCompletedAt) {
    return false;
  }
  const completedAt = Date.parse(latestTurnCompletedAt);
  if (Number.isNaN(completedAt)) {
    return false;
  }
  if (!visitedAt) {
    return false;
  }
  const lastVisit = Date.parse(visitedAt);
  // An unparseable stamp means "we have no idea when you last looked", which is
  // the same as not having looked since — show it.
  return Number.isNaN(lastVisit) ? true : completedAt > lastVisit;
}
