import type { SessionChannel, StreamHandle, StreamHandlers } from "../transporter";

/**
 * Multiplexes every terminal's output/input/resize for one daemon over a single
 * WebSocket. The web app would otherwise open one streaming HTTP connection per
 * terminal and hit the browser's ~6-connections-per-origin cap; one socket lifts
 * that limit. It auto-reconnects with backoff and re-subscribes; on reconnect it
 * asks each terminal to reset before the daemon replays its buffer, so nothing
 * is duplicated.
 *
 * Wire protocol (JSON text frames):
 *   client → { t:"sub"|"unsub", id } | { t:"input", id, data } | { t:"resize", id, cols, rows } | { t:"ping" }
 *   server → { t:"out", id, data } | { t:"end", id } | { t:"pong" }
 */
export class WsSessionChannel implements SessionChannel {
  private ws: WebSocket | null = null;
  private readonly subs = new Map<string, StreamHandlers>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  /** Pending ping deadline from {@link wake}; a pong (or reconnect) clears it. */
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly wsUrl: string,
    private credential?: string
  ) {
    this.connect();
  }

  /** Update the credential (e.g. after auth) and reconnect if it changed. */
  setCredential(credential?: string): void {
    if (credential === this.credential) {
      return;
    }
    this.credential = credential;
    this.reconnect();
  }

  openOutput(id: string, handlers: StreamHandlers): StreamHandle {
    this.subs.set(id, handlers);
    this.raw({ t: "sub", id });
    return {
      close: () => {
        if (this.subs.delete(id)) {
          this.raw({ t: "unsub", id });
        }
      }
    };
  }

  sendInput(id: string, data: string): void {
    this.raw({ t: "input", id, data });
  }

  resize(id: string, cols: number, rows: number): void {
    this.raw({ t: "resize", id, cols, rows });
  }

  /**
   * The page regained visibility/focus/network. Mobile browsers freeze hidden
   * tabs and kill their sockets — often WITHOUT delivering `close` (the
   * half-dead state: readyState still reads OPEN while frames go nowhere). So:
   * a pending backoff timer is short-circuited to redial NOW, a dead socket is
   * torn down and redialed, and an apparently-open socket must answer a ping
   * within the deadline or it is force-reconnected. Safe to call aggressively —
   * the daemon replays the tmux buffer on re-subscribe, so a redial is lossless.
   */
  wake(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.attempts = 0;
      this.connect();
      return;
    }
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
      this.attempts = 0;
      this.reconnect();
      return;
    }
    if (ws.readyState === WebSocket.CONNECTING || this.pongTimer) {
      // Handshake or a previous wake's probe already in flight — let it resolve.
      return;
    }
    this.raw({ t: "ping" });
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      this.attempts = 0;
      this.reconnect();
    }, 2500);
  }

  private clearPongDeadline(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private url(): string {
    return this.credential
      ? `${this.wsUrl}?token=${encodeURIComponent(this.credential)}`
      : this.wsUrl;
  }

  private connect(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      // Re-subscribe everything. Each is a reconnect for a terminal that already
      // has content, so reset it before the daemon replays its buffer.
      for (const [id, handlers] of this.subs) {
        handlers.onReset?.();
        this.raw({ t: "sub", id });
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        return;
      }
      let msg: { t?: string; id?: string; data?: string };
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.t === "pong") {
        this.clearPongDeadline();
        return;
      }
      if (!msg.id) {
        return;
      }
      const handlers = this.subs.get(msg.id);
      if (!handlers) {
        return;
      }
      if (msg.t === "out" && typeof msg.data === "string") {
        handlers.onData(msg.data);
      } else if (msg.t === "end") {
        handlers.onEnd();
      }
    };

    ws.onclose = () => {
      // Superseded by an explicit reconnect (wake/credential change): this close
      // is expected — scheduling another dial here would double-connect.
      if (this.ws !== ws) {
        return;
      }
      this.ws = null;
      // A wake-probe deadline racing this close would tear down the redial.
      this.clearPongDeadline();
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  private reconnect(): void {
    this.clearPongDeadline();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const old = this.ws;
    this.ws = null;
    try {
      old?.close();
    } catch {
      /* ignore */
    }
    this.connect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }
    this.attempts += 1;
    const delay = Math.min(this.attempts * 500, 5000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private raw(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
    // Else dropped while offline: outputs re-subscribe on reconnect, and a
    // keystroke/resize missed during a blip is corrected by the buffer replay.
  }
}

/** One shared channel per daemon origin, reused across ApiClient rebuilds. */
const channels = new Map<string, WsSessionChannel>();

/** Wake every live channel (see {@link WsSessionChannel.wake}) — called on
 *  visibility/focus/online regain by the store's wakeConnections. */
export function wakeSessionChannels(): void {
  for (const channel of channels.values()) {
    channel.wake();
  }
}

export function getSessionChannel(httpBaseUrl: string, credential?: string): WsSessionChannel {
  const wsUrl = `${httpBaseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/ws`;
  const existing = channels.get(wsUrl);
  if (existing) {
    existing.setCredential(credential);
    return existing;
  }
  const channel = new WsSessionChannel(wsUrl, credential);
  channels.set(wsUrl, channel);
  return channel;
}
