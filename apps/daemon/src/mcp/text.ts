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
 * Drop text rendered FAINT (SGR 2) — de-emphasized ghost/placeholder text such as a
 * coding-agent's empty-composer hint (e.g. a greyed previous prompt), never primary
 * content. Without this, a color-stripped read turns that ghost into what looks like
 * real typed input ("the user prompt says …"). Every escape token is kept in place
 * (stripAnsi removes them next); only the faint-styled TEXT is dropped. Faint turns on
 * with SGR 2 and off with SGR 0 (reset) or 22 (normal intensity).
 */
export function stripFaint(input: string): string {
  const sgr = /\x1b\[([0-9;]*)m/g;
  let out = "";
  let last = 0;
  let faint = false;
  let m: RegExpExecArray | null;
  while ((m = sgr.exec(input)) !== null) {
    if (!faint) out += input.slice(last, m.index); // keep non-faint text
    out += m[0]; // keep the SGR token itself (stripAnsi drops it next)
    for (const p of (m[1] === "" ? "0" : m[1]).split(";").map(Number)) {
      if (p === 2) faint = true;
      else if (p === 0 || p === 22) faint = false;
    }
    last = sgr.lastIndex;
  }
  if (!faint) out += input.slice(last);
  return out;
}

/**
 * Clean rendered text for an agent read. `captured` is a COLORED tmux capture
 * (capture-pane -e): drop faint ghost/placeholder text, then strip the remaining ANSI.
 * When the cleaned capture has no visible text (exited/destroyed pane, transient empty
 * capture, or non-tmux host) fall back to the same-cleaned hot ring, bounded to a
 * POSITIVE `opts.lines`, else SCREEN_ROWS. `lines:0` ("current screen") is meaningful
 * only for the capture path — there is no rendered frame in the ring — so 0/unset both
 * bound to SCREEN_ROWS here rather than returning the whole ring (callers pass `?? 0`).
 */
export function renderText(captured: string, buffer: string, opts?: { lines?: number }): string {
  const want = opts?.lines && opts.lines > 0 ? opts.lines : SCREEN_ROWS;
  const clean = (s: string) => stripAnsi(stripFaint(s));
  const screen = clean(captured);
  const body = screen.trim() ? screen : tailLines(clean(buffer), want);
  return cap(trimTrailingBlankLines(body));
}
