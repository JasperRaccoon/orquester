/**
 * Minimal types for the parts of noVNC 1.7 (`@novnc/novnc`, MPL-2.0) the desktop
 * viewer uses. The package ships no types and exports only `core/rfb.js` as its
 * root entry (deep `core/...` imports are not in its `exports` map).
 * API reference: node_modules/@novnc/novnc/docs/API.md.
 */
declare module "@novnc/novnc" {
  /** A WebSocket / RTCDataChannel-like object noVNC attaches to instead of opening a URL. */
  export interface RfbRawChannel {
    readonly readyState: number | string;
    readonly protocol: string;
    binaryType: BinaryType;
    send(data: ArrayBufferLike | ArrayBufferView): void;
    close(): void;
    onopen: ((ev: Event) => unknown) | null;
    onmessage: ((ev: MessageEvent) => unknown) | null;
    onclose: ((ev: CloseEvent) => unknown) | null;
    onerror: ((ev: Event) => unknown) | null;
  }

  export interface RfbOptions {
    shared?: boolean;
    credentials?: { username?: string; password?: string; target?: string };
    repeaterID?: string;
    wsProtocols?: string[];
  }

  export interface RfbEventMap {
    connect: CustomEvent<Record<string, never>>;
    disconnect: CustomEvent<{ clean: boolean }>;
    clipboard: CustomEvent<{ text: string }>;
    desktopname: CustomEvent<{ name: string }>;
    securityfailure: CustomEvent<{ status: number; reason?: string }>;
    credentialsrequired: CustomEvent<{ types: string[] }>;
    clippingviewport: CustomEvent<boolean>;
  }

  export default class RFB {
    constructor(target: HTMLElement, urlOrChannel: string | RfbRawChannel, options?: RfbOptions);

    viewOnly: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    dragViewport: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    background: string;
    /** 0..9 */
    qualityLevel: number;
    /** 0..9 */
    compressionLevel: number;
    readonly clippingViewport: boolean;

    disconnect(): void;
    /** Press and release when `down` is omitted. `code` is a KeyboardEvent.code, or "" for keysym-only. */
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    sendCtrlAltDel(): void;
    clipboardPasteFrom(text: string): void;
    focus(options?: FocusOptions): void;
    blur(): void;

    addEventListener<K extends keyof RfbEventMap>(type: K, listener: (event: RfbEventMap[K]) => void): void;
    removeEventListener<K extends keyof RfbEventMap>(type: K, listener: (event: RfbEventMap[K]) => void): void;
  }
}
