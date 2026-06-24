const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("orquesterDesktop", {
  runtime: "desktop",
  dataDir: process.env.ORQUESTER_DATA_DIR,
  socketPath: process.env.ORQUESTER_UNIX_SOCKET,
  defaultConnection: {
    id: "local",
    name: "Local daemon",
    kind: "local",
    endpoint: `unix://${process.env.ORQUESTER_UNIX_SOCKET}`,
    status: "connected"
  },
  // Byte transport for the renderer's UnixSocketTransporter.
  request: (request) => ipcRenderer.invoke("orquester:request", request),
  // Raw-bytes request (file preview) over the unix socket.
  requestBytes: (request) => ipcRenderer.invoke("orquester:request-bytes", request),
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
  // Frameless window caption controls.
  windowControls: {
    minimize: () => ipcRenderer.send("orquester:window", "minimize"),
    toggleMaximize: () => ipcRenderer.send("orquester:window", "toggleMaximize"),
    close: () => ipcRenderer.send("orquester:window", "close")
  }
});
