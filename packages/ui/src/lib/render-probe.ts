/**
 * Render counting for the re-render isolation tests (agent chat: a streamed
 * delta must not re-render the chat view or the composer; a keystroke must not
 * re-render the composer's footer or the timeline).
 *
 * `noteRender(name)` is one call in a component's body. It does nothing until
 * a test installs a listener with `countRenders`, so production pays a null
 * check per render. React's own Profiler counts commits of a subtree, not
 * renders of one component, which is what these tests assert on.
 */

let listener: ((name: string) => void) | null = null;

/** Record one render of `name` (a component's display name). */
export function noteRender(name: string): void {
  listener?.(name);
}

/** Start counting renders by name; the returned function stops it and answers the counts. */
export function countRenders(): { counts: Map<string, number>; stop: () => void } {
  const counts = new Map<string, number>();
  listener = (name) => counts.set(name, (counts.get(name) ?? 0) + 1);
  return {
    counts,
    stop: () => {
      listener = null;
    }
  };
}
