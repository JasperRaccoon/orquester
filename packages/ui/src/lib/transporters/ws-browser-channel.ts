import {
  BROWSER_FRAME_TYPE_JPEG,
  type BrowserClientMessage,
  type BrowserPickPayload,
  type BrowserServerJsonMessage,
  type BrowserStateMessage
} from "@orquester/api";

export interface BrowserStreamHandlers {
  onFrame(jpeg: ArrayBuffer): void;
  onState(state: BrowserStateMessage): void;
  onPicked(payload: BrowserPickPayload): void;
  onEnd(): void;
}

/**
 * Multiplexes every browser tab's screencast + control for one daemon over a
 * single WebSocket (sibling of WsSessionChannel; kept separate so terminals'
 * text-only path is untouched). Binary frames carry pixels:
 * [u8 type=1][36-byte tab id ascii][JPEG]. There is no replay semantic — on
 * reconnect the daemon re-primes with a fresh screenshot frame.
 */
export class WsBrowserChannel {
  private ws: WebSocket | null = null;
  private readonly subs = new Map<string, BrowserStreamHandlers>();
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

  open(id: string, handlers: BrowserStreamHandlers): { close(): void } {
    this.subs.set(id, handlers);
    this.send({ t: "sub", id });
    return {
      close: () => {
        if (this.subs.delete(id)) {
          this.send({ t: "unsub", id });
        }
      }
    };
  }

  send(msg: BrowserClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
    // Dropped while offline: subs re-subscribe on reconnect; input during a
    // blip is simply lost (no replay semantic for a live stream).
  }

  /**
   * The page regained visibility/focus/network. Mobile browsers freeze hidden
   * tabs and kill their sockets — often WITHOUT delivering `close` (the
   * half-dead state: readyState still reads OPEN while frames go nowhere). So:
   * a pending backoff timer is short-circuited to redial NOW, a dead socket is
   * torn down and redialed, and an apparently-open socket must answer a ping
   * within the deadline or it is force-reconnected. Safe to call aggressively —
   * the daemon re-primes with a fresh screenshot frame on re-subscribe.
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
    this.send({ t: "ping" });
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

  private connect(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.credential
        ? `${this.wsUrl}?token=${encodeURIComponent(this.credential)}`
        : this.wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      for (const id of this.subs.keys()) this.send({ t: "sub", id });
    };

    ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data);
        if (bytes.length < 37 || bytes[0] !== BROWSER_FRAME_TYPE_JPEG) return;
        const id = new TextDecoder().decode(bytes.subarray(1, 37));
        this.subs.get(id)?.onFrame(event.data.slice(37));
        return;
      }
      if (typeof event.data !== "string") return;
      let msg: BrowserServerJsonMessage;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.t === "pong") {
        this.clearPongDeadline();
        return;
      }
      const handlers = this.subs.get(msg.id);
      if (!handlers) return;
      if (msg.t === "state") handlers.onState(msg);
      else if (msg.t === "picked") handlers.onPicked(msg.payload);
      else if (msg.t === "end") handlers.onEnd();
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
}

/** One shared channel per daemon origin, reused across ApiClient rebuilds. */
const channels = new Map<string, WsBrowserChannel>();

/** Wake every live channel (see {@link WsBrowserChannel.wake}) — called on
 *  visibility/focus/online regain by the store's wakeConnections. */
export function wakeBrowserChannels(): void {
  for (const channel of channels.values()) channel.wake();
}

export function getBrowserChannel(httpBaseUrl: string, credential?: string): WsBrowserChannel {
  const wsUrl = `${httpBaseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/ws-browser`;
  const existing = channels.get(wsUrl);
  if (existing) {
    existing.setCredential(credential);
    return existing;
  }
  const channel = new WsBrowserChannel(wsUrl, credential);
  channels.set(wsUrl, channel);
  return channel;
}
