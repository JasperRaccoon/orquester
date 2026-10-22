/**
 * The multiplexed terminal stream (`/ws`): one WebSocket carries every
 * terminal's output, input and resizes as JSON text frames, keyed by session id.
 *
 * A server frame of a type the client does not know is ignored, and so is an
 * unknown field, so new frames and fields stay compatible with older clients.
 */

/**
 * Lines of history a terminal keeps: the client's xterm scrollback and the
 * tmux `history-limit` the daemon sets for its panes. One number, so a replay
 * fills exactly what the client can hold. Each line costs every (re)connect a
 * `capture-pane` and its bytes on the wire (about 100 bytes a coloured line).
 */
export const TERMINAL_SCROLLBACK_LINES = 5000;

export type TerminalStreamClientFrame =
  | { t: "sub"; id: string }
  | { t: "unsub"; id: string }
  | { t: "input"; id: string; data: string }
  | { t: "resize"; id: string; cols: number; rows: number }
  | { t: "ping" };

export type TerminalStreamServerFrame =
  /**
   * Output. `replay` marks a snapshot of the session (its scrollback), sent
   * after `sub` and after `reset`; anything else is live output. A client
   * should not let its terminal answer queries found in a replay.
   */
  | { t: "out"; id: string; data: string; replay?: true }
  /**
   * Clear the terminal: the next `out` for this id is a fresh snapshot. Sent
   * when the daemon resyncs a client, after output it could not deliver
   * (backpressure) or after the client's first resize.
   */
  | { t: "reset"; id: string }
  | { t: "end"; id: string }
  | { t: "pong" };
