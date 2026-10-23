/**
 * One client's multiplexed terminal stream (`/ws`): subscriptions, input,
 * resizes, and the output of every terminal it watches, over one WebSocket.
 * The frames are `TerminalStreamClientFrame` / `TerminalStreamServerFrame`
 * (packages/api).
 *
 * Output is bounded per socket. Live output is sent only while the socket's
 * send buffer is below {@link SEND_HIGH_WATER}. Past it, a terminal's output is
 * held, up to the same budget, and sent as one frame once the buffer drains
 * below {@link SEND_LOW_WATER} (seen from the socket's own write callbacks).
 * Only when the held output outgrows its budget — the link cannot keep up
 * with the terminal — is it dropped and the terminal marked overflowed; after
 * the drain it is resynced: `reset`, then a fresh snapshot (tmux capture-pane,
 * or the replay ring on the direct backend), then live output again. A slow
 * phone watching a noisy build sees the build's current state rather than a
 * growing backlog in daemon memory.
 *
 * A snapshot's own bytes fill the send buffer too (a full capture can be about
 * as large as the budget), so the output that follows one is held while it
 * drains, never treated as a new overflow: one resync, not a loop of them.
 *
 * While a snapshot is being taken, live output is held and sent after it, so
 * nothing produced during the capture is lost.
 */
import type { TerminalStreamServerFrame } from "@orquester/api";
import type { ISessionManager } from "./sessions.ts";

// Adapted from T3 Code (MIT): apps/server/src/terminal/OutputProtocol.ts
/**
 * Socket send-buffer size above which live terminal output is held instead of
 * sent; also the most a terminal holds before it is dropped and resynced.
 */
export const SEND_HIGH_WATER = 1024 * 1024;
/** Send-buffer size a backed-up socket must drain below before held output is sent or terminals are resynced. */
export const SEND_LOW_WATER = 256 * 1024;

/** The part of a WebSocket the stream uses (a `ws` WebSocket satisfies it). */
export interface SessionStreamSocket {
  /** Bytes queued to send and not yet written to the network. */
  readonly bufferedAmount: number;
  /** `cb` runs once the frame has been written out (or failed). */
  send(data: string, cb?: (error?: Error) => void): void;
}

export type SessionStreamSessions = Pick<
  ISessionManager,
  "get" | "scrollback" | "subscribe" | "input" | "resize" | "settleResize"
>;

export interface SessionStream {
  /** Handle one text frame from the client. */
  onMessage(raw: string): Promise<void>;
  /** The socket closed: drop every subscription. */
  onClose(): void;
}

interface Subscription {
  /**
   * live: output is sent. draining: the socket is backed up; output is held
   * until it drains. overflowed: held output outgrew its budget; output is
   * dropped until the socket drains, then a snapshot follows. snapshot: a
   * snapshot is being taken; output is held for after it.
   */
  mode: "live" | "draining" | "overflowed" | "snapshot";
  held: string[];
  heldChars: number;
  /** Held output outgrew the high-water mark during a snapshot and was dropped: resync again after it. */
  stale: boolean;
  /** The session exited while output was held or dropped; `end` follows the held output or the snapshot. */
  ended: boolean;
  endSent: boolean;
  /** The first resize after the subscribe snapshot re-snapshots at the client's real size. */
  resizeResync: boolean;
  abort: AbortController;
  unsubscribe: () => void;
}

export function createSessionStream(
  socket: SessionStreamSocket,
  sessions: SessionStreamSessions,
  limits: { highWater: number; lowWater: number } = { highWater: SEND_HIGH_WATER, lowWater: SEND_LOW_WATER }
): SessionStream {
  const subs = new Map<string, Subscription>();
  let closed = false;

  const send = (frame: TerminalStreamServerFrame) => {
    if (closed) {
      return;
    }
    try {
      socket.send(JSON.stringify(frame), resumeDrained);
    } catch {
      /* socket closing */
    }
  };

  const sendEnd = (id: string, sub: Subscription) => {
    sub.endSent = true;
    send({ t: "end", id });
  };

  // Every frame's write callback lands here; it is how a drain is noticed.
  function resumeDrained(): void {
    if (closed || socket.bufferedAmount > limits.lowWater) {
      return;
    }
    for (const [id, sub] of subs) {
      if (sub.mode === "draining") {
        flushHeld(id, sub);
      } else if (sub.mode === "overflowed") {
        void snapshot(id, sub, true);
      }
    }
  }

  /** Hold output while draining or snapshotting; past the budget, drop it (and resync later). */
  const hold = (sub: Subscription, data: string) => {
    if (sub.stale) {
      return;
    }
    sub.heldChars += data.length;
    if (sub.heldChars <= limits.highWater) {
      sub.held.push(data);
      return;
    }
    sub.held = [];
    sub.heldChars = 0;
    if (sub.mode === "snapshot") {
      sub.stale = true;
    } else {
      sub.mode = "overflowed";
    }
  };

  /** The socket drained: send what was held while it was backed up, then carry on live. */
  const flushHeld = (id: string, sub: Subscription) => {
    const held = sub.held.join("");
    sub.held = [];
    sub.heldChars = 0;
    sub.mode = "live";
    if (held.length > 0) {
      send({ t: "out", id, data: held });
    }
    if (sub.ended && !sub.endSent) {
      sendEnd(id, sub);
    }
  };

  const output = (id: string, sub: Subscription, data: string) => {
    if (subs.get(id) !== sub) {
      return;
    }
    if (sub.mode === "overflowed") {
      return;
    }
    if (sub.mode === "live" && socket.bufferedAmount > limits.highWater) {
      // The socket's write callbacks (resumeDrained) bring it back.
      sub.mode = "draining";
    }
    if (sub.mode !== "live") {
      hold(sub, data);
      return;
    }
    send({ t: "out", id, data });
  };

  const exited = (id: string, sub: Subscription) => {
    if (subs.get(id) !== sub) {
      return;
    }
    if (sub.mode === "live") {
      sendEnd(id, sub);
    } else {
      sub.ended = true;
    }
  };

  /**
   * Send a fresh snapshot of `id`, preceded by `reset` when the client's
   * terminal already has content, then what was held while it was taken.
   * Returns false when the subscription went away meanwhile.
   */
  async function snapshot(id: string, sub: Subscription, reset: boolean): Promise<boolean> {
    sub.mode = "snapshot";
    sub.held = [];
    sub.heldChars = 0;
    sub.stale = false;
    const data = await sessions.scrollback(id);
    if (closed || subs.get(id) !== sub) {
      return false;
    }
    if (reset) {
      send({ t: "reset", id });
    }
    send({ t: "out", id, data, replay: true });
    const held = sub.held.join("");
    sub.held = [];
    sub.heldChars = 0;
    sub.mode = "live";
    if (sub.stale) {
      sub.stale = false;
      sub.mode = "overflowed";
    } else if (held.length > 0) {
      // Behind a large snapshot this is held (draining) until it has gone out.
      output(id, sub, held);
    }
    if (sub.mode === "live" && sub.ended && !sub.endSent) {
      sendEnd(id, sub);
    }
    if (sub.mode !== "live") {
      resumeDrained();
    }
    return true;
  }

  const cancel = (id: string) => {
    const sub = subs.get(id);
    if (sub) {
      subs.delete(id);
      sub.abort.abort();
      sub.unsubscribe();
    }
  };

  const subscribe = async (id: string) => {
    if (!sessions.get(id)) {
      send({ t: "end", id });
      return;
    }
    // Replace any prior subscription SYNCHRONOUSLY, before the await below.
    // `ws` drains queued frames into this async handler at each await point, so
    // a back-to-back `unsub` (fast tab close, or a strict-mode dev double-mount
    // — see WsSessionChannel.openOutput/close) runs DURING the capture; the
    // identity check in snapshot() then lets that unsub (or a newer sub) win.
    cancel(id);
    const sub: Subscription = {
      mode: "snapshot",
      held: [],
      heldChars: 0,
      stale: false,
      ended: false,
      endSent: false,
      resizeResync: false,
      abort: new AbortController(),
      unsubscribe: () => {}
    };
    subs.set(id, sub);
    // Listening before the capture holds output produced during it, and an exit
    // during it, for after the snapshot.
    sub.unsubscribe = sessions.subscribe(
      id,
      (data) => output(id, sub, data),
      () => exited(id, sub)
    );
    if (!(await snapshot(id, sub, false))) {
      return;
    }
    // Re-read the LIVE status: a session that had already exited (or was closed)
    // before we subscribed will never emit an exit, so end it here.
    const current = sessions.get(id);
    if (!current || current.status === "exited") {
      if (sub.mode === "draining") {
        flushHeld(id, sub);
      }
      if (!sub.endSent) {
        sendEnd(id, sub);
      }
      cancel(id);
      return;
    }
    sub.resizeResync = true;
  };

  const resize = async (id: string, cols: number, rows: number) => {
    sessions.resize(id, cols, rows);
    const sub = subs.get(id);
    if (!sub?.resizeResync) {
      return;
    }
    // The first resize after a sub is the client's REAL terminal size. The
    // subscribe snapshot was captured before the client fit (often at the
    // 80-col default), so an alt-screen TUI grid landed wrapped/garbled. Once
    // the backend has applied the size, snapshot again at it — reliable whether
    // or not the program emits more output (an idle agent would stay garbled).
    sub.resizeResync = false;
    await sessions.settleResize?.(id, sub.abort.signal);
    if (subs.get(id) === sub && (sub.mode === "live" || sub.mode === "draining")) {
      await snapshot(id, sub, true);
    }
  };

  return {
    async onMessage(raw: string): Promise<void> {
      let msg: { t?: string; id?: string; data?: string; cols?: number; rows?: number };
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      // Liveness probe: mobile browsers kill a backgrounded tab's socket
      // without a close frame, so the client pings on wake and treats a
      // missing pong as a dead socket (see WsSessionChannel.wake).
      if (msg.t === "ping") {
        send({ t: "pong" });
        return;
      }
      const id = msg.id;
      if (typeof id !== "string" || !id) {
        return;
      }
      if (msg.t === "sub") {
        await subscribe(id);
      } else if (msg.t === "unsub") {
        cancel(id);
      } else if (msg.t === "input" && typeof msg.data === "string") {
        sessions.input(id, msg.data);
      } else if (msg.t === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
        await resize(id, msg.cols, msg.rows);
      }
    },
    onClose(): void {
      closed = true;
      for (const id of [...subs.keys()]) {
        cancel(id);
      }
    }
  };
}
