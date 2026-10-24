const { contextBridge, ipcRenderer } = require("electron");

/**
 * A main → renderer channel whose messages wait for a listener: a clicked
 * notification can relaunch the window, and its target arrives before the UI
 * has mounted and subscribed. Returns the subscribe function.
 */
function bufferedChannel(channel) {
  const queue = [];
  const listeners = new Set();
  ipcRenderer.on(channel, (_event, payload) => {
    if (listeners.size === 0) {
      if (queue.length < 10) queue.push(payload);
      return;
    }
    for (const listener of listeners) listener(payload);
  });
  return (cb) => {
    listeners.add(cb);
    for (const payload of queue.splice(0)) cb(payload);
    return () => listeners.delete(cb);
  };
}

contextBridge.exposeInMainWorld("orquesterDesktop", {
  defaultConnection: {
    id: "local",
    name: "Local daemon",
    kind: "local",
    endpoint: `unix://${process.env.ORQUESTER_UNIX_SOCKET}`,
    status: "connected"
  },
  // Byte transport for the renderer's UnixSocketTransporter. The envelope may
  // carry an optional requestId; the main process keys in-flight requests by it
  // so requestAbort can cancel a specific one (mirrors the stream close channel).
  request: (request) => ipcRenderer.invoke("orquester:request", request),
  // Raw-bytes request (file preview) over the unix socket.
  requestBytes: (request) => ipcRenderer.invoke("orquester:request-bytes", request),
  // Abort a socket request previously issued with a matching requestId.
  requestAbort: (requestId) => ipcRenderer.send("orquester:request:abort", requestId),
  // Chunked streaming (session output, event bus). The renderer supplies the id.
  streamOpen: (streamId, path) => ipcRenderer.send("orquester:stream:open", { streamId, path }),
  streamClose: (streamId) => ipcRenderer.send("orquester:stream:close", streamId),
  onStreamData: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on("orquester:stream:data", listener);
    return () => ipcRenderer.removeListener("orquester:stream:data", listener);
  },
  onStreamEnd: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on("orquester:stream:end", listener);
    return () => ipcRenderer.removeListener("orquester:stream:end", listener);
  },
  // Remote HTTP transport (the renderer's HttpTransporter for remote servers).
  // Runs in the main process (Node) so cross-origin calls to the VPS aren't
  // gated by the browser's CORS — the daemon serves no CORS headers.
  httpRequest: (request) => ipcRenderer.invoke("orquester:http:request", request),
  // Raw-bytes request (file preview) over the remote HTTP transport.
  httpRequestBytes: (request) => ipcRenderer.invoke("orquester:http:request-bytes", request),
  // Abort a remote HTTP request previously issued with a matching requestId.
  httpRequestAbort: (requestId) => ipcRenderer.send("orquester:http:request:abort", requestId),
  httpStreamOpen: (streamId, url, headers) => ipcRenderer.send("orquester:http-stream:open", { streamId, url, headers }),
  httpStreamClose: (streamId) => ipcRenderer.send("orquester:http-stream:close", streamId),
  onHttpStreamData: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on("orquester:http-stream:data", listener);
    return () => ipcRenderer.removeListener("orquester:http-stream:data", listener);
  },
  onHttpStreamEnd: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on("orquester:http-stream:end", listener);
    return () => ipcRenderer.removeListener("orquester:http-stream:end", listener);
  },
  // Optional theme hook: the renderer reports the resolved colour scheme's base
  // surface so the main process can persist it and paint the NEXT launch's
  // window with it (the native background is chosen before any renderer code
  // runs). Fire-and-forget; the payload is validated in the main process.
  setWindowBackground: (payload) => ipcRenderer.send("orquester:window-background", payload),
  // Agent visuals: the scheme the main process serves agent pages under
  // (`orq-visual://local/…`, `orq-visual://remote/<base64url origin>/…`), so
  // the renderer frames them without an http URL it may not reach. Absent on
  // an older build, where the renderer falls back to the daemon's http URL.
  visualScheme: "orq-visual",
  // Native integration (`DesktopHost` in packages/ui/src/lib/desktop-host.ts).
  // Payloads are validated in the main process, and what comes back in the UI.
  host: {
    platform: process.platform,
    // Set by the main process for a window without OS caption buttons
    // (NO_NATIVE_CONTROLS_ARGUMENT in window-state.ts).
    nativeWindowControls: !process.argv.includes("--orquester-no-native-window-controls"),
    titlebarChanged: () => ipcRenderer.send("orquester:titlebar-changed"),
    notify: (request) => ipcRenderer.send("orquester:notify", request),
    setBadgeCount: (count) => ipcRenderer.send("orquester:badge", count),
    onNotificationOpen: bufferedChannel("orquester:notification-open"),
    onMenuAction: bufferedChannel("orquester:menu-action")
  },
  // Frameless window caption controls.
  windowControls: {
    minimize: () => ipcRenderer.send("orquester:window", "minimize"),
    toggleMaximize: () => ipcRenderer.send("orquester:window", "toggleMaximize"),
    close: () => ipcRenderer.send("orquester:window", "close")
  }
});
