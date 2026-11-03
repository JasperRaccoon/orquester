/**
 * Lending managed agent accounts to a box (lending spec 2026-11-03): the lend records on
 * `StoredBox.accountLends`, resolving and validating what an agent asks for, the all-or-nothing
 * install, one {@link LendKeeper} per active lend, and every way a lend ends.
 *
 * - **Nothing reaches a box but an access token.** The files on a box come from `boxLoginFile`, built
 *   from the broker's grant, which holds no refresh token and no id token. Records hold names and
 *   times only. No log line, response or error names a token.
 * - **Records first.** A lend is persisted before the box is touched; ended, it stays with `endedAt`
 *   until its files were removed, so a restart or an offline box loses no cleanup.
 * - **A real login is never touched.** A bring-your-own machine may be a real install at the same
 *   appdir, even this host. Our files carry `BOX_FILE_MARKER` (`isOwnBoxLogin`); anything else at
 *   those paths is refused with `LEND_APPDIR_IN_USE` in the preview, the install and every rewrite,
 *   and is never removed.
 * - **What a cleanup keeps.** A login file stays only while another active lend of that account is on
 *   the box, or a live Claude chat in the project box reads it. In the second case the ended record
 *   stays too, so the file goes when that session does.
 * - **A lend always ends, on the host:** returned, its time limit, its chat closing, its box destroyed
 *   or released. An end does not revoke anything: a forced refresh is what this feature must not do.
 * - **One writer per box.** Everything written to or removed from one box runs in one queue, and what
 *   a cleanup keeps is decided inside it, so a cleanup and a new lend of the same account cannot
 *   cross. A keeper's write is skipped once its lend ended.
 * - **Tolerant.** Records are rewritten through the box store (unknown fields survive). A lend that
 *   does not parse, of an agent this build does not know, or with an id of the wrong shape is left
 *   alone, unread (`usableLends`).
 * - **The plugin switch** stops new lends (`BOXES_DISABLED`). Existing ones can still be ended and
 *   still reach their time limit; with the plugin off their boxes are away, so nothing is asked.
 */

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import {
  BOX_LEND_AGENTS,
  BOX_LEND_DEFAULT_MINUTES,
  BOX_LEND_MAX_ACCOUNTS,
  BOX_LEND_MAX_MINUTES,
  BOX_LEND_MIN_MINUTES,
  boxPathMapFor,
  hostToBoxPath,
  isBoxLendAgent,
  SYSTEM_ACCOUNT_ID,
  TEMPORARY_BOX_PURPOSE_MAX_CHARS,
  type AccountLendsResponse,
  type BoxLendAgent,
  type LendAccountPlan,
  type LendAccountsPreviewResponse,
  type LendAccountsResponse,
  type SessionSummary
} from "@orquester/api";
import type { CallerPrincipal } from "@orquester/api/agent-chat";
import { agentAccountsFile, createDefaultAgentAccounts, type AgentAccountsIndex, type StoredAccountLend, type StoredBox } from "@orquester/config";

import { BoxTokenTracker } from "../../agent-host/boxes/token-policy.ts";
import { ACCOUNT_ID_PATTERN } from "../../agent-account-paths.ts";
import { AgentTokenError, GONE_STATES } from "../broker/broker.ts";
import { BOX_FILE_MARKER, boxLoginFile, credentialPath, grantFromCredentials, isOwnBoxLogin, NOT_OURS, readOwnBoxFile, type CredentialFiles } from "../broker/credentials.ts";
import type { AgentTokenBroker, BoxConnection, BoxHub, BoxRegistry } from "../contracts.ts";
import { errorLine } from "../service/errors.ts";
import type { BoxRecordStore } from "../service/store.ts";
import { lentAccountsOf, usableLends, type BoxLendRuntime } from "../service/summary.ts";
import { LendKeeper, LendStoppedError, type LendKeeperState } from "./keeper.ts";

/** How long a time limit that could not be recorded waits before it tries again. */
const END_RETRY_MS = 60_000;
/** `setTimeout`'s range; a later time limit (a record from elsewhere) looks again then. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** A chat's session statuses with no CLI running: the next start installs its own login. */
const CHAT_NOT_RUNNING: ReadonlySet<string> = new Set(["idle", "stopped", "error"]);

type LendEndReason = "returned" | "time-limit" | "chat-closed" | "box-released" | "install-failed";

/** A refusal the routes answer verbatim, written for the agent. Never names a token. */
export class AccountLendError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 502 | 503,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AccountLendError";
  }
}

/** Whether an active lend gives `record`'s box the account right now; what the broker's authorization reads. */
export function hasActiveLend(record: StoredBox | undefined, accountId: string, now: number): boolean {
  return activeLends(record).some((lend) => lend.accountId === accountId && Date.parse(lend.expiresAt) > now);
}

function activeLends(record: StoredBox | undefined): StoredAccountLend[] {
  return usableLends(record).filter((lend) => !lend.endedAt);
}

/** A record's raw entries, for rewriting: what cannot be read goes back as it came. */
function rawLends(record: StoredBox): unknown[] {
  return Array.isArray(record.accountLends) ? record.accountLends : [];
}

/** The fields of each raw entry with one of these ids that has not ended. */
function rawActive(record: StoredBox, ids: ReadonlySet<string>): Record<string, unknown>[] {
  return rawLends(record).filter((entry): entry is Record<string, unknown> => isRecord(entry) && ids.has(entry.id as string) && !entry.endedAt);
}

/** An account as lending reads it. */
export interface LendAccountRow {
  id: string;
  agent: string;
  label: string;
  needsReauth: boolean;
}

/** The slice of `AgentAccountsService` lending reads. */
export interface LendAccounts {
  list(): { accounts: LendAccountRow[] };
  homePath(agent: string, id: string): string;
}

/** What lending reads of a session. */
export type LendSession = Pick<SessionSummary, "id" | "kind" | "refId" | "accountId" | "projectPath" | "status" | "chatSessionStatus">;

interface AccountLendsDeps {
  /** The appdir base (the index's path, and the appdir an eval is told). */
  baseDir: string;
  accounts: LendAccounts;
  records: BoxRecordStore;
  registry: Pick<BoxRegistry, "get" | "list" | "locate" | "summary" | "onChange">;
  hub: Pick<BoxHub, "get" | "onConnectionChange">;
  broker: Pick<AgentTokenBroker, "getLentToken">;
  files: Pick<CredentialFiles, "read" | "watch">;
  /** Every session (PTY and chat): a live Claude chat in a project box keeps its account's login file there. */
  sessions(): Iterable<LendSession>;
  /** Fires when a session is created, updated, exits or closes. */
  onSessionsChanged(listener: () => void): () => void;
  /** False when the session index failed to load: an empty list then says nothing about any chat. */
  sessionsLoaded(): boolean;
  chatOpen(threadId: string): boolean;
  /** The plugin switch: new lends only while it is on. */
  enabled(): boolean;
  /** A status changed with no record changing: clients get the box list again. */
  publishChanged(): void;
  now?: () => number;
  logger: Pick<Console, "warn">;
}

/** One active lend in this process. */
interface LendRuntime {
  boxId: string;
  lendId: string;
  keeper: LendKeeper;
  deadline: NodeJS.Timeout | null;
}

interface LendTarget {
  agent: BoxLendAgent;
  accountId: string;
}

function invalid(message: string): AccountLendError {
  return new AccountLendError(400, "BOX_INVALID_REQUEST", message);
}

function notLendable(): AccountLendError {
  return new AccountLendError(409, "ACCOUNT_NOT_LENDABLE", "The System login is never lent; name a managed account.");
}

function needsLogin(label: string): AccountLendError {
  return new AccountLendError(409, "ACCOUNT_NEEDS_LOGIN", `Account ${label} needs its owner to sign in again in Settings → Agent accounts.`);
}

function notConnected(): AccountLendError {
  return new AccountLendError(409, "BOX_NOT_READY", "The VM is not connected.");
}

function stopping(): AccountLendError {
  return new AccountLendError(503, "BOXES_DISABLED", "Lending is not available: the daemon is stopping.");
}

function appdirInUse(path: string): AccountLendError {
  return new AccountLendError(
    409,
    "LEND_APPDIR_IN_USE",
    `${path} on this machine is a real login or account index, not a lent one, so lending here would overwrite it. It may be a real Orquester install at the same appdir; lend to a VM without one.`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function capitalized(agent: BoxLendAgent): string {
  return agent === "claude" ? "Claude" : "Codex";
}

/**
 * The account named `wanted`: a label, the label's part before `@`, or an id prefix, as evals name
 * them (`evals/tool-use/accounts.ts`).
 */
function resolveName(accounts: readonly LendAccountRow[], agent: BoxLendAgent, wanted: string): LendAccountRow {
  const query = wanted.trim().toLowerCase();
  if (query.length === 0) throw invalid("An account name is empty.");
  if (query === SYSTEM_ACCOUNT_ID) throw notLendable();
  const ofAgent = accounts.filter((account) => account.agent === agent);
  const hits = ofAgent.filter(
    (account) => account.id.toLowerCase().startsWith(query) || account.label.toLowerCase() === query || account.label.toLowerCase().split("@")[0] === query
  );
  if (hits.length === 1) return hits[0]!;
  if (hits.length === 0) {
    const known = ofAgent.map((account) => account.label).join(", ") || "none";
    throw new AccountLendError(404, "ACCOUNT_NOT_FOUND", `No managed ${capitalized(agent)} account "${wanted}". Known: ${known}.`);
  }
  const matches = hits.map((account) => `${account.label} (${account.id.slice(0, 8)})`).join(", ");
  throw new AccountLendError(409, "ACCOUNT_AMBIGUOUS", `"${wanted}" names ${hits.length} accounts; use more of the id. Matches: ${matches}.`);
}

export class AccountLends {
  private readonly now: () => number;
  private readonly tracker: BoxTokenTracker;
  private readonly runtimes = new Map<string, LendRuntime>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /** One `lend` at a time per box: a second one finds the first's lends installed, or gone. */
  private readonly lending = new Map<string, Promise<unknown>>();
  /** Boxes with an ended lend whose login a live chat still reads. */
  private readonly keptForChats = new Set<string>();
  private readonly hostWatches = new Map<string, { listeners: Set<() => void>; stop: () => void }>();
  private readonly background = new Set<Promise<unknown>>();
  private readonly unsubscribers: (() => void)[] = [];
  private stopped = false;

  constructor(private readonly deps: AccountLendsDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.tracker = new BoxTokenTracker(this.now);
  }

  // -------------------------------------------------------------------------
  // Lifecycle of the service
  // -------------------------------------------------------------------------

  /** Load every record: end what ran out or lost its chat while the daemon was down, resume the rest. */
  async start(): Promise<void> {
    this.unsubscribers.push(
      this.deps.hub.onConnectionChange((boxId, connected) => this.connectionChanged(boxId, connected)),
      this.deps.registry.onChange((boxId) => this.recordChanged(boxId)),
      this.deps.onSessionsChanged(() => this.sessionsChanged())
    );
    for (const record of this.deps.registry.list()) {
      if (rawLends(record).length === 0) continue;
      if (GONE_STATES.has(record.state)) {
        this.track(this.dropRecords(record.id).catch((error: unknown) => this.warnBox(record.id, "could not drop a destroyed box's lends", error)));
        continue;
      }
      const ending: { id: string; reason: LendEndReason }[] = [];
      for (const lend of activeLends(record)) {
        if (Date.parse(lend.expiresAt) <= this.now()) ending.push({ id: lend.id, reason: "time-limit" });
        else if (this.chatGone(lend.threadId)) ending.push({ id: lend.id, reason: "chat-closed" });
        else if (record.purpose === "machine") ending.push({ id: lend.id, reason: "box-released" });
        else if (!this.runtimes.has(lend.id)) this.open(record.id, lend, "waiting-for-vm").keeper.start();
      }
      for (const reason of new Set(ending.map((entry) => entry.reason))) {
        this.endQuietly(record.id, ending.filter((entry) => entry.reason === reason).map((entry) => entry.id), reason);
      }
      if (ending.length === 0) this.track(this.cleanUp(record.id));
    }
    this.deps.publishChanged();
  }

  /** Daemon stop: keepers and timers stop; the records stay for the next start. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    await Promise.all([...this.runtimes.values()].map((runtime) => this.close(runtime)));
    await this.settled();
    for (const watch of this.hostWatches.values()) watch.stop();
    this.hostWatches.clear();
  }

  /** Every background end, cleanup and keeper pass has finished (a drain, for tests and shutdown). */
  async settled(): Promise<void> {
    for (;;) {
      const pending = [...this.background, ...this.queues.values(), ...[...this.runtimes.values()].map((runtime) => runtime.keeper.idle())];
      await Promise.allSettled(pending);
      // A pass may have queued another while these settled.
      const after = [...this.background, ...this.queues.values(), ...[...this.runtimes.values()].map((runtime) => runtime.keeper.idle())];
      if (after.every((work) => pending.includes(work))) return;
    }
  }

  // -------------------------------------------------------------------------
  // What the routes call
  // -------------------------------------------------------------------------

  /** The caller's active lends: an agent its chat's on every box, a person every lend. */
  list(principal: CallerPrincipal): AccountLendsResponse {
    if (principal.kind === "external") throw this.externalRefusal();
    const lends: AccountLendsResponse["lends"] = [];
    for (const record of this.deps.registry.list()) {
      for (const lent of lentAccountsOf(record, this.runtimeOf)) {
        if (principal.kind === "agent" && lent.threadId !== principal.threadId) continue;
        lends.push({ ...lent, boxId: record.id });
      }
    }
    return { lends };
  }

  /** Resolves and validates for the approval card; changes nothing. */
  async preview(principal: CallerPrincipal, boxId: string, body: unknown): Promise<LendAccountsPreviewResponse> {
    this.requireEnabled();
    const record = this.ownedBox(principal, boxId);
    const connection = this.requireConnection(record);
    if (!isRecord(body)) throw invalid("The request must name accounts.");
    const accounts = this.deps.accounts.list().accounts;
    const seen = new Set<string>();
    const resolved: (LendTarget & { label: string })[] = [];
    let names = 0;
    for (const agent of BOX_LEND_AGENTS) {
      const wanted = body[agent];
      if (wanted === undefined) continue;
      if (!Array.isArray(wanted) || wanted.some((name) => typeof name !== "string")) throw invalid(`${agent} must be a list of account names.`);
      names += wanted.length;
      if (names > BOX_LEND_MAX_ACCOUNTS) throw invalid(`At most ${BOX_LEND_MAX_ACCOUNTS} accounts can be asked for at once.`);
      for (const name of wanted as string[]) {
        const account = resolveName(accounts, agent, name);
        if (seen.has(account.id)) continue;
        seen.add(account.id);
        resolved.push({ accountId: account.id, agent, label: account.label });
      }
    }
    if (resolved.length === 0) throw invalid("Name at least one account.");
    const { minutes, expiresAt } = this.lendWindow(record, body.minutes ?? BOX_LEND_DEFAULT_MINUTES);
    await this.serial(boxId, () => this.assertAppdirFree(connection, resolved));
    const plans: LendAccountPlan[] = [];
    for (const account of resolved) {
      const tokenExpiresAt = await this.checkLendable(account.agent, account.accountId);
      plans.push({
        ...account,
        tokenExpiresAt: tokenExpiresAt === null ? null : new Date(tokenExpiresAt).toISOString(),
        alreadyLent: activeLends(record).some(
          (lend) => lend.accountId === account.accountId && (principal.kind !== "agent" || lend.threadId === principal.threadId)
        )
      });
    }
    return { accounts: plans, minutes, expiresAt: new Date(expiresAt).toISOString(), boxLabel: this.boxLabel(record) };
  }

  /**
   * An APPROVED lend, all or nothing: the records are persisted, the logins and the index written,
   * then the keepers start; any failure ends every lend this call created. An account this chat
   * already has on the box only gets the new end time, once everything else succeeded. One at a time
   * per box, so a second call for an account never answers with the first's unfinished install.
   */
  lend(principal: CallerPrincipal, boxId: string, body: unknown): Promise<LendAccountsResponse> {
    const run = this.chain(this.lending, boxId, () => this.lendNow(principal, boxId, body));
    this.track(run);
    return run;
  }

  private async lendNow(principal: CallerPrincipal, boxId: string, body: unknown): Promise<LendAccountsResponse> {
    this.requireEnabled();
    if (principal.kind !== "agent") {
      throw new AccountLendError(403, "PERMISSION_DENIED", "Only an agent chat asks for a lend, on the owner's approval.");
    }
    const threadId = principal.threadId;
    const record = this.ownedBox(principal, boxId);
    const connection = this.requireConnection(record);
    const request = this.parseLend(body);
    const { expiresAt } = this.lendWindow(record, request.minutes);
    const expiresIso = new Date(expiresAt).toISOString();
    for (const account of request.accounts) await this.checkLendable(account.agent, account.accountId);
    await this.serial(boxId, () => this.assertAppdirFree(connection, request.accounts));
    if (this.stopped) throw stopping();
    const accounts = this.deps.accounts.list().accounts;

    const createdAt = new Date(this.now()).toISOString();
    const created: StoredAccountLend[] = [];
    const extended = new Set<string>();
    const updated = await this.deps.records.update(boxId, (next) => {
      created.length = 0;
      extended.clear();
      const lends = rawLends(next);
      const active = activeLends(next);
      for (const account of request.accounts) {
        const existing = active.find((lend) => lend.accountId === account.accountId && lend.threadId === threadId);
        if (existing) {
          extended.add(existing.id);
          continue;
        }
        const label = accounts.find((candidate) => candidate.id === account.accountId)?.label ?? account.accountId;
        const lend: StoredAccountLend = {
          id: randomUUID(),
          accountId: account.accountId,
          agent: account.agent,
          label,
          threadId,
          purposeNote: request.purposeNote,
          createdAt,
          expiresAt: expiresIso
        };
        created.push(lend);
        lends.push(lend);
      }
      next.accountLends = lends;
    });
    if (!updated) throw new AccountLendError(404, "BOX_NOT_FOUND", "No such box.");

    const installing: { lend: StoredAccountLend; runtime: LendRuntime }[] = [];
    try {
      if (this.stopped) throw stopping();
      // Closed before the records landed: its `closed` event found nothing to end.
      if (this.chatGone(threadId)) throw new AccountLendError(409, "LEND_ENDED", "This chat was closed.");
      for (const lend of created) installing.push({ lend, runtime: this.open(boxId, lend, "installing") });
      await this.serial(boxId, () => this.ensureFolders(connection, created));
      for (const { lend, runtime } of installing) {
        try {
          await runtime.keeper.install();
        } catch (error) {
          throw this.installError(lend, error, connection);
        }
      }
      await this.serial(boxId, () => this.writeIndex(boxId));
      if (this.stopped) throw stopping();
    } catch (error) {
      // Whatever ended them already (a person, the chat closing), this finishes the same.
      await this.end(boxId, created.map((lend) => lend.id), "install-failed").catch((endError: unknown) => {
        this.warnBox(boxId, "could not record the end of a failed lend", endError);
      });
      if (error instanceof AccountLendError) throw error;
      throw new AccountLendError(502, "LEND_INSTALL_FAILED", `The VM refused the login files: ${errorLine(error)}`);
    }
    for (const { runtime } of installing) runtime.keeper.start();
    await Promise.all(installing.map(({ runtime }) => runtime.keeper.idle()));

    if (extended.size > 0) await this.extend(boxId, extended, expiresIso);
    this.deps.publishChanged();
    const current = this.deps.registry.get(boxId);
    const lentIds = new Set([...created.map((lend) => lend.id), ...extended]);
    return {
      boxId,
      appdir: hostToBoxPath(connection.paths, this.deps.baseDir),
      lent: current ? lentAccountsOf(current, this.runtimeOf).filter((lent) => lentIds.has(lent.id)) : []
    };
  }

  /** End one lend: an agent only its own chat's (another's reads as not found), a person any. */
  async endOne(principal: CallerPrincipal, boxId: string, lendId: string): Promise<AccountLendsResponse> {
    const record = this.ownedBox(principal, boxId);
    const lend = usableLends(record).find((candidate) => candidate.id === lendId);
    if (!lend || (principal.kind === "agent" && lend.threadId !== principal.threadId)) {
      throw new AccountLendError(404, "LEND_NOT_FOUND", "This box has no such lend.");
    }
    await this.end(boxId, [lendId], "returned");
    return this.list(principal);
  }

  /** End every lend the caller may end on this box; `threadId` limits a person to one chat's. */
  async endAll(principal: CallerPrincipal, boxId: string, threadId?: string): Promise<AccountLendsResponse> {
    const record = this.ownedBox(principal, boxId);
    const owner = principal.kind === "agent" ? principal.threadId : threadId;
    const ids = activeLends(record).filter((lend) => owner === undefined || lend.threadId === owner).map((lend) => lend.id);
    await this.end(boxId, ids, "returned");
    return this.list(principal);
  }

  /** A chat closed: its lends end. Never throws. */
  chatClosed(threadId: string): void {
    for (const record of this.deps.registry.list()) {
      const ids = activeLends(record).filter((lend) => lend.threadId === threadId).map((lend) => lend.id);
      if (ids.length > 0) this.endQuietly(record.id, ids, "chat-closed");
    }
  }

  /** What `BoxSummary.lentAccounts` shows of a lend beyond its record. */
  readonly runtimeOf = (record: StoredBox, lend: StoredAccountLend): BoxLendRuntime => {
    const state: LendKeeperState = this.runtimes.get(lend.id)?.keeper.current() ?? { status: "waiting-for-vm", statusMessage: null, tokenExpiresAt: null };
    // A box not connected now answers from its record: the OS it reported, else its kind.
    const os = record.os ?? (record.kind.startsWith("windows") ? "win32" : null);
    const paths = this.deps.hub.get(record.id)?.paths ?? (os === "win32" ? boxPathMapFor("win32") : { kind: "identity" as const });
    return {
      status: state.status,
      statusMessage: state.statusMessage,
      tokenExpiresAt: state.tokenExpiresAt === null ? null : new Date(state.tokenExpiresAt).toISOString(),
      home: hostToBoxPath(paths, this.homeOf(lend))
    };
  };

  // -------------------------------------------------------------------------
  // Asking
  // -------------------------------------------------------------------------

  private requireEnabled(): void {
    if (this.stopped) throw stopping();
    if (!this.deps.enabled()) {
      throw new AccountLendError(503, "BOXES_DISABLED", "Lending is not available: the Ephemeral AI VMs plugin is off or still starting.");
    }
  }

  private externalRefusal(): AccountLendError {
    return new AccountLendError(403, "PERMISSION_DENIED", "Lent logins are for agent chats and their owner only.");
  }

  /** The ownership rule: an agent reaches its chat's project box and its own temporary boxes; a person every box. */
  private ownedBox(principal: CallerPrincipal, boxId: string): StoredBox {
    if (principal.kind === "external") throw this.externalRefusal();
    const record = this.deps.registry.get(boxId);
    const notFound = new AccountLendError(404, "BOX_NOT_FOUND", "This chat has no VM with that id.");
    if (!record) throw notFound;
    if (principal.kind === "user") return record;
    if (record.purpose === "temporary" && record.threadId === principal.threadId) return record;
    if (principal.projectPath !== "") {
      const location = this.deps.registry.locate(principal.projectPath);
      if (location.kind === "box" && location.boxId === boxId) return record;
    }
    throw notFound;
  }

  private requireConnection(record: StoredBox): BoxConnection {
    const connection = this.deps.hub.get(record.id);
    if (record.state !== "ready" || !connection?.connected) throw notConnected();
    return connection;
  }

  private parseLend(body: unknown): { accounts: LendTarget[]; minutes: unknown; purposeNote: string } {
    if (!isRecord(body) || !Array.isArray(body.accounts)) throw invalid("The request must list the approved accounts.");
    if (typeof body.purposeNote !== "string" || body.purposeNote.trim().length === 0) throw invalid("purposeNote is required.");
    if (body.purposeNote.length > TEMPORARY_BOX_PURPOSE_MAX_CHARS) throw invalid(`purposeNote is limited to ${TEMPORARY_BOX_PURPOSE_MAX_CHARS} characters.`);
    const accounts = new Map<string, LendTarget>();
    for (const entry of body.accounts as unknown[]) {
      if (!isRecord(entry) || !isBoxLendAgent(entry.agent) || typeof entry.accountId !== "string") {
        throw invalid("Each account needs its agent (claude or codex) and id.");
      }
      if (entry.accountId === SYSTEM_ACCOUNT_ID) throw notLendable();
      if (!ACCOUNT_ID_PATTERN.test(entry.accountId)) throw new AccountLendError(404, "ACCOUNT_NOT_FOUND", `No managed ${capitalized(entry.agent)} account has that id.`);
      accounts.set(entry.accountId, { accountId: entry.accountId, agent: entry.agent });
    }
    if (accounts.size === 0) throw invalid("Name at least one account.");
    if (accounts.size > BOX_LEND_MAX_ACCOUNTS) throw invalid(`At most ${BOX_LEND_MAX_ACCOUNTS} accounts can be lent at once.`);
    return { accounts: [...accounts.values()], minutes: body.minutes, purposeNote: body.purposeNote.trim() };
  }

  /** The asked minutes within the limits and the box's own time limit, and the end time they give. */
  private lendWindow(record: StoredBox, asked: unknown): { minutes: number; expiresAt: number } {
    if (typeof asked !== "number" || !Number.isFinite(asked)) throw invalid("minutes must be a number.");
    let minutes = Math.min(BOX_LEND_MAX_MINUTES, Math.max(BOX_LEND_MIN_MINUTES, Math.round(asked)));
    const now = this.now();
    const deadline = record.deadlineAt ? Date.parse(record.deadlineAt) : Number.NaN;
    if (Number.isFinite(deadline)) {
      const left = Math.floor((deadline - now) / 60_000);
      if (left < 1) throw new AccountLendError(409, "BOX_NOT_READY", "The VM reaches its time limit in under a minute.");
      minutes = Math.min(minutes, left);
    }
    return { minutes, expiresAt: now + minutes * 60_000 };
  }

  /** Throws unless the account can be lent; answers its current token's expiry (epoch ms; null when unknown). */
  private async checkLendable(agent: BoxLendAgent, accountId: string): Promise<number | null> {
    if (accountId === SYSTEM_ACCOUNT_ID) throw notLendable();
    const account = this.deps.accounts.list().accounts.find((candidate) => candidate.id === accountId && candidate.agent === agent);
    if (!account) throw new AccountLendError(404, "ACCOUNT_NOT_FOUND", `No managed ${capitalized(agent)} account has the id ${accountId}.`);
    if (account.needsReauth) throw needsLogin(account.label);
    const text = await this.deps.files.read(this.loginPath(agent, accountId)).catch(() => null);
    const grant = text === null ? null : grantFromCredentials(agent, text);
    if (!grant) throw needsLogin(account.label);
    return grant.expiresAt;
  }

  private boxLabel(record: StoredBox): string {
    const summary = this.deps.registry.summary(record.id);
    if (summary?.project) return summary.project.name;
    return summary ? `${summary.providerLabel} · ${summary.sizeLabel}` : record.name;
  }

  private installError(lend: StoredAccountLend, error: unknown, connection: BoxConnection): AccountLendError {
    if (error instanceof AccountLendError) return error;
    if (error instanceof LendStoppedError) return new AccountLendError(409, "LEND_ENDED", `The lend of ${lend.label} was ended while it was being installed.`);
    if (error instanceof AgentTokenError && error.code === "TOKEN_NEEDS_REAUTH") return needsLogin(lend.label);
    if (error instanceof AgentTokenError) return new AccountLendError(503, error.code, `Could not get a login for ${lend.label}: ${error.message}`);
    if (!connection.connected) return new AccountLendError(409, "BOX_NOT_READY", `The VM disconnected while ${lend.label} was being installed.`);
    return new AccountLendError(502, "LEND_INSTALL_FAILED", `The VM refused the login of ${lend.label}: ${errorLine(error)}`);
  }

  // -------------------------------------------------------------------------
  // Keeping
  // -------------------------------------------------------------------------

  /** Start tracking an active lend in this process: its keeper (not started yet) and its time limit. */
  private open(boxId: string, lend: StoredAccountLend, status: "installing" | "waiting-for-vm"): LendRuntime {
    const agent = lend.agent as BoxLendAgent;
    const hostPath = this.loginPath(agent, lend.accountId);
    const runtime: LendRuntime = {
      boxId,
      lendId: lend.id,
      deadline: null,
      keeper: new LendKeeper(
        {
          lendId: lend.id,
          boxId,
          agent,
          accountId: lend.accountId,
          broker: this.deps.broker,
          readHostLogin: () => this.deps.files.read(hostPath),
          watchHostLogin: (onChange) => this.watchHost(hostPath, onChange),
          tracker: this.tracker,
          connected: () => this.deps.hub.get(boxId)?.connected === true,
          accountNeedsLogin: () => this.deps.accounts.list().accounts.some((account) => account.id === lend.accountId && account.needsReauth),
          checkBoxLogin: () =>
            this.serial(boxId, async () => {
              const connection = this.deps.hub.get(boxId);
              if (!connection?.connected) throw notConnected();
              await this.assertLoginFree(connection, agent, lend.accountId);
            }),
          writeLogin: (grant, wanted) =>
            this.serial(boxId, async () => {
              if (!wanted()) return;
              const connection = this.deps.hub.get(boxId);
              if (!connection?.connected) throw notConnected();
              await this.assertLoginFree(connection, agent, lend.accountId);
              if (!wanted()) return;
              const { filename, content } = boxLoginFile(agent, grant, this.now());
              await connection.writeFile(hostToBoxPath(connection.paths, join(this.deps.accounts.homePath(agent, lend.accountId), filename)), content, { mode: 0o600, mkdirs: true });
            }),
          onStateChange: (state, previous) => this.stateChanged(boxId, state, previous),
          warn: (message) => this.deps.logger.warn(`[boxes] ${message}`)
        },
        status
      )
    };
    this.runtimes.set(lend.id, runtime);
    this.armDeadline(runtime, Date.parse(lend.expiresAt));
    return runtime;
  }

  private stateChanged(boxId: string, state: LendKeeperState, previous: LendKeeperState): void {
    // The index says which logins need a new sign-in, so an eval refuses them with its usual message.
    if ((state.status === "needs-login") !== (previous.status === "needs-login")) {
      this.track(this.serial(boxId, () => this.writeIndex(boxId)).catch((error: unknown) => this.warnBox(boxId, "could not update the lent accounts' index", error)));
    }
    this.deps.publishChanged();
  }

  private armDeadline(runtime: LendRuntime, expiresAt: number): void {
    if (runtime.deadline !== null) clearTimeout(runtime.deadline);
    const delay = Number.isFinite(expiresAt) ? Math.max(0, expiresAt - this.now()) : 0;
    runtime.deadline = setTimeout(() => {
      runtime.deadline = null;
      // Read again: an extension may have landed since this was armed, or be landing now.
      const limit = Date.parse(activeLends(this.deps.registry.get(runtime.boxId)).find((lend) => lend.id === runtime.lendId)?.expiresAt ?? "");
      if (limit > this.now()) {
        this.armDeadline(runtime, limit);
        return;
      }
      this.track(
        this.end(runtime.boxId, [runtime.lendId], "time-limit").catch((error: unknown) => {
          this.warnBox(runtime.boxId, "could not record a lend's time limit", error);
          if (this.runtimes.has(runtime.lendId)) this.armDeadline(runtime, this.now() + END_RETRY_MS);
        })
      );
    }, Math.min(delay, MAX_TIMER_MS));
    runtime.deadline.unref();
  }

  /** One watch per login file on the host, however many boxes borrow that account. */
  private watchHost(path: string, onChange: () => void): () => void {
    let watch = this.hostWatches.get(path);
    if (!watch) {
      const listeners = new Set<() => void>();
      watch = {
        listeners,
        stop: this.deps.files.watch(path, () => {
          for (const listener of [...listeners]) listener();
        })
      };
      this.hostWatches.set(path, watch);
    }
    const shared = watch;
    shared.listeners.add(onChange);
    return () => {
      shared.listeners.delete(onChange);
      if (shared.listeners.size === 0 && this.hostWatches.get(path) === shared) {
        shared.stop();
        this.hostWatches.delete(path);
      }
    };
  }

  private async extend(boxId: string, ids: ReadonlySet<string>, expiresAt: string): Promise<void> {
    await this.deps.records.update(boxId, (next) => {
      for (const lend of rawActive(next, ids)) lend.expiresAt = expiresAt;
    });
    for (const id of ids) {
      const runtime = this.runtimes.get(id);
      if (runtime) this.armDeadline(runtime, Date.parse(expiresAt));
    }
  }

  // -------------------------------------------------------------------------
  // Ending
  // -------------------------------------------------------------------------

  /** Persist the end, stop the keepers (nothing is written after this), then clean up on the box. */
  private async end(boxId: string, ids: readonly string[], reason: LendEndReason): Promise<void> {
    const wanted = new Set(ids);
    if (wanted.size === 0) return;
    const endedAt = new Date(this.now()).toISOString();
    await this.deps.records.update(boxId, (next) => {
      for (const lend of rawActive(next, wanted)) {
        lend.endedAt = endedAt;
        lend.endReason = reason;
      }
    });
    await Promise.all(ids.flatMap((id) => {
      const runtime = this.runtimes.get(id);
      return runtime ? [this.close(runtime)] : [];
    }));
    this.deps.publishChanged();
    await this.cleanUp(boxId);
  }

  /** An end nobody is waiting for: a failure is logged, and a restart ends those lends again. */
  private endQuietly(boxId: string, ids: readonly string[], reason: LendEndReason): void {
    this.track(this.end(boxId, ids, reason).catch((error: unknown) => this.warnBox(boxId, `could not end lends (${reason})`, error)));
  }

  private close(runtime: LendRuntime): Promise<unknown> {
    if (this.runtimes.get(runtime.lendId) === runtime) this.runtimes.delete(runtime.lendId);
    if (runtime.deadline !== null) clearTimeout(runtime.deadline);
    runtime.deadline = null;
    return runtime.keeper.stop();
  }

  /**
   * Remove what ended lends left on the box, while it is connected: a login file unless another
   * active lend of that account is there or a live chat reads it, and never one that is a real login;
   * the index rewritten, or removed with the last lend. A record goes once that worked. One whose
   * login a chat reads stays, and is looked at again when sessions change and on reconnect; one that
   * failed waits for the next reconnect. Never throws.
   */
  private cleanUp(boxId: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.serial(boxId, async () => {
      const record = this.deps.registry.get(boxId);
      const ended = usableLends(record).filter((lend) => lend.endedAt);
      const connection = this.deps.hub.get(boxId);
      if (!record || ended.length === 0 || GONE_STATES.has(record.state) || !connection?.connected) return;
      const active = activeLends(record);
      const cleaned = new Set<string>();
      for (const accountId of new Set(ended.map((lend) => lend.accountId))) {
        const lends = ended.filter((lend) => lend.accountId === accountId);
        const agent = lends[0]!.agent as BoxLendAgent;
        if (!active.some((lend) => lend.accountId === accountId)) {
          if (this.chatReadsLogin(record, agent, accountId)) continue;
          await this.removeLogin(connection, agent, accountId);
        }
        for (const lend of lends) cleaned.add(lend.id);
      }
      await this.writeIndex(boxId).catch((error: unknown) => {
        // A real index appeared: nothing of ours is there to clean up.
        if ((error as { code?: unknown }).code !== "LEND_APPDIR_IN_USE") throw error;
        this.warnBox(boxId, "left a real account index alone", error);
      });
      if (cleaned.size > 0) {
        await this.deps.records.update(boxId, (next) => {
          next.accountLends = rawLends(next).filter((entry) => !(isRecord(entry) && cleaned.has(entry.id as string)));
        });
      }
      if (cleaned.size < ended.length) this.keptForChats.add(boxId);
      else this.keptForChats.delete(boxId);
    }).catch((error: unknown) => this.warnBox(boxId, "could not clean up after a lend; it is tried again when the VM reconnects", error));
  }

  /**
   * Whether a live Claude chat running in this project box reads the account's login file. Codex
   * chats log in with their own token and never read `auth.json`; a temporary box's chat runs on the
   * host; a chat with no CLI running installs its own login when it next starts. A status not known
   * yet (just after a restart) counts as running, and with no session list every chat might be.
   */
  private chatReadsLogin(record: StoredBox, agent: BoxLendAgent, accountId: string): boolean {
    if (agent !== "claude" || record.purpose !== "project") return false;
    if (!this.deps.sessionsLoaded()) return true;
    for (const session of this.deps.sessions()) {
      if (session.kind !== "agent-chat" || session.refId !== "claude" || session.accountId !== accountId || session.status !== "running") continue;
      if (session.chatSessionStatus !== undefined && CHAT_NOT_RUNNING.has(session.chatSessionStatus)) continue;
      const location = this.deps.registry.locate(session.projectPath);
      if (location.kind === "box" && location.boxId === record.id) return true;
    }
    return false;
  }

  /** A kept login's chat may have gone: clean up once one has. Session updates are many, so this reads no box otherwise. */
  private sessionsChanged(): void {
    for (const boxId of this.keptForChats) {
      const record = this.deps.registry.get(boxId);
      const released = record
        ? usableLends(record).some((lend) => lend.endedAt && !this.chatReadsLogin(record, lend.agent as BoxLendAgent, lend.accountId))
        : false;
      if (released) this.track(this.cleanUp(boxId));
      else if (!record) this.keptForChats.delete(boxId);
    }
  }

  /** The box is gone: its lends' records go with it, nothing to clean up. */
  private async dropRecords(boxId: string): Promise<void> {
    await this.deps.records.update(boxId, (next) => {
      delete next.accountLends;
    });
  }

  private recordChanged(boxId: string): void {
    const record = this.deps.registry.get(boxId);
    if (!record || GONE_STATES.has(record.state)) {
      for (const runtime of [...this.runtimes.values()]) {
        if (runtime.boxId === boxId) this.track(this.close(runtime));
      }
      this.keptForChats.delete(boxId);
      if (record && rawLends(record).length > 0) {
        this.track(this.dropRecords(boxId).catch((error: unknown) => this.warnBox(boxId, "could not drop a destroyed box's lends", error)));
      }
      return;
    }
    // A machine given back to its owner stays up: the logins must leave it.
    if (record.purpose === "machine") {
      const ids = activeLends(record).map((lend) => lend.id);
      if (ids.length > 0) this.endQuietly(boxId, ids, "box-released");
    }
  }

  private connectionChanged(boxId: string, connected: boolean): void {
    const keepers = [...this.runtimes.values()].filter((runtime) => runtime.boxId === boxId).map((runtime) => runtime.keeper);
    if (!connected) {
      for (const keeper of keepers) keeper.disconnected();
      return;
    }
    if (usableLends(this.deps.registry.get(boxId)).length === 0) return;
    this.track(
      this.reconnected(boxId)
        .catch((error: unknown) => this.warnBox(boxId, "could not bring the lent logins' folders back", error))
        .then(() => {
          for (const keeper of keepers) keeper.reconnected();
        })
    );
  }

  /** The box is back: the folders (a fresh disk has none), what ended while it was away, the index. */
  private async reconnected(boxId: string): Promise<void> {
    await this.cleanUp(boxId);
    await this.serial(boxId, async () => {
      const record = this.deps.registry.get(boxId);
      const connection = this.deps.hub.get(boxId);
      const active = activeLends(record);
      if (!connection?.connected || active.length === 0) return;
      // Giving a folder to the box's working user is a write too: nothing of a real install's.
      await this.assertIndexFree(connection);
      const free: StoredAccountLend[] = [];
      for (const lend of active) {
        if (await this.loginFree(connection, lend.agent as BoxLendAgent, lend.accountId)) free.push(lend);
      }
      await this.ensureFolders(connection, free);
      await this.writeIndex(boxId);
    });
  }

  // -------------------------------------------------------------------------
  // Files on the box
  // -------------------------------------------------------------------------

  /** The account homes and the index's folder, created for the box's working user: its appdir may not be writable by that user. */
  private ensureFolders(connection: BoxConnection, lends: readonly StoredAccountLend[]): Promise<void> {
    const folders = [...lends.map((lend) => this.homeOf(lend)), dirname(agentAccountsFile(this.deps.baseDir))];
    return connection.request("agent.ensurePaths", { paths: [...new Set(folders)].map((folder) => hostToBoxPath(connection.paths, folder)) });
  }

  /** {@link readOwnBoxFile}, with a lost link said the way the routes say it. */
  private async readBoxFile(connection: BoxConnection, path: string): Promise<string | null | typeof NOT_OURS> {
    return readOwnBoxFile(connection, path).catch(() => {
      throw notConnected();
    });
  }

  private loginBoxPath(connection: BoxConnection, agent: BoxLendAgent, accountId: string): string {
    return hostToBoxPath(connection.paths, this.loginPath(agent, accountId));
  }

  /** Whether the login's path holds nothing, or a login of ours. */
  private async loginFree(connection: BoxConnection, agent: BoxLendAgent, accountId: string): Promise<boolean> {
    const found = await this.readBoxFile(connection, this.loginBoxPath(connection, agent, accountId));
    if (found === null) return true;
    if (found === NOT_OURS) return false;
    const hostLogin = await this.deps.files.read(this.loginPath(agent, accountId)).catch(() => null);
    return isOwnBoxLogin(found, hostLogin);
  }

  /** Throws `LEND_APPDIR_IN_USE` unless the login's path holds nothing, or a login of ours. */
  private async assertLoginFree(connection: BoxConnection, agent: BoxLendAgent, accountId: string): Promise<void> {
    if (!(await this.loginFree(connection, agent, accountId))) throw appdirInUse(this.loginBoxPath(connection, agent, accountId));
  }

  /** Throws `LEND_APPDIR_IN_USE` unless the index's path holds nothing, or an index of ours. */
  private async assertIndexFree(connection: BoxConnection): Promise<void> {
    const path = hostToBoxPath(connection.paths, agentAccountsFile(this.deps.baseDir));
    const found = await this.readBoxFile(connection, path);
    if (found !== null && !this.isOwnIndex(found)) throw appdirInUse(path);
  }

  private isOwnIndex(found: string | typeof NOT_OURS): boolean {
    if (found === NOT_OURS) return false;
    try {
      const parsed: unknown = JSON.parse(found);
      return isRecord(parsed) && parsed.lentBy === BOX_FILE_MARKER.lentBy;
    } catch {
      return false;
    }
  }

  private async assertAppdirFree(connection: BoxConnection, accounts: readonly LendTarget[]): Promise<void> {
    await this.assertIndexFree(connection);
    for (const account of accounts) await this.assertLoginFree(connection, account.agent, account.accountId);
  }

  /** Remove a lent login; a real one stays. Call inside {@link serial}. */
  private async removeLogin(connection: BoxConnection, agent: BoxLendAgent, accountId: string): Promise<void> {
    if (!(await this.loginFree(connection, agent, accountId))) {
      this.deps.logger.warn(`[boxes] Box ${connection.boxId}: account ${accountId} has a real login at its lent login's path; it is left alone`);
      return;
    }
    await connection.request("fs.rm", { path: this.loginBoxPath(connection, agent, accountId), recursive: false, force: true });
  }

  /**
   * The eval's `agent-accounts.json`: only the accounts lent to this box, marked as ours. Removed with
   * the last one, unless what is there is not ours. Call inside {@link serial}.
   */
  private async writeIndex(boxId: string): Promise<void> {
    const connection = this.deps.hub.get(boxId);
    if (!connection?.connected) return;
    const path = hostToBoxPath(connection.paths, agentAccountsFile(this.deps.baseDir));
    const active = activeLends(this.deps.registry.get(boxId));
    if (active.length === 0) {
      const found = await this.readBoxFile(connection, path);
      if (found === null) return;
      if (!this.isOwnIndex(found)) {
        this.warnBox(boxId, "left a real account index alone", path);
        return;
      }
      await connection.request("fs.rm", { path, recursive: false, force: true });
      return;
    }
    await this.assertIndexFree(connection);
    const index: AgentAccountsIndex = createDefaultAgentAccounts();
    const needingLogin = new Set(
      active.filter((lend) => this.runtimes.get(lend.id)?.keeper.current().status === "needs-login").map((lend) => lend.accountId)
    );
    const listed = new Set<string>();
    for (const lend of active) {
      if (listed.has(lend.accountId)) continue;
      listed.add(lend.accountId);
      index.accounts.push({
        id: lend.accountId,
        agent: lend.agent as BoxLendAgent,
        label: lend.label,
        email: null,
        plan: null,
        needsReauth: needingLogin.has(lend.accountId),
        createdAt: lend.createdAt,
        importedAt: lend.createdAt
      });
    }
    await connection.writeFile(path, `${JSON.stringify({ ...index, ...BOX_FILE_MARKER }, null, 2)}\n`, { mode: 0o600, mkdirs: true });
  }

  private homeOf(lend: Pick<StoredAccountLend, "agent" | "accountId">): string {
    return this.deps.accounts.homePath(lend.agent, lend.accountId);
  }

  private loginPath(agent: BoxLendAgent, accountId: string): string {
    return credentialPath(this.deps.accounts.homePath(agent, accountId), agent);
  }

  /** Run `job` after the box's earlier file work; a failure is the caller's, not the queue's. */
  private serial<T>(boxId: string, job: () => Promise<T>): Promise<T> {
    // Nothing reaches a box once the service stopped.
    return this.chain(this.queues, boxId, () => (this.stopped ? Promise.reject(stopping()) : job()));
  }

  private chain<T>(queues: Map<string, Promise<unknown>>, key: string, job: () => Promise<T>): Promise<T> {
    const run = (queues.get(key) ?? Promise.resolve()).then(job);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return run;
  }

  /** The chat is known to be gone: with no session list, nothing is known. */
  private chatGone(threadId: string | null | undefined): boolean {
    if (typeof threadId !== "string") return true;
    return this.deps.sessionsLoaded() && !this.deps.chatOpen(threadId);
  }

  private track<T>(work: Promise<T>): void {
    const tracked: Promise<unknown> = work.catch(() => undefined).finally(() => this.background.delete(tracked));
    this.background.add(tracked);
  }

  /** A box id and an error's first line: box errors name paths, never file contents. */
  private warnBox(boxId: string, what: string, error: unknown): void {
    this.deps.logger.warn(`[boxes] Box ${boxId}: ${what} (${errorLine(error)})`);
  }
}
