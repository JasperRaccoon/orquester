/**
 * Golden protocol fixtures shared by the TypeScript and Go sides of
 * `box-protocol.ts`. The values are typed against the TypeScript contract
 * (mapped types force one entry per message type, channel kind and method),
 * written to `fixtures/*.json` (`UPDATE_FIXTURES=1` rewrites them), and
 * decoded strictly and re-encoded by `internal/wire/wire_test.go`. A field
 * added, renamed or retyped on either side fails one of the two tests.
 */

import {
  BOX_AGENT_PLATFORMS,
  BOX_CHANNEL_WINDOW_BYTES,
  BOX_DETACH_BUFFER_BYTES,
  BOX_HEARTBEAT_MS,
  BOX_MAX_FRAME_PAYLOAD,
  BOX_PROTOCOL_VERSION,
  BOX_WINDOWS_PATH_PREFIX,
  encodeDataFrame,
  type BoxBoxToHostMethods,
  type BoxChannelKind,
  type BoxChannelSpec,
  type BoxControlMessage,
  type BoxFsChangeEvent,
  type BoxHostToBoxMethods,
  type BoxStream,
  type BoxSysInfo
} from "@orquester/api";

export const constantsFixture = {
  protocolVersion: BOX_PROTOCOL_VERSION,
  channelWindowBytes: BOX_CHANNEL_WINDOW_BYTES,
  maxFramePayload: BOX_MAX_FRAME_PAYLOAD,
  heartbeatMs: BOX_HEARTBEAT_MS,
  detachBufferBytes: BOX_DETACH_BUFFER_BYTES,
  windowsPathPrefix: BOX_WINDOWS_PATH_PREFIX,
  platforms: [...BOX_AGENT_PLATFORMS]
};

const sysLinux: BoxSysInfo = {
  os: "linux",
  arch: "x64",
  libc: "glibc",
  hostname: "orq-box1",
  osRelease: "Ubuntu 24.04.1 LTS",
  user: "dev",
  isRoot: false,
  canElevate: true,
  home: "/home/dev",
  shell: "/bin/bash",
  tmux: true,
  docker: false,
  cpus: 8,
  memBytes: 16_777_216_000,
  gpus: ["NVIDIA L4"],
  agentPath: "/usr/local/bin/orq-agent",
  dataDir: "/var/lib/orq-agent",
  container: false
};

const sysWindows: BoxSysInfo = {
  ...sysLinux,
  os: "win32",
  libc: null,
  osRelease: "Windows Server 2022 21H2",
  user: "Administrator",
  isRoot: true,
  home: "C:\\Users\\Administrator",
  shell: "powershell.exe",
  tmux: false,
  gpus: [],
  agentPath: "C:\\orq\\bin\\orq-agent.exe",
  dataDir: "C:\\orq\\agent"
};

const fsChange: BoxFsChangeEvent = {
  watchId: "w-1",
  changes: [
    { path: "/srv/p/a.ts", type: "create" },
    { path: "/srv/p/b.ts", type: "update" },
    { path: "/srv/p/c.ts", type: "delete" }
  ]
};

type ByT = { [T in BoxControlMessage["t"]]: Extract<BoxControlMessage, { t: T }>[] };

export const controlFixture: ByT = {
  hello: [
    {
      t: "hello",
      protocol: 1,
      agentVersion: "0.1.0+abc1234",
      auth: { kind: "bootstrap", token: "box1.c2VjcmV0" },
      sys: sysLinux,
      procs: []
    },
    {
      t: "hello",
      protocol: 1,
      agentVersion: "0.1.0+abc1234",
      auth: { kind: "credential", boxId: "box1", credential: "Y3JlZA" },
      sys: sysWindows,
      procs: [
        { procId: "p1", pid: 4242, running: true, exitCode: null, signal: null, outputBytes: 9000, bufferStart: 0 },
        { procId: "p2", pid: null, running: false, exitCode: 0, signal: null, outputBytes: 5, bufferStart: 1 },
        { procId: "p3", pid: null, running: false, exitCode: null, signal: "SIGKILL", outputBytes: 0, bufferStart: 0 }
      ]
    },
    {
      t: "hello",
      protocol: 1,
      agentVersion: "0.1.0+abc1234",
      auth: { kind: "github-oidc", boxId: "box2", jwt: "eyJ.eyJ.sig" },
      sys: { ...sysLinux, os: "darwin", arch: "arm64", libc: null },
      procs: []
    }
  ],
  welcome: [
    {
      t: "welcome",
      boxId: "box1",
      credential: "Y3JlZA",
      config: { paths: { kind: "identity" }, heartbeatMs: 15000, forwards: [{ boxPort: 47999, target: "session-tools" }] }
    },
    { t: "welcome", boxId: "box1", config: { paths: { kind: "windows-prefix", prefix: "C:\\orq" }, heartbeatMs: 15000, forwards: [] } }
  ],
  reject: [
    { t: "reject", code: "AUTH_FAILED", message: "bad credential" },
    { t: "reject", code: "AGENT_OUTDATED", message: "update failed", upgradeUrl: "https://d.example/api/boxes/agent/linux-x64" }
  ],
  ping: [{ t: "ping", id: 1 }],
  pong: [{ t: "pong", id: 1 }],
  req: [
    { t: "req", id: 7, method: "fs.stat", params: { path: "/srv/p" } },
    { t: "req", id: 8, method: "sys.info", params: {} }
  ],
  res: [
    { t: "res", id: 7, ok: true, result: { size: 1 } },
    { t: "res", id: 9, ok: true, result: null },
    { t: "res", id: 10, ok: true, result: undefined },
    { t: "res", id: 8, ok: false, error: { code: "ENOENT", message: "no such file" } }
  ],
  event: [{ t: "event", name: "fs.change", data: fsChange }],
  open: [
    { t: "open", ch: 2, spec: { kind: "exec", command: "ls", args: ["-la"] } },
    { t: "open", ch: 1, spec: { kind: "host-tcp", target: "session-tools", boxPort: 47999 } }
  ],
  opened: [
    { t: "opened", ch: 2 },
    { t: "opened", ch: 4, info: { pid: 99 } },
    { t: "opened", ch: 6, info: { pid: 99, droppedBytes: 0 } },
    { t: "opened", ch: 8, info: { size: 123456 } }
  ],
  "open-failed": [{ t: "open-failed", ch: 2, error: { code: "ENOENT", message: "command not found: lss" } }],
  eof: [
    { t: "eof", ch: 2, stream: 0 },
    { t: "eof", ch: 2, stream: 1 },
    { t: "eof", ch: 2, stream: 2 }
  ],
  exit: [
    { t: "exit", ch: 2, code: 0, signal: null },
    { t: "exit", ch: 4, code: null, signal: "SIGTERM" }
  ],
  resize: [{ t: "resize", ch: 2, cols: 120, rows: 40 }],
  signal: [{ t: "signal", ch: 2, signal: "SIGINT" }],
  credit: [{ t: "credit", ch: 2, bytes: 65536 }],
  close: [
    { t: "close", ch: 2 },
    { t: "close", ch: 4, error: { code: "ENOSPC", message: "no space left on device" } }
  ]
};

type ByKind = { [K in BoxChannelKind]: Extract<BoxChannelSpec, { kind: K }>[] };

export const channelsFixture: ByKind = {
  exec: [
    { kind: "exec", command: "git", args: ["status", "--short"] },
    {
      kind: "exec",
      command: "claude",
      args: ["--print"],
      cwd: "/srv/p",
      env: { CLAUDE_CONFIG_DIR: "/home/dev/.claude" },
      envUnset: ["NODE_OPTIONS"],
      pty: { cols: 80, rows: 24, term: "xterm-256color" },
      detach: { procId: "proc-1", bufferBytes: 1048576 },
      shell: false
    },
    { kind: "exec", command: "echo hi && exit 3", args: [], shell: true, pty: { cols: 100, rows: 30 }, detach: { procId: "proc-2" } }
  ],
  attach: [{ kind: "attach", procId: "proc-1", fromOffset: 0 }, { kind: "attach", procId: "proc-1", fromOffset: 4096 }],
  tcp: [{ kind: "tcp", port: 3000 }, { kind: "tcp", host: "10.0.0.2", port: 5432 }],
  unix: [{ kind: "unix", path: "/home/dev/.orq-agent/desktops/d1/vnc.sock" }],
  "host-tcp": [{ kind: "host-tcp", target: "mcp:abc", boxPort: 40123 }],
  "file-read": [{ kind: "file-read", path: "/srv/p/a.bin" }, { kind: "file-read", path: "/srv/p/a.bin", offset: 0, length: 4096 }],
  "file-write": [
    { kind: "file-write", path: "/srv/p/out.txt" },
    { kind: "file-write", path: "/srv/p/out.txt", mode: 0o600, mkdirs: true, append: false }
  ],
  "tar-read": [{ kind: "tar-read", path: "/srv/p" }, { kind: "tar-read", path: "/srv/p", exclude: ["node_modules", "*.log"] }],
  "tar-write": [{ kind: "tar-write", path: "/srv/q" }, { kind: "tar-write", path: "/srv/q", compression: "gzip" }],
  "ssh-agent": [{ kind: "ssh-agent" }],
  "mcp-bridge": [{ kind: "mcp-bridge", serverId: "github" }]
};

type MethodSamples<M> = { [K in keyof M]: { params: M[K] extends [infer P, unknown] ? P : never; result: M[K] extends [unknown, infer R] ? R : never }[] };

const hostToBox: MethodSamples<BoxHostToBoxMethods> = {
  "fs.stat": [
    {
      params: { path: "/srv/p/a.ts", followSymlinks: false },
      result: { path: "/srv/p/a.ts", kind: "file", size: 12, mtimeMs: 1729000000123.25, mode: 0o100644, identity: "2049:1234" }
    },
    { params: { path: "/srv/p/missing" }, result: null }
  ],
  "fs.readdir": [
    {
      params: { path: "/srv/p" },
      result: [
        { name: "a.ts", kind: "file", size: 12, mtimeMs: 1729000000123.5 },
        { name: "src", kind: "dir", size: 4096, mtimeMs: 1729000000000 },
        { name: "link", kind: "symlink", size: 4, mtimeMs: 1 },
        { name: "fifo", kind: "other", size: 0, mtimeMs: 2 }
      ]
    }
  ],
  "fs.realpath": [{ params: { path: "/var/x" }, result: "/private/var/x" }],
  "fs.mkdir": [
    { params: { path: "/srv/p/new" }, result: undefined },
    { params: { path: "/srv/p/a/b", recursive: true, mode: 0o755 }, result: undefined }
  ],
  "fs.rename": [{ params: { from: "/srv/p/a", to: "/srv/p/b" }, result: undefined }],
  "fs.rm": [{ params: { path: "/srv/p/b", recursive: true, force: true }, result: undefined }],
  "fs.chmod": [{ params: { path: "/srv/p/run.sh", mode: 0o755 }, result: undefined }],
  "fs.symlink": [{ params: { target: "../a", path: "/srv/p/link" }, result: undefined }],
  "fs.watch": [
    { params: { watchId: "w-1", path: "/srv/p", recursive: true }, result: undefined },
    { params: { watchId: "w-2", path: "/srv/p", recursive: false, ignore: [".git", "node_modules"] }, result: undefined }
  ],
  "fs.unwatch": [{ params: { watchId: "w-1" }, result: undefined }],
  "sys.info": [{ params: {}, result: sysLinux }],
  "sys.ports": [
    {
      params: {},
      result: [
        { port: 3000, address: "127.0.0.1", pid: 77, command: "node" },
        { port: 22, address: "0.0.0.0", pid: null, command: null }
      ]
    }
  ],
  "sys.stats": [
    {
      params: {},
      result: { cpuPercent: 12.5, memUsedBytes: 1024, memTotalBytes: 4096, diskUsedBytes: 10, diskTotalBytes: 100, uptimeSeconds: 3600.5 }
    }
  ],
  "proc.list": [
    { params: {}, result: [{ procId: "p1", pid: 1, running: true, exitCode: null, signal: null, outputBytes: 10, bufferStart: 0 }] }
  ],
  "proc.signal": [{ params: { procId: "p1", signal: "SIGTERM" }, result: undefined }],
  "proc.release": [{ params: { procId: "p1" }, result: undefined }],
  "forward.listen": [{ params: { boxPort: 47999, target: "session-tools" }, result: undefined }],
  "forward.unlisten": [{ params: { boxPort: 47999 }, result: undefined }],
  "agent.ensurePaths": [{ params: { paths: ["/var/lib/orquester/workspaces/w/p"] }, result: undefined }],
  "agent.update": [{ params: { url: "https://d.example/api/boxes/agent/linux-x64", sha256: "a".repeat(64) }, result: undefined }],
  "agent.shutdown": [{ params: { reason: "destroyed" }, result: undefined }]
};

const boxToHost: MethodSamples<BoxBoxToHostMethods> = {
  "token.get": [
    { params: { agent: "claude", accountId: "acc-1" }, result: { accessToken: "sk-ant-oat-x", expiresAt: 1729000000000 } },
    {
      params: { agent: "codex", accountId: "acc-2", minValidSeconds: 900, rejectedAccessToken: "eyJ-refused" },
      result: { accessToken: "eyJ", expiresAt: null, extra: { chatgptAccountId: "org-1" } }
    }
  ],
  "git.credential": [
    { params: { operation: "get", input: "protocol=https\nhost=github.com\n\n" }, result: { output: "username=x-access-token\npassword=t\n" } },
    { params: { operation: "store", input: "protocol=https\n" }, result: { output: "" } }
  ]
};

export const methodsFixture = { hostToBox, boxToHost };

const framePayloads: { channel: number; stream: BoxStream; payload: number[] }[] = [
  { channel: 2, stream: 0, payload: [] },
  { channel: 1, stream: 1, payload: [0x68, 0x69, 0x0a] },
  { channel: 0xfffffffe, stream: 2, payload: [0, 255, 128, 1] }
];

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

export const framesFixture = framePayloads.map(({ channel, stream, payload }) => ({
  channel,
  stream,
  payloadHex: hex(Uint8Array.from(payload)),
  frameHex: hex(encodeDataFrame(channel, stream, Uint8Array.from(payload)))
}));

/** Every fixture file, by name (without `.json`). */
export const FIXTURES: Record<string, unknown> = {
  constants: constantsFixture,
  control: controlFixture,
  channels: channelsFixture,
  methods: methodsFixture,
  frames: framesFixture
};
