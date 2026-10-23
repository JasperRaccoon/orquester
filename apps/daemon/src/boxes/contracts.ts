/**
 * Ephemeral AI VMs — the daemon-side seams between the box modules (spec
 * docs/superpowers/specs/2026-10-19-ephemeral-ai-vms-design.md). Every module
 * under `boxes/` codes against these interfaces, not against each other's
 * classes, so they can be built and tested independently (fakes in
 * `boxes/testing.ts`). Module map: `boxes/README.md`.
 */

import type { Duplex, Readable, Writable } from "node:stream";

import type {
  BoxAgentConfig,
  BoxArch,
  BoxBoxToHostMethods,
  BoxChannelSpec,
  BoxDetachedProcInfo,
  BoxHostToBoxMethods,
  BoxImageOffer,
  BoxKind,
  BoxLibc,
  BoxMethodName,
  BoxMethodParams,
  BoxMethodResult,
  BoxOs,
  BoxPathMap,
  BoxProviderCredentialField,
  BoxProviderId,
  BoxPtySpec,
  BoxRegionOffer,
  BoxSizeOffer,
  BoxSummary,
  BoxSysInfo
} from "@orquester/api";
import type { StoredBox } from "@orquester/config";

// ---------------------------------------------------------------------------
// The live link to one box (implemented by boxes/hub)
// ---------------------------------------------------------------------------

export interface BoxRequestOptions {
  signal?: AbortSignal;
  /** Default 30 s. */
  timeoutMs?: number;
}

export interface BoxExecOptions {
  command: string;
  args?: string[];
  /** Box path (already mapped with `hostToBoxPath`). */
  cwd?: string;
  env?: Record<string, string>;
  envUnset?: string[];
  pty?: BoxPtySpec;
  /** Survive disconnects; reattach with {@link BoxConnection.attach}. */
  detach?: { procId: string; bufferBytes?: number };
  shell?: boolean;
  signal?: AbortSignal;
}

/**
 * A process running in the box, shaped like the parts of `ChildProcess` the
 * daemon and agent host use (and like the Agent SDK's `SpawnedProcess`).
 * `exitCode`/`signalCode` are null while it runs. If the link drops and the
 * process was not detached, it ends with `exitCode: null, signalCode: "SIGHUP"`.
 * A detached process whose link drops emits `"detached"` instead of `"exit"`.
 */
export interface BoxProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: number | null;
  readonly procId: string | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly killed: boolean;
  /**
   * Detached processes: the output offset reached (stdout + stderr bytes, emission order),
   * including any `droppedBytes` an attach reported — the `fromOffset` for the next attach.
   * After `spawn`, an attach whose offset is past the one asked for lost output.
   */
  readonly outputOffset?: number;
  /** Sends the signal to the process in the box. Returns false once it has exited. */
  kill(signal?: NodeJS.Signals): boolean;
  resize(cols: number, rows: number): void;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "spawn", listener: () => void): this;
  on(event: "detached", listener: () => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "spawn", listener: () => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, listener: (...args: any[]) => void): this;
}

export interface BoxHostForward {
  /** Host loopback port that pipes to the box port. */
  readonly hostPort: number;
  readonly boxPort: number;
  close(): Promise<void>;
}

export interface BoxConnection {
  readonly boxId: string;
  readonly sys: BoxSysInfo;
  readonly paths: BoxPathMap;
  readonly connected: boolean;
  readonly agentVersion: string;
  /** Detached processes as of the latest hello. */
  detachedProcs(): BoxDetachedProcInfo[];

  request<K extends BoxMethodName<BoxHostToBoxMethods>>(
    method: K,
    params: BoxMethodParams<BoxHostToBoxMethods, K>,
    options?: BoxRequestOptions
  ): Promise<BoxMethodResult<BoxHostToBoxMethods, K>>;
  /** Untyped escape hatch for feature namespaces (`sync.*`, `tooling.*`, `mcp.*`). */
  requestRaw(method: string, params: unknown, options?: BoxRequestOptions): Promise<unknown>;

  exec(options: BoxExecOptions): BoxProcess;
  attach(procId: string, fromOffset: number): BoxProcess;
  /** A TCP stream to `host:port` as seen from the box. */
  openTcp(port: number, host?: string): Promise<Duplex>;
  /** Listen on a host loopback port and pipe each connection to the box port (dev servers, OpenCode). */
  forwardToHost(boxPort: number, options?: { hostPort?: number }): Promise<BoxHostForward>;
  /** Raw channel open for kinds without a helper. */
  openChannel(spec: BoxChannelSpec): Promise<Duplex>;

  readFile(path: string, options?: { offset?: number; length?: number; signal?: AbortSignal }): Promise<Readable>;
  /** Resolves once the box confirmed the atomic rename. */
  writeFile(path: string, data: Readable | Uint8Array | string, options?: { mode?: number; mkdirs?: boolean }): Promise<void>;
  readTar(path: string, options?: { exclude?: string[] }): Promise<Readable>;
  /** Extract a tar stream into dir `path` (`compression: "gzip"`: the stream is gzipped). */
  writeTar(path: string, tar: Readable, options?: { compression?: "gzip" }): Promise<void>;

  /** `fs.change` and other box events. Returns an unsubscribe function. */
  onEvent(name: string, listener: (data: unknown) => void): () => void;
  /** Fires when the link drops or comes back; a connection object stays valid across reconnects. */
  onStatus(listener: (connected: boolean) => void): () => void;
}

/** Context passed to handlers of box → host requests and channels. */
export interface BoxRequestContext {
  boxId: string;
  record: StoredBox;
}

export type BoxRequestHandler<K extends BoxMethodName<BoxBoxToHostMethods>> = (
  context: BoxRequestContext,
  params: BoxMethodParams<BoxBoxToHostMethods, K>,
  signal: AbortSignal
) => Promise<BoxMethodResult<BoxBoxToHostMethods, K>>;

export type BoxRawRequestHandler = (context: BoxRequestContext, params: unknown, signal: AbortSignal) => Promise<unknown>;

/** Handles a box-opened channel (`host-tcp`, `ssh-agent`, `mcp-bridge`). */
export type BoxChannelHandler = (context: BoxRequestContext, spec: BoxChannelSpec, stream: Duplex) => void;

/** The daemon's side of every box link (implemented by boxes/hub). */
export interface BoxHub {
  /** The connection object for a box, whether or not it is connected right now. Undefined = never connected. */
  get(boxId: string): BoxConnection | undefined;
  /** Resolves when the box is connected (immediately if it is). */
  waitConnected(boxId: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<BoxConnection>;
  /** Mint the single-use bootstrap token for a box; only its hash is stored (in the box record). */
  issueBootstrapToken(boxId: string, ttlMs: number): Promise<string>;
  /** Forget a box: close its link, refuse it from now on (used when it is destroyed). */
  revoke(boxId: string): Promise<void>;
  /** Forwards `orq-agent` must re-establish on every connect (merged into `welcome.config.forwards`). */
  setForwards(boxId: string, forwards: BoxAgentConfig["forwards"]): void;
  handle<K extends BoxMethodName<BoxBoxToHostMethods>>(method: K, handler: BoxRequestHandler<K>): void;
  handleRaw(method: string, handler: BoxRawRequestHandler): void;
  handleChannel(kind: "host-tcp" | "ssh-agent" | "mcp-bridge", handler: BoxChannelHandler): void;
  onConnectionChange(listener: (boxId: string, connected: boolean) => void): () => void;
}

// ---------------------------------------------------------------------------
// Providers (implemented under boxes/providers)
// ---------------------------------------------------------------------------

/** Credential field id → value, as stored in box-secrets.json. */
export type ProviderCredentials = Readonly<Record<string, string>>;

/**
 * What the new box must run first. The bootstrap module (boxes/bootstrap) builds
 * it; each adapter delivers it the way its provider allows (cloud-init user data,
 * a startup script, a container start command, a workflow input).
 */
export interface BoxBootstrap {
  /** POSIX shell script (Linux/macOS). Downloads orq-agent from the daemon and starts it. */
  posixScript: string;
  /** PowerShell script (Windows). */
  powershellScript: string;
  /** For container providers: argv of the container's start command (runs `posixScript`). */
  containerCommand: string[];
  /** For container providers that take env vars instead of a script body. */
  env: Record<string, string>;
  /** cloud-init user data wrapping `posixScript` (`#cloud-config` with a runcmd), for providers that want YAML. */
  cloudInit: string;
  /**
   * A compact first stage for providers that cap the script's size (vast.ai `onstart`): writes the
   * secrets like `posixScript`, joins the tailnet, then fetches and runs the generic second stage
   * (`boxRoutes.bootstrapScript`) with the bootstrap token. Optional: test doubles may omit it.
   */
  stagedPosixScript?: string;
}

export interface ProviderCreateRequest {
  boxId: string;
  /** `orq-<boxId>`: the instance name, and the reconciler's marker where tags are missing. */
  name: string;
  kind: BoxKind;
  size: string;
  region: string;
  image: string | null;
  /** Applied as provider tags/labels where supported: always includes `orquester-box=<boxId>`. */
  tags: Record<string, string>;
  bootstrap: BoxBootstrap;
  /**
   * Public key for providers that refuse to create Linux instances without one. Orquester never
   * uses SSH to reach a box; the matching private key is discarded.
   */
  sshPublicKey: string;
  /** Windows: an administrator password to set where the provider asks for one. */
  windowsPassword: string | null;
  lifetimeMinutes: number | null;
}

export type ProviderInstanceState = "pending" | "running" | "stopped" | "gone" | "error";

export interface ProviderInstanceStatus {
  state: ProviderInstanceState;
  /** Provider wording, one line, for `stateReason` ("Destroyed in the Vultr dashboard"). */
  detail: string | null;
  publicIp: string | null;
  /** Live price if the provider reports one. */
  hourlyUsd: number | null;
}

/** Provider-side identity of an instance (ids, zone, run id…), persisted as `StoredBox.providerRef`. */
export type ProviderInstanceRef = Record<string, unknown>;

export interface ProviderCreateResult {
  ref: ProviderInstanceRef;
  hourlyUsd: number | null;
  /** Windows password the provider generated (stored in box-secrets.json, never returned). */
  windowsPassword?: string;
  /** Hard deadline the provider imposes (macOS job timeout). */
  deadlineAt?: string;
}

export interface ProviderManagedInstance {
  ref: ProviderInstanceRef;
  name: string;
  /** From the `orquester-box` tag, or parsed from `orq-<boxId>`. */
  boxId: string | null;
  createdAt: string | null;
  state: ProviderInstanceState;
}

export interface ProviderOffers {
  sizes: BoxSizeOffer[];
  regions: BoxRegionOffer[];
  images: BoxImageOffer[];
  priceSource: "live" | "table";
}

export interface ProviderCallOptions {
  signal: AbortSignal;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface BoxProviderAdapter {
  readonly id: BoxProviderId;
  readonly label: string;
  readonly kinds: readonly BoxKind[];
  readonly website: string;
  readonly credentialsUrl: string;
  readonly credentialFields: readonly BoxProviderCredentialField[];
  readonly accountNote: string | null;
  readonly maxLifetimeMinutes: number | null;
  /** Whether Windows boxes need a prepared image first (spec §11.1). */
  readonly needsWindowsImage: boolean;

  /** A cheap authenticated read. Never throws for bad credentials: returns `{ ok: false }`. */
  validate(credentials: ProviderCredentials, options: ProviderCallOptions): Promise<{ ok: true } | { ok: false; message: string }>;
  offers(credentials: ProviderCredentials, kind: BoxKind, options: ProviderCallOptions): Promise<ProviderOffers>;
  /**
   * Create the instance. Must not leave an unmarked instance behind: if the call fails after the
   * provider accepted it, the instance still carries `name`/tags so the reconciler finds it.
   */
  create(credentials: ProviderCredentials, request: ProviderCreateRequest, options: ProviderCallOptions): Promise<ProviderCreateResult>;
  status(credentials: ProviderCredentials, ref: ProviderInstanceRef, options: ProviderCallOptions): Promise<ProviderInstanceStatus>;
  /** Idempotent: an instance that is already gone resolves normally. */
  destroy(credentials: ProviderCredentials, ref: ProviderInstanceRef, options: ProviderCallOptions): Promise<void>;
  /** Every instance carrying Orquester's marker (tag or `orq-` name prefix). */
  listManaged(credentials: ProviderCredentials, options: ProviderCallOptions): Promise<ProviderManagedInstance[]>;
  /** Providers with `needsWindowsImage`: build and snapshot the prepared Windows image; returns its id. */
  prepareWindowsImage?(
    credentials: ProviderCredentials,
    request: { region: string; bootstrap: BoxBootstrap; log: (line: string) => void },
    options: ProviderCallOptions
  ): Promise<{ imageId: string }>;
}

/** All adapters by id (boxes/providers/index.ts). */
export type BoxProviderRegistry = ReadonlyMap<BoxProviderId, BoxProviderAdapter>;

// ---------------------------------------------------------------------------
// Bootstrap, connectivity, OIDC (boxes/bootstrap, boxes/tailscale, boxes/github)
// ---------------------------------------------------------------------------

export interface BootstrapInput {
  boxId: string;
  /** The origin `orq-agent` downloads itself from and dials (`https://…`). */
  daemonUrl: string;
  bootstrapToken: string;
  /** When the box joins the tailnet first: a single-use, ephemeral, tagged auth key. */
  tailscaleAuthKey: string | null;
  /** Container providers: run tailscaled in userspace-networking mode. */
  container: boolean;
}

export type BuildBootstrap = (input: BootstrapInput) => BoxBootstrap;

export interface TailscaleKeys {
  /** A single-use, pre-authorized, ephemeral auth key tagged `tag:orq-box`, valid `ttlSeconds`. */
  mintAuthKey(options: { boxId: string; ttlSeconds: number; signal: AbortSignal }): Promise<string>;
  /** Remove the box's node now (ephemeral nodes also expire on their own). */
  removeNode(options: { boxId: string; signal: AbortSignal }): Promise<void>;
}

/** Claims the daemon checks on a GitHub Actions OIDC token (spec §11.2). */
export interface GithubOidcExpectation {
  /** `owner/name` of the control repo. */
  repository: string;
  runId: string;
  /** The daemon origin used as the token's audience. */
  audience: string;
}

export type VerifyGithubOidc = (
  jwt: string,
  expectation: GithubOidcExpectation,
  options: { signal: AbortSignal; fetch?: typeof fetch; now?: () => number }
) => Promise<{ ok: true } | { ok: false; message: string }>;

// ---------------------------------------------------------------------------
// Box records and project locations (boxes/service)
// ---------------------------------------------------------------------------

export type ProjectLocation =
  | { kind: "host" }
  /** `connection` is undefined until the box first connected. */
  | { kind: "box"; boxId: string; record: StoredBox; connection: BoxConnection | undefined };

export interface BoxRegistry {
  list(): StoredBox[];
  get(boxId: string): StoredBox | undefined;
  summary(boxId: string): BoxSummary | undefined;
  /** The project box whose project path is `projectPath` (or contains it). Host when none. */
  locate(path: string): ProjectLocation;
  /** Like {@link locate} but throws `BOX_NOT_READY` (409) unless the box is connected and ready. */
  requireConnected(path: string): Promise<BoxConnection | null>;
  onChange(listener: (boxId: string) => void): () => void;
}

// ---------------------------------------------------------------------------
// Agent tokens, config and transcript sync, tooling (boxes/broker, boxes/sync, boxes/tooling)
// ---------------------------------------------------------------------------

export type BoxAgentId = "claude" | "codex" | "grok";

export interface AgentTokenGrant {
  accessToken: string;
  /** Epoch ms; null when the provider gave none. */
  expiresAt: number | null;
  /** Codex: `chatgptAccountId`; Grok: issuer/client keys the CLI needs. Never a refresh token. */
  extra?: Record<string, string>;
}

/** Spec §7: hands out access tokens; never a refresh token; never a second refresher. */
export interface AgentTokenBroker {
  getToken(
    /** `rejectedAccessToken`: the token the CLI was refused with; renewed (holder rules apply) while it is still current. */
    request: { boxId: string; agent: BoxAgentId; accountId: string; minValidSeconds?: number; rejectedAccessToken?: string },
    signal: AbortSignal
  ): Promise<AgentTokenGrant>;
}

/** What one agent CLI launch in a box needs synced first. All paths are host paths. */
export interface BoxSyncScope {
  agent: BoxAgentId | "opencode";
  /** The account home (or a prepared profile dir) the CLI reads its config from. */
  configRoots: string[];
  /** The chat whose turns may produce box → host changes (for approval cards). */
  threadId: string | null;
}

/**
 * How far one config root's pass got: `root` (a host path: one of the scope's roots, or a shared
 * dir they link to), `total` files to send (0 while both sides are compared), `done` of them sent.
 */
export interface BoxSyncProgress {
  root: string;
  done: number;
  total: number;
}

export interface BoxConfigSync {
  /**
   * Bring the box's copy of `scope` up to date (hash compare) before a CLI starts. `onProgress`
   * hears each root's pass as it goes (as often as files are sent: throttle before persisting).
   */
  ensureSynced(boxId: string, scope: BoxSyncScope, signal: AbortSignal, options?: { onProgress?: (progress: BoxSyncProgress) => void }): Promise<void>;
  /** Keep pushing host changes to the box and collecting box changes for approval. */
  watch(boxId: string, scope: BoxSyncScope): () => void;
  /** Mark the end of a turn: box changes collected since the last call become one approval set. */
  turnEnded(boxId: string, threadId: string): Promise<void>;
  /**
   * boxes (sync): mark the start of a turn, so box changes made while it runs wait for its
   * `turnEnded` instead of being grouped by the idle debounce (with `threadId: null`). Optional:
   * without it every change is grouped by the debounce or by the next `turnEnded`.
   */
  turnStarted?(boxId: string, threadId: string): void;
}

export interface BoxTranscriptSync {
  /** Before a CLI resumes in a box: push the session's provider files from the host. */
  pushForResume(boxId: string, request: { agent: BoxAgentId | "opencode"; configRoot: string; cwd: string; sessionRef: string | null }, signal: AbortSignal): Promise<void>;
  /** After each turn: copy what the CLI appended back to the host at the same paths. */
  pullAfterTurn(boxId: string, request: { agent: BoxAgentId | "opencode"; configRoot: string; cwd: string; sessionRef: string | null }, signal: AbortSignal): Promise<void>;
}

/** The target a session runs on, for plugins that contribute per-session tooling (spec §10). */
export interface ToolTarget {
  os: BoxOs;
  arch: BoxArch;
  libc: BoxLibc | null;
}

export interface SessionToolingContribution {
  /** Prepended to PATH (target path syntax). */
  pathPrepend: string[];
  env: Record<string, string>;
  /** Files for Node's `--require`, appended to NODE_OPTIONS (target path syntax). */
  nodeRequire: string[];
}

export interface BoxToolingProvisioner {
  /** Install every enabled tooling plugin for the box's target; idempotent. */
  provision(boxId: string, signal: AbortSignal): Promise<void>;
  /** The env a session launched in the box gets from tooling plugins. */
  contribution(boxId: string): SessionToolingContribution;
}
