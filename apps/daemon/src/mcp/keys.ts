/** Key-name → PTY bytes, so callers stay out of the ANSI-escaping business. */
const NAMED: Record<string, string> = {
  Enter: "\r", Tab: "\t", BackTab: "\x1b[Z", Escape: "\x1b", Backspace: "\x7f",
  Space: " ", Delete: "\x1b[3~",
  Up: "\x1b[A", Down: "\x1b[B", Right: "\x1b[C", Left: "\x1b[D",
  Home: "\x1b[H", End: "\x1b[F", PageUp: "\x1b[5~", PageDown: "\x1b[6~",
};

/** Encode one key name to bytes. `C-<a-z>` → its control code. Throws on miss. */
export function encodeKey(name: string): string {
  if (NAMED[name]) {
    return NAMED[name];
  }
  const m = /^C-([a-z])$/i.exec(name);
  if (m) {
    return String.fromCharCode(m[1].toLowerCase().charCodeAt(0) & 0x1f);
  }
  throw new Error(`Unknown key "${name}".`);
}
