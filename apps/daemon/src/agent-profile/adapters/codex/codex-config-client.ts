/**
 * Agent profile — a short-lived `codex app-server` for Codex's own config API
 * (spec §4.1 `codex-config-client.ts`, §4.6 Codex).
 *
 * The chat adapter's transport is reused as it is: `spawnProviderChild` (own
 * process group, SIGTERM then SIGKILL), `CodexPeer` (NDJSON, no `jsonrpc`
 * field, independent id spaces) and `withDeadline`, with the same
 * `initialize` / `initialized` handshake. What is different here is the
 * lifecycle:
 *
 * - spawned on demand by the first call, with `CODEX_HOME` = the daemon
 *   user's own Codex home and `HOME` = the daemon user's home, in an env
 *   built by `buildAgentCliEnv` (never a spread of the daemon's env);
 * - reused while calls are pending, and closed after {@link CODEX_CONFIG_IDLE_MS}
 *   without one;
 * - every call under a deadline ({@link CODEX_CONFIG_CALL_TIMEOUT_MS}; plugin
 *   installs pass a longer one); a call that misses it kills the child, so the
 *   next call starts a fresh one rather than queueing behind a wedged server.
 *
 * Errors: an error the server ANSWERS is thrown as the protocol's
 * `CodexRpcError` (the adapter maps it — {@link toProfileError}); a spawn
 * failure, a dead child or a deadline is thrown as 502 `AGENT_CLI_FAILED` with
 * the redacted stderr tail. Nothing the server writes is logged verbatim.
 *
 * The request and result types below are the subset of the app-server's v2
 * protocol this module calls, typed from the generated 0.154 bindings
 * (`agent-host/adapters/codex/_generated/protocol/v2/`) and checked against
 * the installed 0.155.1 binary on a temp `CODEX_HOME` (where they disagree the
 * binary wins). They are kept here, not regenerated into `_generated`, so the
 * chat adapter's bindings are not touched by this feature.
 */

import { withDeadline, DeadlineExceededError } from "../../../agent-host/support/deadline.ts";
import { spawnProviderChild, type ProviderChild } from "../../../agent-host/support/spawn.ts";
import { CodexPeer, CodexRequestRefusal, CodexRpcError } from "../../../agent-host/adapters/codex/protocol.ts";
import { AgentProfileError, profileErrors } from "../../errors.ts";
import { buildAgentCliEnv, redactCliOutput } from "../../infra/index.ts";

/** Close the app-server after this long with no call pending. */
export const CODEX_CONFIG_IDLE_MS = 30_000;
/** Default per-call deadline (the `initialize` handshake included). */
export const CODEX_CONFIG_CALL_TIMEOUT_MS = 10_000;
/** `plugin/install` clones and materializes a plugin: a longer deadline. */
export const CODEX_PLUGIN_INSTALL_TIMEOUT_MS = 120_000;
/** Bytes of stderr kept for an error message. */
const STDERR_TAIL_BYTES = 4096;

// ---------------------------------------------------------------------------
// Protocol subset (v2)
// ---------------------------------------------------------------------------

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** `ConfigLayerSource`, reduced to what the adapter reads. */
export type CodexConfigLayerSource = { type: string; file?: string; profile?: string | null } & Record<string, unknown>;

export interface CodexConfigLayer {
  name: CodexConfigLayerSource;
  version: string;
  config: JsonValue;
  disabledReason?: string | null;
}

export interface CodexConfigReadParams {
  includeLayers?: boolean;
  cwd?: string | null;
}

export interface CodexConfigReadResult {
  config: Record<string, unknown>;
  origins: Record<string, unknown>;
  layers: CodexConfigLayer[] | null;
}

export interface CodexConfigEdit {
  /** Dot-separated; a segment with other characters is double-quoted (`hooks.state."/x/hooks.json:stop:0:0"`). */
  keyPath: string;
  /** `null` deletes the key. */
  value: JsonValue;
  mergeStrategy: "replace" | "upsert";
}

export interface CodexConfigBatchWriteParams {
  edits: CodexConfigEdit[];
  filePath?: string | null;
  /** The user layer's `version` from `config/read`; a mismatch answers `configVersionConflict`. */
  expectedVersion?: string | null;
  reloadUserConfig?: boolean;
}

export interface CodexConfigWriteResult {
  status: "ok" | "okOverridden";
  version: string;
  filePath: string;
  overriddenMetadata: unknown;
}

export interface CodexSkillMetadata {
  name: string;
  description: string;
  shortDescription?: string;
  /** The REALPATH of the skill's `SKILL.md` (a symlinked skill directory is reported resolved). */
  path: string;
  /** `~/.agents/skills` skills are `user` too; `.system` skills are `system`. */
  scope: "user" | "repo" | "system" | "admin";
  enabled: boolean;
  pluginId: string | null;
}

export interface CodexSkillsListResult {
  data: { cwd: string; skills: CodexSkillMetadata[]; errors: { path: string; message: string }[] }[];
}

export interface CodexSkillsConfigWriteParams {
  /** Canonicalized to the realpath by Codex; enabling removes the `[[skills.config]]` entry. */
  path?: string | null;
  name?: string | null;
  enabled: boolean;
}

export interface CodexHookMetadata {
  /** `<hooks.json path as Codex opened it>:<event_snake>:<group>:<handler>`. */
  key: string;
  eventName: string;
  handlerType: "command" | "mcpTool" | "prompt" | "agent";
  command?: string;
  matcher: string | null;
  timeoutSec: number;
  statusMessage: string | null;
  sourcePath: string;
  source: string;
  pluginId: string | null;
  enabled: boolean;
  isManaged: boolean;
  currentHash: string;
  trustStatus: "managed" | "untrusted" | "trusted" | "modified";
}

export interface CodexHooksListResult {
  data: { cwd: string; hooks: CodexHookMetadata[]; warnings: string[]; errors: { path: string; message: string }[] }[];
}

export interface CodexPluginSummary {
  /** `<plugin>@<marketplace>`. */
  id: string;
  name: string;
  version: string | null;
  localVersion: string | null;
  installed: boolean;
  enabled: boolean;
  source: { type: string; path?: string; url?: string };
  interface: { displayName: string | null; shortDescription: string | null } | null;
}

export interface CodexPluginMarketplaceEntry {
  name: string;
  /** `null` for a remote-only catalog. */
  path: string | null;
  interface: { displayName: string | null } | null;
  plugins: CodexPluginSummary[];
}

export interface CodexPluginListResult {
  marketplaces: CodexPluginMarketplaceEntry[];
  marketplaceLoadErrors: unknown[];
}

export interface CodexPluginReadParams {
  marketplacePath?: string | null;
  remoteMarketplaceName?: string | null;
  pluginName: string;
}

export interface CodexPluginReadResult {
  plugin: {
    marketplaceName: string;
    marketplacePath: string | null;
    summary: CodexPluginSummary;
    description: string | null;
    skills: { name: string; path?: string }[];
    hooks: unknown[];
    mcpServers: string[];
  };
}

export interface CodexPluginInstallParams {
  marketplacePath?: string | null;
  remoteMarketplaceName?: string | null;
  pluginName: string;
}

export interface CodexMarketplaceAddParams {
  /** `owner/repo`, a git URL, or a local marketplace path. */
  source: string;
  refName?: string | null;
  sparsePaths?: string[] | null;
}

export interface CodexMarketplaceAddResult {
  marketplaceName: string;
  installedRoot: string;
  alreadyAdded: boolean;
}

/** Every method this module calls, with its params and result. */
export interface CodexConfigMethods {
  "config/read": { params: CodexConfigReadParams; result: CodexConfigReadResult };
  "config/batchWrite": { params: CodexConfigBatchWriteParams; result: CodexConfigWriteResult };
  "skills/list": { params: { cwds?: string[]; forceReload?: boolean }; result: CodexSkillsListResult };
  "skills/config/write": { params: CodexSkillsConfigWriteParams; result: { effectiveEnabled: boolean } };
  "hooks/list": { params: { cwds?: string[] }; result: CodexHooksListResult };
  "plugin/list": { params: { cwds?: string[] | null; forceRefetch?: boolean }; result: CodexPluginListResult };
  "plugin/installed": { params: { cwds?: string[] | null }; result: CodexPluginListResult };
  "plugin/read": { params: CodexPluginReadParams; result: CodexPluginReadResult };
  "plugin/install": { params: CodexPluginInstallParams; result: { authPolicy: string; appsNeedingAuth: unknown[] } };
  "plugin/uninstall": { params: { pluginId: string }; result: Record<string, never> };
  "marketplace/add": { params: CodexMarketplaceAddParams; result: CodexMarketplaceAddResult };
  "marketplace/remove": {
    params: { marketplaceName: string };
    result: { marketplaceName: string; installedRoot: string | null };
  };
}

export type CodexConfigMethod = keyof CodexConfigMethods;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface CodexConfigClient {
  call<M extends CodexConfigMethod>(
    method: M,
    params: CodexConfigMethods[M]["params"],
    options?: { timeoutMs?: number }
  ): Promise<CodexConfigMethods[M]["result"]>;
  /**
   * Stops the app-server (if running) and resolves once every child this
   * client stopped is gone. The client can be used again afterwards.
   */
  close(): Promise<void>;
}

export interface CodexConfigClientOptions {
  /** The `codex` binary as the registry resolved it. */
  bin: string;
  /** `CODEX_HOME` for the child: the daemon user's own Codex home. */
  codexHome: string;
  /** `HOME` for the child (and its cwd): the daemon user's home. */
  home: string;
  logger?: { warn(message: string): void };
}

export type CodexConfigClientFactory = (options: CodexConfigClientOptions) => CodexConfigClient;

export interface CodexAppServerClientOptions extends CodexConfigClientOptions {
  /** Arguments to `bin`; `["app-server"]` unless a test runs a fake. */
  args?: readonly string[];
  idleMs?: number;
  callTimeoutMs?: number;
  killGraceMs?: number;
  /** Added to the child's env (a test's fake reads its knobs from it). */
  extraEnv?: Readonly<Record<string, string>>;
}

interface Running {
  child: ProviderChild;
  peer: CodexPeer;
  ready: Promise<void>;
  stderr: string[];
}

export class CodexAppServerClient implements CodexConfigClient {
  private running: Running | null = null;
  /** Kills in flight (idle close, a missed deadline, `close`), until each child is gone. */
  private readonly stopping = new Set<Promise<unknown>>();
  private pending = 0;
  private idleHandle: ReturnType<typeof setTimeout> | null = null;
  private readonly idleMs: number;
  private readonly callTimeoutMs: number;

  constructor(private readonly options: CodexAppServerClientOptions) {
    this.idleMs = options.idleMs ?? CODEX_CONFIG_IDLE_MS;
    this.callTimeoutMs = options.callTimeoutMs ?? CODEX_CONFIG_CALL_TIMEOUT_MS;
  }

  /** Whether an app-server child is running now. */
  get isRunning(): boolean {
    return this.running !== null;
  }

  /** The running child's pid (tests). */
  get pid(): number | undefined {
    return this.running?.child.pid;
  }

  async call<M extends CodexConfigMethod>(
    method: M,
    params: CodexConfigMethods[M]["params"],
    options: { timeoutMs?: number } = {}
  ): Promise<CodexConfigMethods[M]["result"]> {
    this.cancelIdle();
    this.pending += 1;
    const timeoutMs = options.timeoutMs ?? this.callTimeoutMs;
    let running: Running | null = null;
    try {
      running = this.ensureRunning();
      const current = running;
      const work = async (): Promise<unknown> => {
        await current.ready;
        return (current.peer.request as (m: string, p: unknown) => Promise<unknown>)(method, params);
      };
      return (await withDeadline(work, {
        label: `codex app-server ${method}`,
        timeoutMs,
        onTimeout: () => {
          this.stop(current, `${method} timed out`);
        }
      })) as CodexConfigMethods[M]["result"];
    } catch (error) {
      throw this.describeFailure(method, error, running?.stderr.join("") ?? "");
    } finally {
      this.pending -= 1;
      if (this.pending === 0 && this.running !== null) {
        this.armIdle();
      }
    }
  }

  async close(): Promise<void> {
    this.cancelIdle();
    const running = this.running;
    if (running !== null) {
      this.stop(running, "closed");
    }
    await Promise.all([...this.stopping]);
  }

  private ensureRunning(): Running {
    if (this.running !== null) {
      return this.running;
    }
    const env = buildAgentCliEnv(
      { bin: this.options.bin, extra: { ...this.options.extraEnv, CODEX_HOME: this.options.codexHome } },
      { ...process.env, HOME: this.options.home }
    );
    const child = spawnProviderChild({
      command: this.options.bin,
      args: this.options.args ?? ["app-server"],
      env,
      cwd: this.options.home,
      ...(this.options.killGraceMs !== undefined ? { killGraceMs: this.options.killGraceMs } : {})
    });
    const stderr: string[] = [];
    let stderrBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk.toString("utf8"));
      stderrBytes += chunk.length;
      while (stderrBytes > STDERR_TAIL_BYTES && stderr.length > 1) {
        stderrBytes -= Buffer.byteLength(stderr.shift()!);
      }
    });
    const peer = new CodexPeer({
      stdin: child.stdin,
      stdout: child.stdout,
      handlers: {
        // The config API raises no server→client requests; refuse any that arrive.
        onRequest: (request) => Promise.reject(CodexRequestRefusal.methodNotFound(request.method)),
        onNotification: () => undefined,
        onUnknownFrame: () => undefined,
        onMalformedLine: () => undefined
      }
    });
    const running: Running = { child, peer, stderr, ready: Promise.resolve() };
    running.ready = (async () => {
      await peer.request("initialize", {
        clientInfo: { name: "orquester", title: "Orquester", version: "1" },
        capabilities: { experimentalApi: false, requestAttestation: false }
      });
      // `initialized` takes no params; the server rejects an explicit null.
      peer.notify("initialized");
    })();
    // A handshake nobody awaits yet must not become an unhandled rejection.
    running.ready.catch(() => undefined);
    void child.exited.then((reason) => {
      const detail =
        reason.kind === "spawn-error"
          ? reason.error.message
          : reason.kind === "signal"
            ? `killed by ${reason.signal}`
            : `exited with code ${reason.code}`;
      peer.close(detail);
      if (this.running === running) {
        this.running = null;
        this.cancelIdle();
      }
    });
    this.running = running;
    return running;
  }

  private stop(running: Running, reason: string): void {
    running.peer.close(reason);
    if (this.running === running) {
      this.running = null;
    }
    const gone = running.child.kill().catch(() => undefined);
    this.stopping.add(gone);
    void gone.then(() => {
      this.stopping.delete(gone);
    });
  }

  private armIdle(): void {
    this.cancelIdle();
    this.idleHandle = setTimeout(() => {
      this.idleHandle = null;
      const running = this.running;
      if (running !== null && this.pending === 0) {
        this.stop(running, "idle");
      }
    }, this.idleMs);
  }

  private cancelIdle(): void {
    if (this.idleHandle !== null) {
      clearTimeout(this.idleHandle);
      this.idleHandle = null;
    }
  }

  /** A server answer passes through; anything else becomes a redacted `AGENT_CLI_FAILED`. */
  private describeFailure(method: string, error: unknown, stderr: string): unknown {
    if (error instanceof CodexRpcError || error instanceof AgentProfileError) {
      return error;
    }
    const tail = stderr.trim().split("\n").slice(-5).join("\n");
    const base =
      error instanceof DeadlineExceededError
        ? `timed out after ${Math.round(error.timeoutMs / 100) / 10} s`
        : error instanceof Error
          ? error.message
          : String(error);
    const detail = redactCliOutput(tail.length > 0 ? `${base}: ${tail}` : base, {
      homeDirs: [this.options.home]
    });
    return profileErrors.cliFailed(`codex app-server ${method}`, detail.trim().slice(0, 2000));
  }
}

/** The factory the adapter uses by default. */
export const createCodexAppServerClient: CodexConfigClientFactory = (options) => new CodexAppServerClient(options);

/**
 * Maps an error the app-server answered to the profile's error vocabulary:
 * `configVersionConflict` → 409 `PROFILE_CONFLICT`, `configValidationError` →
 * 400 `INVALID_ITEM` (Codex validates the whole config before writing), any
 * other answer → 502 `AGENT_CLI_FAILED`. The message is redacted (`literals`:
 * secret values the caller just sent).
 */
export function toProfileError(
  method: string,
  error: unknown,
  redact: { homeDirs?: string[]; literals?: string[] } = {}
): unknown {
  if (!(error instanceof CodexRpcError)) {
    return error;
  }
  const code = configWriteErrorCode(error);
  const message = redactCliOutput(error.providerMessage, redact).trim();
  if (code === "configVersionConflict") {
    return profileErrors.conflict();
  }
  if (code === "configValidationError") {
    return profileErrors.invalidItem(`Codex refused the change: ${message}`);
  }
  return profileErrors.cliFailed(`codex app-server ${method}`, message.slice(0, 2000));
}

/** `error.data.config_write_error_code` of a `config/*` write refusal, when there is one. */
export function configWriteErrorCode(error: CodexRpcError): string | null {
  const data = error.data;
  if (typeof data === "object" && data !== null) {
    const code = (data as Record<string, unknown>).config_write_error_code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

/** A config key path segment: bare when it can be, else a TOML basic string. */
export function keySegment(segment: string): string {
  return /^[A-Za-z0-9_-]+$/.test(segment)
    ? segment
    : `"${segment.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** `keyPath("mcp_servers", "jira")` → `mcp_servers.jira`; `keyPath("plugins", "a@b", "enabled")` → `plugins."a@b".enabled`. */
export function keyPath(...segments: string[]): string {
  return segments.map(keySegment).join(".");
}
