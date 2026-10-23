/**
 * Clear a terminal in order with what was written to it. xterm parses
 * `write`s later, in batches, but `reset()` acts at once: data already queued
 * would then be drawn onto the cleared screen, ahead of the replay that
 * follows (scrollback written twice). Running the reset from a write callback
 * puts it exactly between the queued data and anything written after.
 */
export function resetAfterQueuedWrites(term: { write(data: string, callback?: () => void): void; reset(): void }): void {
  term.write("", () => term.reset());
}
