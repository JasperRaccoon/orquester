/**
 * Which rows play the one-shot 200 ms rise (§7.3).
 *
 * A row that ARRIVED rises; a list the user just opened does not — a hundred
 * fades on the way into a thread read as noise. Decided once per row id and
 * never revisited, so the flag is a stable prop and cannot break
 * `TimelineRow`'s memo. Three rules:
 *
 *  - **Per list, not per session.** The identity is `timelineListIdentity`'s
 *    — session and agent — so the drill-in switching from agent A to agent B
 *    is a new list whose first rows do not rise. Keyed on the session alone,
 *    every row of B rose at once.
 *  - **Primed by the first NON-EMPTY render.** A cold thread renders empty and
 *    its first snapshot lands a render later; priming on the empty render
 *    made that whole snapshot rise.
 *  - **Older history does not rise.** A row that arrives ABOVE every row
 *    already on screen is a "Load older turns" page landing, not news.
 *
 * Pure save for the one state object it is handed, which it updates in place
 * (it is a ref's, and a new map per render would cost more than the render).
 */

/** One list's flags. */
export interface RowEnterState {
  readonly identity: string;
  readonly flags: Map<string, boolean>;
  /** A render of this list has shown rows: the next new row arrived. */
  primed: boolean;
}

/** The flags after this render of `rows` under `identity` — a fresh state for a new list. */
export function nextRowEnterState(
  previous: RowEnterState | null,
  rows: readonly { id: string }[],
  identity: string
): RowEnterState {
  const state: RowEnterState =
    previous !== null && previous.identity === identity
      ? previous
      : { identity, flags: new Map(), primed: false };
  // A row that arrives ABOVE every row already on screen is older history — a
  // "Load older turns" page landing — not news: it never rises in. Rows after
  // the first known one keep the rule above.
  let firstKnownIndex = -1;
  for (let index = 0; index < rows.length; index += 1) {
    if (state.flags.has(rows[index]!.id)) {
      firstKnownIndex = index;
      break;
    }
  }
  rows.forEach((row, index) => {
    if (!state.flags.has(row.id)) {
      state.flags.set(row.id, state.primed && index > firstKnownIndex);
    }
  });
  if (rows.length > 0) {
    state.primed = true;
  }
  // Drop ids that have left, so a long-lived tab does not accumulate a flag per
  // row it ever showed.
  if (state.flags.size > rows.length * 2 + 64) {
    const live = new Set(rows.map((row) => row.id));
    for (const id of [...state.flags.keys()]) {
      if (!live.has(id)) {
        state.flags.delete(id);
      }
    }
  }
  return state;
}

/** Whether row `id` rises in. */
export function rowEnters(state: RowEnterState, id: string): boolean {
  return state.flags.get(id) === true;
}
