/**
 * Where keyboard focus goes when the saved-prompt list changes under it.
 *
 * A card that had focus may, in one commit, move (pinned, unpinned, re-sorted
 * by an Insert or a Send, a refused pin moving it back) or leave the list
 * (deleted, moved out of the Project scope, deleted by another client). The
 * panel reads which card had focus while it renders — before the commit
 * touches the DOM — and applies this plan right after it, in the same commit,
 * so the dock's safety net (`dock-keyboard.ts`) never sees focus on `<body>`.
 *
 * Pure, no DOM.
 */

export type ListFocusPlan =
  /** Focus was not on a card. */
  | { kind: "none" }
  /**
   * The focused card is still listed: focus stays on its control (and is put
   * back if a browser dropped it when the node moved); `moved` asks to keep
   * the card in view.
   */
  | { kind: "keep"; id: string; moved: boolean }
  /** The focused card left: its neighbour takes focus — the next one, else the previous. */
  | { kind: "neighbour"; id: string }
  /** The focused card left, and no card is left beside it: the list itself takes focus. */
  | { kind: "list" };

export function planListFocus(
  before: readonly string[],
  after: readonly string[],
  focusedId: string | null
): ListFocusPlan {
  if (focusedId === null) return { kind: "none" };
  const index = after.indexOf(focusedId);
  if (index >= 0) return { kind: "keep", id: focusedId, moved: before.indexOf(focusedId) !== index };
  const at = before.indexOf(focusedId);
  if (at >= 0) {
    const listed = new Set(after);
    for (let i = at + 1; i < before.length; i += 1) {
      const id = before[i];
      if (id !== undefined && listed.has(id)) return { kind: "neighbour", id };
    }
    for (let i = at - 1; i >= 0; i -= 1) {
      const id = before[i];
      if (id !== undefined && listed.has(id)) return { kind: "neighbour", id };
    }
  }
  return { kind: "list" };
}
