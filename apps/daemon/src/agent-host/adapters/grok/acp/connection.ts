/**
 * ACP client — a peer bound to a real child process (spec §3.1, §4.5 Grok).
 *
 * Ported from T3 Code (MIT): `apps/server/src/provider/acp/AcpSessionRuntime.ts`
 * (the spawn/handshake half) and `apps/server/src/provider/acp/AcpStderr.ts`.
 *
 * Everything process-shaped lives here so {@link AcpPeer} stays transport-free
 * and testable: spawning through `support/spawn.ts`, NDJSON line framing,
 * stderr capture/classification/redaction, the bounded handshake, and the
 * "a dead child fails every parked request **before** anything else" rule of
 * §3.1.
 */

import { NdjsonLineReader } from "../../../support/ndjson.ts";
import { spawnProviderChild, describeExit, type ChildExitReason, type ProviderChild } from "../../../support/spawn.ts";
import { StderrCapture, type ClassifiedStderrLine } from "../../../support/stderr.ts";
import { AGENT_HOST_DEADLINES } from "../../../support/deadline.ts";
import { ACP_PROTOCOL_VERSION } from "./_generated/meta.ts";
import type { InitializeResponse } from "./_generated/schema.ts";
import { AcpPeer, type AcpFrameDirection } from "./peer.ts";
import { redactAcpFrame } from "./redact.ts";

/**
 * Grok declares **no client capabilities**: the agent then never calls
 * `fs/*` or `terminal/*` back, which is why those five client methods have no
 * handler anywhere in this adapter. Confirmed by every capture — not one
 * `fs/read_text_file` or `terminal/create` frame exists.
 *
 * *T3: `apps/server/src/provider/acp/AcpSessionRuntime.ts:596-608`.*
 */
export const ACP_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false
} as const;

export interface AcpConnectionOptions {
  /** Absolute path to the resolved binary. Never a bare name (§10). */
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  cwd: string;
  clientInfo: { name: string; version: string };
  /** Home dirs collapsed to `~` in every redacted string. */
  homeDirs?: readonly string[];
  /** One untranslated, ALREADY REDACTED frame, tagged with its direction. */
  onRawFrame?(direction: AcpFrameDirection, frame: unknown): void;
  onStderrLine?(line: ClassifiedStderrLine): void;
  onWarning?(message: string, detail?: unknown): void;
  /**
   * The child is gone. Called exactly once, AFTER every parked request has
   * been failed, so a handler can settle the turn knowing nothing is still
   * waiting (§3.1).
   */
  onExit?(reason: ChildExitReason, stderrTail: string): void;
  /** Overrides {@link AGENT_HOST_DEADLINES}.handshakeMs. */
  handshakeTimeoutMs?: number;
  /** Default per-request deadline. */
  defaultTimeoutMs?: number;
}

export class AcpConnection {
  readonly peer: AcpPeer;
  private readonly child: ProviderChild;
  private readonly stderr: StderrCapture;
  private readonly options: AcpConnectionOptions;
  private hostInitiatedStop = false;
  private exitSeen = false;

  private constructor(options: AcpConnectionOptions, child: ProviderChild, peer: AcpPeer, stderr: StderrCapture) {
    this.options = options;
    this.child = child;
    this.peer = peer;
    this.stderr = stderr;
  }

  /** Spawn the child and wire its pipes. Does NOT perform the handshake. */
  static spawn(options: AcpConnectionOptions): AcpConnection {
    const child = spawnProviderChild({
      command: options.command,
      args: options.args,
      env: options.env,
      cwd: options.cwd
    });

    const stderr = new StderrCapture({ homeDirs: options.homeDirs });
    const peer = new AcpPeer({
      send: (line) => {
        child.stdin.write(`${line}\n`);
      },
      onFrame: (direction, frame) => {
        if (options.onRawFrame === undefined) {
          return;
        }
        options.onRawFrame(direction, redactAcpFrame(frame, { homeDirs: options.homeDirs }));
      },
      onWarning: options.onWarning,
      defaultTimeoutMs: options.defaultTimeoutMs
    });

    const connection = new AcpConnection(options, child, peer, stderr);
    connection.attach();
    return connection;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get hasExited(): boolean {
    return this.child.hasExited();
  }

  /** The redacted 4 KiB rolling stderr tail, for an exit error's excerpt. */
  stderrTail(): string {
    return this.stderr.excerpt();
  }

  /**
   * `initialize`, then **unconditionally** `authenticate` — the agent's own
   * `authMethods` are not consulted for *whether* to call it, because
   * `13-errors-and-rpcs.ndjson` shows `authenticate` accepting an unadvertised
   * id with `{}`, so it can never be used to probe support. Which id is sent
   * DOES come from the handshake: `_meta.defaultAuthMethodId` is the field
   * that actually tracks the login state (`"cached_token"` with a bound
   * account home, `null` without one), so it beats T3's hard-coded
   * `xai.api_key`/`cached_token` choice, which names a method this CLI never
   * advertises.
   *
   * *T3: `AcpSessionRuntime.ts:726-735` (initialize), `:740-748`
   * (unconditional authenticate); `GrokAcpSupport.ts:14-18, 65-69`
   * (`resolveGrokAuthMethodId` — differs, see above).*
   */
  async handshake(input: { authMethodId?: string; skipAuthenticate?: boolean } = {}): Promise<InitializeResponse> {
    const timeoutMs = this.options.handshakeTimeoutMs ?? AGENT_HOST_DEADLINES.handshakeMs;
    const initialize = (await this.peer.request<InitializeResponse>(
      "initialize",
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: ACP_CLIENT_CAPABILITIES,
        clientInfo: this.options.clientInfo
      },
      { timeoutMs }
    )) as InitializeResponse;

    if (input.skipAuthenticate !== true) {
      const methodId = input.authMethodId ?? resolveAuthMethodId(initialize);
      if (methodId !== null) {
        await this.peer.request("authenticate", { methodId }, { timeoutMs: AGENT_HOST_DEADLINES.authProbeMs });
      }
    }
    return initialize;
  }

  /**
   * Stop the child. The exit that follows is `graceful` whatever the code,
   * because the host asked for it — `14-sigterm-mid-prompt.ndjson` shows the
   * CLI installing its own SIGTERM handler and exiting **143 with
   * `signal: null`**, so a supervisor keying on `signal === "SIGTERM"`
   * misclassifies every clean stop.
   */
  async stop(): Promise<void> {
    this.hostInitiatedStop = true;
    await this.child.kill("SIGTERM");
  }

  get wasHostInitiated(): boolean {
    return this.hostInitiatedStop;
  }

  private attach(): void {
    const reader = new NdjsonLineReader();
    this.child.stdout.on("data", (chunk: Buffer) => {
      for (const line of reader.push(chunk)) {
        this.peer.handleLine(line);
      }
    });
    this.child.stdout.on("end", () => {
      for (const line of reader.flush()) {
        this.peer.handleLine(line);
      }
    });
    // An EPIPE on a child that has already gone is not actionable: the exit
    // watcher is what decides the outcome.
    this.child.stdin.on("error", () => {});

    this.child.stderr.on("data", (chunk: Buffer) => {
      for (const line of this.stderr.push(chunk)) {
        if (line.class !== "drop") {
          this.options.onStderrLine?.(line);
        }
      }
    });

    void this.child.exited.then((reason) => {
      if (this.exitSeen) {
        return;
      }
      this.exitSeen = true;
      for (const line of this.stderr.flush()) {
        if (line.class !== "drop") {
          this.options.onStderrLine?.(line);
        }
      }
      // ORDER IS THE CONTRACT (§3.1): every parked request is failed first,
      // so an `onExit` handler settling the turn cannot race a caller still
      // awaiting a reply that can never arrive.
      this.peer.close(`grok: child ${describeExit(reason)}`, this.stderr.excerpt());
      this.options.onExit?.(reason, this.stderr.excerpt());
    });
  }
}

/**
 * `_meta.defaultAuthMethodId` when the agent names one, else the first
 * advertised method, else null (nothing to authenticate with — the handshake
 * still succeeds and the failure surfaces on the first model call).
 */
export function resolveAuthMethodId(initialize: InitializeResponse): string | null {
  const meta = (initialize as { _meta?: Record<string, unknown> })._meta;
  const preferred = meta?.["defaultAuthMethodId"];
  if (typeof preferred === "string" && preferred.length > 0) {
    return preferred;
  }
  const first = initialize.authMethods?.[0]?.id;
  return typeof first === "string" && first.length > 0 ? first : null;
}
