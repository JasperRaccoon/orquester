/** Leaf text helpers for clean (no-ANSI) rendered reads. Imports nothing. */

export const SCREEN_ROWS = 50;
export const MAX_TEXT = 64 * 1024;

/** Strip ANSI: CSI (incl. private/intermediate params) + OSC (BEL or ST terminated). */
export function stripAnsi(input: string): string {
  return input
    // OSC: ESC ] ... (BEL | ST)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    // CSI: ESC [ params intermediates final
    .replace(/\x1b\[[0-9;?>=]*[ -/]*[@-~]/g, "")
    // any stray single-char escape left over
    .replace(/\x1b[@-Z\\-_]/g, "");
}

/** Remove trailing blank/whitespace-only lines (keeps internal structure). */
export function trimTrailingBlankLines(s: string): string {
  const lines = s.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  return lines.join("\n");
}

/** Keep the last `lines` lines; `lines <= 0` (or non-finite) returns the input unchanged. */
export function tailLines(s: string, lines: number): string {
  if (!Number.isFinite(lines) || lines <= 0) {
    return s;
  }
  const arr = s.split("\n");
  return arr.length <= lines ? s : arr.slice(arr.length - lines).join("\n");
}

/** Bound the returned text; keep the most-recent `max` chars behind a head marker. */
export function cap(s: string, max = MAX_TEXT): string {
  return s.length <= max ? s : `…[truncated]\n${s.slice(s.length - max)}`;
}

/**
 * Clean rendered text for an agent read. `captured` is a tmux capture-pane result
 * (already clean when taken with escapes:false) — used as-is when non-empty. When
 * empty (exited/destroyed pane, transient empty capture, or non-tmux host) fall
 * back to the ANSI-stripped hot ring, bounded to a POSITIVE `opts.lines`, else
 * SCREEN_ROWS. `lines:0` ("current screen") is meaningful only for the tmux capture
 * path — there is no rendered frame in the ring — so 0/unset both bound to
 * SCREEN_ROWS here rather than returning the whole ring (callers pass `?? 0`).
 */
export function renderText(captured: string, buffer: string, opts?: { lines?: number }): string {
  const want = opts?.lines && opts.lines > 0 ? opts.lines : SCREEN_ROWS;
  const body = captured || tailLines(stripAnsi(buffer), want);
  return cap(trimTrailingBlankLines(body));
}
