/**
 * Paste-to-PTY helpers shared by the desktop paste handler (TerminalView's
 * capture-phase `paste` listener) and the mobile key bar's Paste button — the
 * two paths must format identically or a multi-line paste behaves differently
 * per device.
 */

/**
 * Wrap pasted text in the bracketed-paste escapes (`\x1b[200~`…`\x1b[201~`) a
 * native terminal sends, normalizing every newline to CR exactly as xterm's own
 * `prepareTextForTerminal` does. We send this explicitly for agent sessions
 * because xterm only brackets a paste once it has SEEN the app enable
 * bracketed-paste mode (`\x1b[?2004h`) — but the daemon replays scrollback via
 * `tmux capture-pane`, which omits DEC private modes, so a reattached / reloaded
 * / reconnected client never learns the agent turned it on. Without the wrapper
 * xterm sends a bare CR between lines and the agent submits at the first one.
 */
export function bracketPaste(text: string): string {
  const normalized = text.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
  return `\x1b[200~${normalized}\x1b[201~`;
}

/**
 * Format clipboard text as PTY input for a session the sender reaches only via
 * the input API (no xterm in between — e.g. the mobile key bar). Agents get the
 * explicit bracketed paste above; everything else gets the same newline
 * normalization *without* brackets, because a shell that never enabled
 * bracketed-paste mode would render the escapes as literal input.
 */
export function pasteTextForSession(isAgent: boolean, text: string): string {
  if (isAgent) {
    return bracketPaste(text);
  }
  return text.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
}
