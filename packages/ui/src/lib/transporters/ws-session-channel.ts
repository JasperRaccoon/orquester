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
 *   client → { t:"sub"|"unsub", id } | { t:"input", id, data } | { t:"resize", id, cols, rows }
 *   server → { t:"out", id, data } | { t:"end", id }
 */
export class WsSessionChannel implements SessionChannel {
  private ws: WebSocket | null = null;
  private readonly subs = new Map<string, StreamHandlers>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;

  constructor(
    private readonly wsUrl: string,
    private password?: string
  ) {
    this.connect();
  }

  /** Update the bearer token (e.g. after auth) and reconnect if it changed. */
  setPassword(password?: string): void {
    if (password === this.password) {
      return;
    }
    this.password = password;
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

  private url(): string {
    return this.password ? `${this.wsUrl}?token=${encodeURIComponent(this.password)}` : this.wsUrl;
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
      if (this.ws === ws) {
        this.ws = null;
      }
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

export function getSessionChannel(httpBaseUrl: string, password?: string): WsSessionChannel {
  const wsUrl = `${httpBaseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/ws`;
  const existing = channels.get(wsUrl);
  if (existing) {
    existing.setPassword(password);
    return existing;
  }
  const channel = new WsSessionChannel(wsUrl, password);
  channels.set(wsUrl, channel);
  return channel;
}
