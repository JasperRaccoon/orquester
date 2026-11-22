/**
 * Tailscale on the daemon host, daemon-level (spec 2026-11-22 §4.7): independent of the boxes
 * plugin, it owns
 *
 * - the daemon's tailnet HTTPS address (`https://<host>.ts.net:<port>`, Settings → Server): set up
 *   through the same `LocalTailscale` serve path as the boxes' "Set up for me", removed on request
 *   (Orquester's own route only), and checked every {@link TAILNET_CHECK_INTERVAL_MS}: recreated
 *   when missing or left pointing at a dead port Orquester recorded, never taken from another app;
 * - the one-time operator grant (`tailscale set --operator=<daemon user>`), after which serve
 *   changes need no sudo;
 * - shared dev-server previews (`https://<host>.ts.net:<port>` → `http://127.0.0.1:<port>`), removed
 *   when their chat closes or their port stops listening.
 *
 * Every decision is `decide.ts`'s (pure); this module gathers the facts (one `tailscale` read, TCP
 * probes), runs the answer, records what it created in `tailnet.json` (its proof of ownership) and
 * publishes `TAILNET_CHANGED_EVENT` when the state changes. Every operation runs one at a time.
 */

import { readFile } from "node:fs/promises";
import { connect } from "node:net";

import type {
  MachineProblem,
  TailnetChangedPayload,
  TailnetErrorCode,
  TailnetHttpsStatus,
  TailnetPreviewShare,
  TailnetServeState
} from "@orquester/api";
import { createDefaultTailnetFile, parseTailnetFile, serializeTailnetFile, type StoredTailnetPreview, type TailnetFile } from "@orquester/config";

import {
  DEFAULT_TAILSCALE_SERVE_PORT,
  SERVE_PORT_CANDIDATES,
  parseProxyTarget,
  sameProxyTarget,
  serveTarget,
  tailnetUrl,
  type ChangeResult,
  type DaemonHttpAddress,
  type LocalTailscale,
  type ProxyTarget,
  type TailscaleSnapshot
} from "../boxes/tailscale/local.ts";
import { chooseHttpsPort, decideHttps, decidePreview, ownHttpsRoutes, type HttpsDecision, type HttpsRecord } from "./decide.ts";

/** How often the serve route and the previews are checked (spec §4.7.3). */
export const TAILNET_CHECK_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 1_000;
/** Dev-server ports a preview may share (below are system services; the tailnet port is the same number). */
const MIN_PREVIEW_PORT = 1024;
const ADMIN_DNS_URL = "https://login.tailscale.com/admin/dns";

export class TailnetError extends Error {
  constructor(
    readonly status: number,
    readonly code: TailnetErrorCode | "PERMISSION_DENIED",
    message: string,
    readonly problem?: MachineProblem,
    /** TAILNET_CONFIRM_REQUIRED: what reaches the daemon through the address. */
    readonly users?: readonly string[]
  ) {
    super(message);
  }
}

/** Whether something accepts a TCP connection at the target. */
export type TcpProbe = (target: Pick<ProxyTarget, "host" | "port">) => Promise<boolean>;

export const tcpProbe: TcpProbe = (target) =>
  new Promise((resolve) => {
    const socket = connect({ host: target.host, port: target.port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });

export interface TailnetServiceDeps {
  local: LocalTailscale;
  /** `tailnet.json` (`tailnetStorePath`). */
  file: string;
  /** Atomic JSON write (the daemon's `writeJsonFile`). */
  writeJson(file: string, value: unknown): Promise<void>;
  /** Where the daemon's HTTP transport listens right now; null while it does not. */
  listening(): DaemonHttpAddress | null;
  /** Default {@link tcpProbe}. */
  probe?: TcpProbe;
  /**
   * The host port that reaches `port` of a box project's box (the dev-server forward, made on first
   * use); null for a host project. Absent: every project is on the host.
   */
  hostPortFor?(projectPath: string, port: number): Promise<number | null>;
  publish(payload: TailnetChangedPayload): void;
  /**
   * What reaches the daemon through one of these `https://…ts.net[:port]` addresses (boxes in
   * Tailscale mode, paired machines), in plain words; empty when nothing does. Turning the address
   * off then needs an explicit confirm. Absent: nothing does.
   */
  addressUsers?(addresses: readonly string[]): readonly string[];
  now?(): number;
  logger?: { warn(message: string): void };
}

export interface SharePreviewInput {
  /** The port the caller's dev server listens on (in its box, for a box project). */
  port: number;
  threadId: string | null;
  /** The caller's project, to map a box project's port to its host forward. */
  projectPath?: string;
}

export interface TailnetService {
  /** Load `tailnet.json`, run the first check, then check every {@link TAILNET_CHECK_INTERVAL_MS}. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** A fresh read, without changing anything. */
  httpsStatus(): Promise<TailnetHttpsStatus>;
  /** Serve the daemon on the tailnet (or adopt the route already serving it). Throws {@link TailnetError}. */
  enableHttps(): Promise<TailnetHttpsStatus>;
  /**
   * Remove Orquester's own route(s) to the daemon and stop repairing. Throws {@link TailnetError}:
   * TAILNET_CONFIRM_REQUIRED while something reaches the daemon through the address and `confirm`
   * is not set.
   */
  disableHttps(options?: { confirm?: boolean }): Promise<TailnetHttpsStatus>;
  /** `tailscale set --operator=<daemon user>` through `sudo -n`. Throws {@link TailnetError}. */
  setOperator(): Promise<TailnetHttpsStatus>;
  /** Shared previews, all or one chat's. */
  previews(threadId?: string): TailnetPreviewShare[];
  sharePreview(input: SharePreviewInput): Promise<TailnetPreviewShare>;
  /** Stop sharing `port` (the host port, or for a chat its box port too); `threadId`: only that chat's. Returns what is left (that chat's). */
  stopPreview(port: number, options?: { threadId?: string }): Promise<TailnetPreviewShare[]>;
  /** A closed chat's previews stop being shared. */
  chatClosed(threadId: string): void;
  /** One check now (the timer's), resolving when it is done. */
  check(): Promise<void>;
  /** Whether previews can be shared now: Tailscale runs with a MagicDNS name and HTTPS certificates. */
  toolsAvailable(): boolean;
  onToolsChange(listener: () => void): () => void;
}

// ---- problems: each names the fix ----------------------------------------------------------------

function readinessProblem(snap: TailscaleSnapshot): MachineProblem | null {
  if (!snap.installed) {
    return { code: "tailscale-unavailable", message: "Tailscale isn't installed on this server.", fix: "Install Tailscale on this server, then run `sudo tailscale up`." };
  }
  if (!snap.running) {
    return { code: "tailscale-unavailable", message: "Tailscale isn't running or signed in on this server.", fix: "Run `sudo tailscale up` on this server." };
  }
  if (!snap.dnsName) {
    return {
      code: "tailscale-https-disabled",
      message: "This server has no MagicDNS name, so it has no https://….ts.net address.",
      fix: `Turn on MagicDNS and HTTPS Certificates on the DNS page of the Tailscale admin console (${ADMIN_DNS_URL}).`
    };
  }
  if (!snap.serveKnown) {
    return { code: "tailscale-unavailable", message: "Tailscale didn't answer `tailscale serve status` on this server.", fix: "Check that tailscaled is running (`tailscale status`), then try again." };
  }
  return null;
}

function certsProblem(): MachineProblem {
  return {
    code: "tailscale-https-disabled",
    message: "HTTPS certificates are off for this tailnet, so Tailscale can't serve https://….ts.net addresses.",
    fix: `Turn on HTTPS Certificates on the DNS page of the Tailscale admin console (${ADMIN_DNS_URL}).`
  };
}

function httpOffProblem(): MachineProblem {
  return {
    code: "tailscale-serve-failed",
    message: "Orquester's HTTP transport is off, so there is nothing for Tailscale to serve.",
    fix: "Turn on External HTTP access under Remote access above (host 127.0.0.1 is enough), then set up the tailnet address."
  };
}

function takenProblem(dnsName: string | null, port: number, by: string | null, next: number | null): MachineProblem {
  const where = dnsName ? `${dnsName}:${port}` : `Port ${port}`;
  return {
    code: "serve-port-taken",
    message: `${where} already serves ${by ?? "something else"} — another app's route, so Orquester left it alone.`,
    fix:
      next !== null
        ? `Set it up again to use port ${next}, or remove that route with \`tailscale serve --https=${port} off\` if the app is gone.`
        : `Remove a route you no longer need (\`tailscale serve status\` lists them; \`tailscale serve --https=<port> off\` removes one), then try again.`
  };
}

function changeProblem(result: Exclude<ChangeResult, { ok: true }>, operatorCommand: string): MachineProblem {
  if (result.reason === "permission") {
    return { code: "tailscale-not-operator", message: result.message, fix: `Run \`${operatorCommand}\` once on this server (or "Allow without sudo" in Settings → Server), then try again.` };
  }
  if (/serve is not enabled|https.*(not enabled|disabled)|certificate|cert/i.test(result.message)) {
    const link = /https:\/\/login\.tailscale\.com\/\S+/.exec(result.message)?.[0] ?? ADMIN_DNS_URL;
    return { code: "tailscale-https-disabled", message: result.message, fix: `Turn on HTTPS for this tailnet (${link}), then try again.` };
  }
  return { code: "tailscale-serve-failed", message: result.message, fix: `Try again, or run \`${result.command}\` on this server to see Tailscale's full answer.` };
}

const problemError = (problem: MachineProblem): TailnetError => new TailnetError(409, "TAILNET_PROBLEM", problem.message, problem);
const invalid = (message: string): TailnetError => new TailnetError(400, "TAILNET_INVALID_REQUEST", message);

// ---- the service ---------------------------------------------------------------------------------

export function createTailnetService(deps: TailnetServiceDeps): TailnetService {
  const { local } = deps;
  const probe = deps.probe ?? tcpProbe;
  const now = deps.now ?? Date.now;
  const warn = (message: string): void => deps.logger?.warn(`[tailnet] ${message}`);

  let file: TailnetFile = createDefaultTailnetFile();
  /** False when `tailnet.json` exists but cannot be read: it is never overwritten then. */
  let writable = true;
  let snap: TailscaleSnapshot | null = null;
  let status: TailnetHttpsStatus = {
    available: false,
    url: null,
    operatorOk: false,
    serveState: "off",
    port: DEFAULT_TAILSCALE_SERVE_PORT,
    checkedAt: null
  };
  /** The last failed change to the daemon's route (cleared by a success). */
  let failure: MachineProblem | null = null;
  /** Consecutive silent checks per preview port. */
  const misses = new Map<number, number>();
  let lastPublished = "";
  let toolsReady = false;
  const toolListeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;
  let chain: Promise<unknown> = Promise.resolve();

  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  };

  // ---- persistence ----

  const load = async (): Promise<void> => {
    let text: string;
    try {
      text = await readFile(deps.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        writable = false;
        warn(`could not read ${deps.file}; tailnet routes are not recorded until it is readable`);
      }
      return;
    }
    try {
      file = parseTailnetFile(JSON.parse(text));
    } catch (error) {
      writable = false;
      warn(`${deps.file} is not readable by this version (${error instanceof Error ? error.message : String(error)}); it is left as it is`);
    }
  };

  const save = async (): Promise<void> => {
    if (!writable) return;
    try {
      await deps.writeJson(deps.file, serializeTailnetFile(file));
    } catch (error) {
      warn(`could not write ${deps.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // ---- facts ----

  const liveTarget = (): ProxyTarget | null => {
    const address = deps.listening();
    return address ? parseProxyTarget(serveTarget(address)) : null;
  };

  const httpsRecord = (): HttpsRecord | null =>
    file.https ? { enabled: file.https.enabled, port: file.https.port, target: file.https.target ? parseProxyTarget(file.https.target) : null } : null;

  const setHttpsRecord = async (enabled: boolean, port: number, target: string | null): Promise<void> => {
    file.https = { ...(file.https ?? {}), enabled, port, target, updatedAt: new Date(now()).toISOString() };
    await save();
  };

  const previewPorts = (): Set<number> => new Set(Object.values(file.previews).map((preview) => preview.port));

  /** Whether the recorded target still answers, when that decides anything (see `HttpsCheckInput`). */
  const recordTargetAlive = async (current: TailscaleSnapshot, record: HttpsRecord | null, live: ProxyTarget | null): Promise<boolean | null> => {
    if (!record?.target) return null;
    if (live && sameProxyTarget(record.target, live)) return null;
    const route = current.routes.find((candidate) => candidate.port === record.port);
    if (!route?.target || !sameProxyTarget(route.target, record.target)) return null;
    return probe(record.target);
  };

  const read = async (): Promise<{ current: TailscaleSnapshot; decision: HttpsDecision; live: ProxyTarget | null; alive: boolean | null }> => {
    const current = await local.snapshot({ fresh: true });
    snap = current;
    const live = liveTarget();
    const record = httpsRecord();
    const alive = await recordTargetAlive(current, record, live);
    return { current, live, alive, decision: decideHttps({ serveKnown: current.serveKnown, live, record, routes: current.routes, recordTargetAlive: alive }) };
  };

  // ---- state ----

  const share = (preview: StoredTailnetPreview): TailnetPreviewShare => ({
    port: preview.port,
    url: preview.url ?? (snap?.dnsName ? tailnetUrl(snap.dnsName, preview.port) : `https://localhost:${preview.port}`),
    threadId: preview.threadId,
    createdAt: preview.createdAt
  });

  const allPreviews = (): TailnetPreviewShare[] => Object.values(file.previews).sort((a, b) => a.port - b.port).map(share);

  const nextFreePort = (current: TailscaleSnapshot, alive: boolean | null, record: HttpsRecord | null): number | null =>
    chooseHttpsPort({ record, routes: current.routes, usedPorts: current.usedPorts, candidates: SERVE_PORT_CANDIDATES, previewPorts: previewPorts(), recordTargetAlive: alive });

  const evaluate = (current: TailscaleSnapshot, decision: HttpsDecision, alive: boolean | null, repairing: boolean): TailnetHttpsStatus => {
    const record = httpsRecord();
    const wanted = record?.enabled === true;
    const ready = readinessProblem(current);
    let serveState: TailnetServeState;
    let port = record?.port ?? nextFreePort(current, alive, null) ?? DEFAULT_TAILSCALE_SERVE_PORT;
    let problem: MachineProblem | undefined;
    switch (decision.kind) {
      case "serving":
        serveState = "serving";
        port = decision.port;
        break;
      case "create":
        port = decision.port;
        serveState = repairing || !failure ? "repairing" : "failed";
        break;
      case "taken":
        port = decision.port;
        serveState = "taken";
        problem = takenProblem(current.dnsName, decision.port, decision.by, nextFreePort(current, alive, null));
        break;
      case "http-off":
        serveState = "failed";
        problem = httpOffProblem();
        break;
      case "unknown":
        serveState = wanted ? "failed" : "off";
        break;
      case "off":
        serveState = "off";
        break;
    }
    if (ready) problem = ready;
    else if (!problem && failure && serveState !== "serving") problem = failure;
    else if (!problem && !current.httpsCerts && serveState !== "serving") problem = certsProblem();
    if (ready && wanted) serveState = "failed";
    return {
      available: current.installed && current.running && current.dnsName !== null,
      url: serveState === "serving" && current.dnsName ? tailnetUrl(current.dnsName, port) : null,
      operatorOk: current.operatorOk === true,
      serveState,
      port,
      checkedAt: new Date(now()).toISOString(),
      ...(problem ? { problem } : {})
    };
  };

  const publish = (): void => {
    const payload: TailnetChangedPayload = { https: status, previews: allPreviews() };
    const { checkedAt: _checkedAt, ...rest } = payload.https;
    const key = JSON.stringify({ ...payload, https: rest });
    if (key !== lastPublished) {
      lastPublished = key;
      deps.publish(payload);
    }
    const ready = snap !== null && readinessProblem(snap) === null && snap.httpsCerts;
    if (ready !== toolsReady) {
      toolsReady = ready;
      for (const listener of toolListeners) listener();
    }
  };

  const setStatus = (next: TailnetHttpsStatus): TailnetHttpsStatus => {
    status = next;
    publish();
    return status;
  };

  // ---- the check ----

  const checkPreviews = async (current: TailscaleSnapshot): Promise<boolean> => {
    if (!current.serveKnown) return false;
    let changed = false;
    for (const preview of Object.values(file.previews)) {
      const target = parseProxyTarget(preview.target);
      const decision = target
        ? decidePreview({ port: preview.port, target, routes: current.routes, listening: await probe(target), misses: misses.get(preview.port) ?? 0 })
        : ({ kind: "forget" } as const);
      if (decision.kind === "keep") misses.delete(preview.port);
      else if (decision.kind === "miss") misses.set(preview.port, decision.misses);
      else {
        if (decision.kind === "remove") {
          const result = await local.unserve(preview.port);
          if (!result.ok) {
            warn(`could not stop sharing port ${preview.port}: ${result.message}`);
            continue;
          }
        }
        delete file.previews[String(preview.port)];
        misses.delete(preview.port);
        changed = true;
      }
    }
    if (changed) await save();
    return changed;
  };

  const runCheck = async (): Promise<void> => {
    let { current, decision, live, alive } = await read();
    if (decision.kind === "serving" && decision.adopt && live) {
      await setHttpsRecord(true, decision.port, live.url);
      failure = null;
    } else if (decision.kind === "serving") {
      failure = null;
    } else if (decision.kind === "create" && live && readinessProblem(current) === null) {
      // A repair that keeps failing stays `failed` (no repairing/failed flip every check).
      if (!failure) setStatus(evaluate(current, decision, alive, true));
      const result = await local.serveProxy(decision.port, live.url);
      if (result.ok) {
        failure = null;
        await setHttpsRecord(true, decision.port, live.url);
        ({ current, decision, alive } = await read());
      } else {
        failure = changeProblem(result, local.operatorCommand());
      }
    }
    await checkPreviews(current);
    setStatus(evaluate(current, decision, alive, false));
  };

  const check = (): Promise<void> => serial(runCheck);

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void check()
        .catch((error) => warn(`check failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(schedule);
    }, TAILNET_CHECK_INTERVAL_MS);
    (timer as { unref?: () => void }).unref?.();
  };

  // ---- HTTPS ----

  const enableHttps = (): Promise<TailnetHttpsStatus> =>
    serial(async () => {
      const { current, decision, live, alive } = await read();
      const ready = readinessProblem(current);
      if (ready) throw problemError(ready);
      if (!live) throw problemError(httpOffProblem());
      if (decision.kind === "serving") {
        await setHttpsRecord(true, decision.port, live.url);
        failure = null;
        return setStatus(evaluate(current, decision, alive, false));
      }
      if (!current.httpsCerts) throw problemError(certsProblem());
      const port = nextFreePort(current, alive, httpsRecord());
      if (port === null) {
        const problem = takenProblem(current.dnsName, SERVE_PORT_CANDIDATES[0]!, null, null);
        throw problemError({ ...problem, message: `Every port Orquester tries (${SERVE_PORT_CANDIDATES.join(", ")}) already serves another app.` });
      }
      const result = await local.serveProxy(port, live.url);
      if (!result.ok) {
        failure = changeProblem(result, local.operatorCommand());
        setStatus(evaluate(current, decision, alive, false));
        throw problemError(failure);
      }
      failure = null;
      await setHttpsRecord(true, port, live.url);
      const after = await read();
      return setStatus(evaluate(after.current, after.decision, after.alive, false));
    });

  const disableHttps = (options: { confirm?: boolean } = {}): Promise<TailnetHttpsStatus> =>
    serial(async () => {
      const { current, live } = await read();
      const record = httpsRecord();
      if (current.running && !current.serveKnown) throw problemError(readinessProblem(current)!);
      const ports = ownHttpsRoutes({ live, record, routes: current.routes });
      const users = current.dnsName && ports.length > 0 ? (deps.addressUsers?.(ports.map((port) => tailnetUrl(current.dnsName!, port))) ?? []) : [];
      if (users.length > 0 && options.confirm !== true) {
        throw new TailnetError(
          409,
          "TAILNET_CONFIRM_REQUIRED",
          `${users.join(" and ")} reach Orquester through this address and will disconnect if it is turned off.`,
          undefined,
          users
        );
      }
      for (const port of ports) {
        const result = await local.unserve(port);
        if (!result.ok) throw problemError(changeProblem(result, local.operatorCommand()));
      }
      failure = null;
      await setHttpsRecord(false, record?.port ?? DEFAULT_TAILSCALE_SERVE_PORT, record?.target?.url ?? live?.url ?? null);
      const after = await read();
      return setStatus(evaluate(after.current, after.decision, after.alive, false));
    });

  const setOperator = (): Promise<TailnetHttpsStatus> =>
    serial(async () => {
      const result = await local.setOperator();
      if (!result.ok) {
        throw problemError(
          result.reason === "permission"
            ? { code: "tailscale-not-operator", message: result.message, fix: `Run \`${result.command}\` once on this server.` }
            : { code: "tailscale-not-operator", message: `Tailscale refused the operator change: ${result.message}`, fix: `Run \`${result.command}\` once on this server.` }
        );
      }
      if (failure?.code === "tailscale-not-operator") failure = null;
      // A repair that failed for want of permission can run now.
      await runCheck();
      return status;
    });

  const httpsStatus = (): Promise<TailnetHttpsStatus> =>
    serial(async () => {
      const { current, decision, alive } = await read();
      return setStatus(evaluate(current, decision, alive, false));
    });

  // ---- previews ----

  const removePreview = async (preview: StoredTailnetPreview, strict: boolean): Promise<void> => {
    const current = await local.snapshot({ fresh: true });
    snap = current;
    const target = parseProxyTarget(preview.target);
    const route = current.routes.find((candidate) => candidate.port === preview.port);
    // Only Orquester's own route goes; one that serves something else now is left as it is.
    if (target && route?.target && sameProxyTarget(route.target, target)) {
      const result = await local.unserve(preview.port);
      if (!result.ok) {
        if (strict) throw problemError(changeProblem(result, local.operatorCommand()));
        warn(`could not stop sharing port ${preview.port}: ${result.message}`);
        return;
      }
    } else if (!current.serveKnown && strict) {
      throw problemError(readinessProblem(current) ?? certsProblem());
    }
    delete file.previews[String(preview.port)];
    misses.delete(preview.port);
    await save();
  };

  const sharePreview = (input: SharePreviewInput): Promise<TailnetPreviewShare> => {
    if (!Number.isInteger(input.port) || input.port < MIN_PREVIEW_PORT || input.port > 65535) {
      return Promise.reject(invalid(`Share a dev-server port between ${MIN_PREVIEW_PORT} and 65535.`));
    }
    return serial(async () => {
      let hostPort = input.port;
      if (input.projectPath && deps.hostPortFor) {
        try {
          hostPort = (await deps.hostPortFor(input.projectPath, input.port)) ?? input.port;
        } catch (error) {
          throw new TailnetError(409, "TAILNET_INVALID_REQUEST", `Port ${input.port} of the project's box can't be reached from this server: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const daemon = deps.listening();
      if (daemon && hostPort === daemon.port) throw invalid(`Port ${hostPort} is Orquester itself: its tailnet address is in Settings → Server.`);
      const existing = file.previews[String(hostPort)];
      if (existing) return share(existing);
      const current = await local.snapshot({ fresh: true });
      snap = current;
      const ready = readinessProblem(current);
      if (ready) throw problemError(ready);
      if (!current.httpsCerts) throw problemError(certsProblem());
      if (current.usedPorts.includes(hostPort)) {
        if (file.https?.enabled && file.https.port === hostPort) throw invalid(`Port ${hostPort} is Orquester's own tailnet address; the dev server needs another port.`);
        const by = current.routes.find((route) => route.port === hostPort)?.target?.url ?? null;
        throw problemError(takenProblem(current.dnsName, hostPort, by, null));
      }
      const candidates = [parseProxyTarget(`http://127.0.0.1:${hostPort}`)!, parseProxyTarget(`http://[::1]:${hostPort}`)!];
      let target: ProxyTarget | null = null;
      for (const candidate of candidates) {
        if (await probe(candidate)) {
          target = candidate;
          break;
        }
      }
      if (!target) {
        throw invalid(
          hostPort === input.port
            ? `Nothing listens on port ${input.port} on this server. Start the dev server first, then share it.`
            : `Nothing answers on port ${input.port} in the project's box. Start the dev server first, then share it.`
        );
      }
      const result = await local.serveProxy(hostPort, target.url);
      if (!result.ok) throw problemError(changeProblem(result, local.operatorCommand()));
      const preview: StoredTailnetPreview = {
        port: hostPort,
        target: target.url,
        threadId: input.threadId,
        ...(hostPort !== input.port ? { projectPort: input.port } : {}),
        url: tailnetUrl(current.dnsName!, hostPort),
        createdAt: new Date(now()).toISOString()
      };
      file.previews[String(hostPort)] = preview;
      await save();
      publish();
      return share(preview);
    });
  };

  const findPreview = (port: number, threadId?: string): StoredTailnetPreview | undefined => {
    const all = Object.values(file.previews).filter((preview) => threadId === undefined || preview.threadId === threadId);
    return all.find((preview) => preview.port === port) ?? (threadId !== undefined ? all.find((preview) => preview.projectPort === port) : undefined);
  };

  const stopPreview = (port: number, options: { threadId?: string } = {}): Promise<TailnetPreviewShare[]> =>
    serial(async () => {
      const preview = findPreview(port, options.threadId);
      if (!preview) throw new TailnetError(404, "TAILNET_PREVIEW_NOT_FOUND", `Port ${port} isn't shared${options.threadId ? " by this chat" : ""}.`);
      await removePreview(preview, true);
      publish();
      return options.threadId !== undefined ? allPreviews().filter((entry) => entry.threadId === options.threadId) : allPreviews();
    });

  const chatClosed = (threadId: string): void => {
    void serial(async () => {
      const mine = Object.values(file.previews).filter((preview) => preview.threadId === threadId);
      if (mine.length === 0) return;
      for (const preview of mine) await removePreview(preview, false);
      publish();
    }).catch((error) => warn(`closing a chat's previews failed: ${error instanceof Error ? error.message : String(error)}`));
  };

  return {
    async start() {
      stopped = false;
      await load();
      await check().catch((error) => warn(`first check failed: ${error instanceof Error ? error.message : String(error)}`));
      schedule();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await chain;
    },
    httpsStatus,
    enableHttps,
    disableHttps,
    setOperator,
    previews: (threadId) => (threadId === undefined ? allPreviews() : allPreviews().filter((preview) => preview.threadId === threadId)),
    sharePreview,
    stopPreview,
    chatClosed,
    check,
    toolsAvailable: () => toolsReady,
    onToolsChange(listener) {
      toolListeners.add(listener);
      return () => toolListeners.delete(listener);
    }
  };
}
