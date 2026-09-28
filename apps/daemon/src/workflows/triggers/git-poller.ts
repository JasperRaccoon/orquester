// Automated workflows — the git trigger poller (spec §6.2).
//
// ONE poller per repo key (`repoKeyOf(url)` + account), shared by every trigger watching that repo.
// A poller runs up to three channels, each only while a trigger needs it:
//
//   refs      `git ls-remote` (push + tag triggers) every 60 s ± 10 %. The default branch (`--symref`
//             reads the WHOLE advertisement) is asked for only when a `branches: []` push trigger
//             needs it: while unknown, then every 10th poll.
//   pulls     REST pull requests every 120 s (Bitbucket Cloud 180 s) ± 10 %, with an ETag.
//   releases  REST releases (GitHub) on the same cadence, with an ETag.
//
// Per trigger a cursor (`gitTriggerCursorSchema`, keyed `<workflowId>:<nodeId>`) carries the repo
// key and event fingerprint it was built for (a change re-baselines), the `seen` state, the fired
// dedup ring, `lastPollAt`, `lastError` and `failures`. A trigger's first successful poll only
// baselines. Every poll commits the cursor (seen + fired keys) BEFORE it fires, so a crash can lose
// a run but never repeat one; a restarted poller over the same state never re-fires.
//
// A failed poll fires nothing: the channel backs off exponentially (to 15 min, or longer when the
// provider said `retryAfterMs`), and every affected cursor shows `lastError` + `failures`.

import type { GitTriggerCursor, GitTriggerEvent, WorkflowStateFile } from "@orquester/config";
import type { Clock, FireRequest, TriggerHost, WorkflowLogger } from "../contracts.ts";
import type { WorkflowStateStore } from "../state-store.ts";
import { isFullSha, parseRemoteUrl, redactUrlUserinfo, repoDisplayName, repoKeyOf, stripUrlCredentials, type LsRemoteResult } from "../git-remote/index.ts";
import type { ConditionalListOptions, ConditionalPage, PullRequestInfo, ReleaseInfo } from "../../providers/types.ts";
import {
  type DetectedEvent,
  type Detection,
  detectPullRequests,
  detectPush,
  detectReleases,
  detectTags,
  eventKeyOf,
  MAX_FIRES_PER_POLL,
  pushFired,
  type RepoInfo,
  sameSha
} from "./git-events.ts";
import type { ResolveRepo, ResolvedRepo } from "./repo-resolve.ts";

const REFS_POLL_MS = 60_000;
const REST_POLL_MS = 120_000;
const BITBUCKET_CLOUD_REST_POLL_MS = 180_000;
const POLL_JITTER = 0.1;
const MAX_BACKOFF_MS = 15 * 60_000;
/** A provider's Retry-After is honoured up to this. */
const MAX_RETRY_AFTER_MS = 60 * 60_000;
/** The default branch is re-read every Nth refs poll. */
const DEFAULT_BRANCH_EVERY = 10;
/** First polls after a (re)arm are spread over this window. */
const INITIAL_SPREAD_MS = 10_000;
/** Definitions are re-resolved this often too (a project's `origin` can change without an edit). */
const RESOLVE_INTERVAL_MS = 5 * 60_000;

export interface GitRemoteReader {
  lsRemote(accountId: string | null, url: string, opts?: { defaultBranch?: boolean }): Promise<LsRemoteResult>;
  listPullRequests(accountId: string | null, url: string, opts?: ConditionalListOptions): Promise<ConditionalPage<PullRequestInfo>>;
  listReleases(accountId: string | null, url: string, opts?: ConditionalListOptions): Promise<ConditionalPage<ReleaseInfo>>;
}

export interface GitPollerDeps {
  host: TriggerHost;
  state: WorkflowStateStore;
  remote: GitRemoteReader;
  resolveRepo: ResolveRepo;
  clock: Clock;
  logger: WorkflowLogger;
}

export interface GitTriggerState {
  repo: RepoInfo | null;
  baselined: boolean;
  lastPollAt: string | null;
  lastError: string | null;
  failures: number;
}

export interface GitPoller {
  start(): Promise<void>;
  /** Cancels every timer; polls in flight finish without committing or firing. */
  stop(): void;
  /** Re-reads the definitions: adds/removes repos, re-baselines changed triggers. */
  rearm(): Promise<void>;
  triggerState(workflowId: string, nodeId: string): GitTriggerState | null;
  /** Resolves once no rearm or poll is in flight (tests). */
  idle(): Promise<void>;
}

type ChannelName = "refs" | "pulls" | "releases";
const CHANNELS: readonly ChannelName[] = ["refs", "pulls", "releases"];

interface TriggerEntry {
  key: string;
  workflowId: string;
  nodeId: string;
  event: GitTriggerEvent;
  eventKey: string;
  pollerKey: string;
  channel: ChannelName;
}

interface ChannelState {
  timer: { cancel(): void } | null;
  running: boolean;
  again: boolean;
  failures: number;
  polls: number;
}

interface RepoPoller {
  key: string;
  url: string;
  accountId: string | null;
  repo: RepoInfo;
  restIntervalMs: number;
  triggers: Map<string, TriggerEntry>;
  channels: Record<ChannelName, ChannelState>;
  defaultBranch?: string;
  removed: boolean;
}

function gitCursorKey(workflowId: string, nodeId: string): string {
  return `${workflowId}:${nodeId}`;
}

function channelOf(event: GitTriggerEvent): ChannelName {
  switch (event.kind) {
    case "push":
    case "tag":
      return "refs";
    case "pull_request":
      return "pulls";
    case "release":
      return "releases";
    default: {
      const unhandled: never = event;
      void unhandled;
      return "refs";
    }
  }
}

function etagKey(channel: "pulls" | "releases", pollerKey: string): string {
  return `git:${channel}:${pollerKey}`;
}

/** A short, credential-free reason for a trigger card: "auth rejected", "missing scope read:pullrequest", … */
function describePollError(error: unknown): string {
  const kind = (error as { kind?: unknown } | null)?.kind;
  const message = error instanceof Error ? error.message : String(error);
  switch (kind) {
    case "auth":
      return "auth rejected";
    case "missing_scope": {
      const scope = /read:[a-z_]+/i.exec(message)?.[0];
      return scope ? `missing scope ${scope}` : "missing scope";
    }
    case "rate_limited":
      return "rate limited";
    case "not_found":
      return "repository not found";
    case "timeout":
      return "timed out";
    default: {
      const flat = redactUrlUserinfo(message).replace(/\s+/g, " ").trim();
      return flat.length > 300 ? `${flat.slice(0, 299)}…` : flat || "poll failed";
    }
  }
}

function freshCursor(pollerKey: string, eventKey: string, previous?: GitTriggerCursor): GitTriggerCursor {
  return {
    repoKey: pollerKey,
    eventKey,
    baselined: false,
    seen: {},
    // Dedup keys outlive a re-baseline: a key already fired is never fired again.
    fired: previous?.fired ?? [],
    lastPollAt: null,
    lastError: null,
    failures: 0
  };
}

export function createGitPoller(deps: GitPollerDeps): GitPoller {
  const { host, state, remote, resolveRepo, clock, logger } = deps;
  const random = Math.random;
  const pollers = new Map<string, RepoPoller>();
  /** Trigger key → why its repository could not be resolved. */
  const unresolved = new Map<string, string>();
  /** Trigger key → the repo it watches (for triggerState). */
  const repoOfTrigger = new Map<string, RepoInfo>();
  /** Read-only view of the state (the store's own object, set in every update made here). */
  let view: WorkflowStateFile = state.get();
  let chain: Promise<void> = Promise.resolve();
  const inflight = new Set<Promise<void>>();
  let resolveTimer: { cancel(): void } | null = null;
  let unsubscribe: (() => void) | null = null;
  let started = false;
  let stopped = false;

  const jitter = (ms: number) => Math.round(ms * (1 + (random() * 2 - 1) * POLL_JITTER));
  const intervalOf = (poller: RepoPoller, channel: ChannelName) =>
    channel === "refs" ? REFS_POLL_MS : poller.restIntervalMs;

  function track(promise: Promise<void>): void {
    inflight.add(promise);
    void promise.finally(() => inflight.delete(promise));
  }

  function update(mutator: (draft: WorkflowStateFile) => void): Promise<void> {
    return state.update((draft) => {
      mutator(draft);
      view = draft;
    });
  }

  // -------------------------------------------------------------------------
  // Definitions → pollers
  // -------------------------------------------------------------------------

  async function reconcile(): Promise<void> {
    const live = host.enabledTriggers("trigger.git").filter(({ node }) => node.disabled !== true);
    const resolved = await Promise.all(
      live.map(async ({ workflow, node }): Promise<ResolvedRepo | null> => {
        try {
          return await resolveRepo(workflow, node.config.repo);
        } catch (error) {
          logger.debug("workflow git trigger: repository resolution failed", {
            workflowId: workflow.id,
            nodeId: node.id,
            error: error instanceof Error ? error.message : String(error)
          });
          return null;
        }
      })
    );
    if (stopped) return;

    const liveKeys = new Set<string>();
    const entries: TriggerEntry[] = [];
    const wanted = new Map<string, { url: string; accountId: string | null; entries: TriggerEntry[] }>();
    unresolved.clear();
    repoOfTrigger.clear();
    live.forEach(({ workflow, node }, index) => {
      const key = gitCursorKey(workflow.id, node.id);
      liveKeys.add(key);
      const target = resolved[index];
      if (!target) {
        unresolved.set(
          key,
          node.config.repo.kind === "project"
            ? "The project has no git remote to watch"
            : "The repository could not be resolved"
        );
        return;
      }
      const url = stripUrlCredentials(target.url.trim());
      const repoKey = repoKeyOf(url);
      if (repoKey === null) {
        unresolved.set(key, "Unsupported repository URL");
        return;
      }
      const pollerKey = `${repoKey}|${target.accountId ?? "anonymous"}`;
      const event = node.config.event;
      const entry: TriggerEntry = {
        key,
        workflowId: workflow.id,
        nodeId: node.id,
        event,
        eventKey: eventKeyOf(event),
        pollerKey,
        channel: channelOf(event)
      };
      entries.push(entry);
      repoOfTrigger.set(key, { url, name: repoDisplayName(url) });
      const group = wanted.get(pollerKey) ?? { url, accountId: target.accountId, entries: [] };
      group.entries.push(entry);
      wanted.set(pollerKey, group);
    });

    // Cursors: fresh for new / re-pointed / re-filtered triggers; pruned for gone ones (an
    // unresolved trigger keeps its cursor — a transient failure must not cost its baseline).
    const current = view.git;
    const needsWrite =
      entries.some((entry) => {
        const cursor = current[entry.key];
        return !cursor || cursor.repoKey !== entry.pollerKey || cursor.eventKey !== entry.eventKey;
      }) ||
      Object.keys(current).some((key) => !liveKeys.has(key)) ||
      Object.keys(view.etags).some((key) => {
        const match = /^git:(pulls|releases):(.*)$/.exec(key);
        return match !== null && !wanted.has(match[2]!);
      });
    if (needsWrite) {
      await update((draft) => {
        for (const entry of entries) {
          const cursor = draft.git[entry.key];
          if (!cursor || cursor.repoKey !== entry.pollerKey || cursor.eventKey !== entry.eventKey) {
            draft.git[entry.key] = freshCursor(entry.pollerKey, entry.eventKey, cursor);
          }
        }
        for (const key of Object.keys(draft.git)) if (!liveKeys.has(key)) delete draft.git[key];
        for (const key of Object.keys(draft.etags)) {
          const match = /^git:(pulls|releases):(.*)$/.exec(key);
          if (match !== null && !wanted.has(match[2]!)) delete draft.etags[key];
        }
      }).catch(() => undefined);
    }
    if (stopped) return;

    for (const [key, poller] of pollers) {
      if (wanted.has(key)) continue;
      poller.removed = true;
      for (const channel of CHANNELS) poller.channels[channel].timer?.cancel();
      pollers.delete(key);
    }
    for (const [key, group] of wanted) {
      let poller = pollers.get(key);
      if (!poller) {
        const remoteHost = parseRemoteUrl(group.url)?.host;
        poller = {
          key,
          url: group.url,
          accountId: group.accountId,
          repo: { url: group.url, name: repoDisplayName(group.url) },
          restIntervalMs: remoteHost === "bitbucket.org" ? BITBUCKET_CLOUD_REST_POLL_MS : REST_POLL_MS,
          triggers: new Map(),
          channels: {
            refs: { timer: null, running: false, again: false, failures: 0, polls: 0 },
            pulls: { timer: null, running: false, again: false, failures: 0, polls: 0 },
            releases: { timer: null, running: false, again: false, failures: 0, polls: 0 }
          },
          removed: false
        };
        pollers.set(key, poller);
      }
      poller.triggers = new Map(group.entries.map((entry) => [entry.key, entry]));
      for (const channel of CHANNELS) {
        const ch = poller.channels[channel];
        const users = [...poller.triggers.values()].filter((entry) => entry.channel === channel);
        if (users.length === 0) {
          ch.timer?.cancel();
          ch.timer = null;
          continue;
        }
        const needsBaseline = users.some((entry) => view.git[entry.key]?.baselined !== true);
        if (ch.running) {
          if (needsBaseline && ch.failures === 0) ch.again = true;
        } else if (ch.timer === null || (needsBaseline && ch.failures === 0)) {
          schedule(poller, channel, Math.round(random() * INITIAL_SPREAD_MS));
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Channels
  // -------------------------------------------------------------------------

  function schedule(poller: RepoPoller, channel: ChannelName, delayMs: number): void {
    const ch = poller.channels[channel];
    ch.timer?.cancel();
    if (stopped || poller.removed) {
      ch.timer = null;
      return;
    }
    ch.timer = clock.setTimeout(() => {
      ch.timer = null;
      track(run(poller, channel));
    }, Math.max(0, delayMs));
  }

  async function run(poller: RepoPoller, channel: ChannelName): Promise<void> {
    const ch = poller.channels[channel];
    if (stopped || poller.removed) return;
    if (ch.running) {
      ch.again = true;
      return;
    }
    ch.running = true;
    ch.again = false;
    let retryAfterMs: number | undefined;
    let ok = false;
    try {
      await poll(poller, channel);
      ok = true;
      ch.failures = 0;
    } catch (error) {
      ch.failures += 1;
      const hinted = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
      retryAfterMs = typeof hinted === "number" && hinted > 0 ? Math.min(hinted, MAX_RETRY_AFTER_MS) : undefined;
      await recordFailure(poller, channel, error);
    } finally {
      ch.running = false;
    }
    if (stopped || poller.removed) return;
    if (![...poller.triggers.values()].some((entry) => entry.channel === channel)) return;
    if (ok) {
      schedule(poller, channel, ch.again ? 0 : jitter(intervalOf(poller, channel)));
    } else {
      const backoff = Math.min(MAX_BACKOFF_MS, intervalOf(poller, channel) * 2 ** ch.failures);
      schedule(poller, channel, Math.max(jitter(backoff), retryAfterMs ?? 0));
    }
  }

  function usersOf(poller: RepoPoller, channel: ChannelName): TriggerEntry[] {
    return [...poller.triggers.values()].filter((entry) => entry.channel === channel);
  }

  async function poll(poller: RepoPoller, channel: ChannelName): Promise<void> {
    const users = usersOf(poller, channel);
    if (users.length === 0) return;
    if (channel === "refs") {
      const ch = poller.channels.refs;
      const wantsDefault = users.some((entry) => entry.event.kind === "push" && entry.event.branches.every((b) => !b.trim()));
      const askDefault = wantsDefault && (poller.defaultBranch === undefined || ch.polls % DEFAULT_BRANCH_EVERY === 0);
      const refs = await remote.lsRemote(poller.accountId, poller.url, { defaultBranch: askDefault });
      ch.polls += 1;
      if (askDefault && refs.defaultBranch) poller.defaultBranch = refs.defaultBranch;
      await commit(poller, users, (entry, cursor) => {
        if (entry.event.kind === "push") return detectPush(entry.event, cursor, refs, poller.defaultBranch, poller.repo);
        if (entry.event.kind === "tag") return detectTags(entry.event, cursor, refs, poller.repo);
        return null;
      });
      return;
    }

    const key = etagKey(channel, poller.key);
    const cached = view.etags[key];
    // A trigger that still needs its baseline needs the page itself, not a 304.
    const baselining = users.some((entry) => view.git[entry.key]?.baselined !== true);
    const opts: ConditionalListOptions = cached && !baselining ? { etag: cached.etag } : {};
    if (channel === "pulls") {
      // The PRs any trigger here last saw open: a provider whose listing can miss one (DC) looks it up.
      const knownOpen = new Set<number>();
      for (const entry of users) {
        for (const [seenKey, value] of Object.entries(view.git[entry.key]?.seen ?? {})) {
          const number = /^pr:(\d+)$/.exec(seenKey)?.[1];
          if (number !== undefined && value.startsWith("open:")) knownOpen.add(Number(number));
        }
      }
      if (knownOpen.size > 0) opts.knownOpen = [...knownOpen].sort((a, b) => b - a);
    }
    const page =
      channel === "pulls"
        ? await remote.listPullRequests(poller.accountId, poller.url, opts)
        : await remote.listReleases(poller.accountId, poller.url, opts);
    if (stopped || poller.removed) return;
    if (page.notModified) {
      // Nothing changed since the page every cursor already judged.
      await commit(poller, users, () => "unchanged");
      return;
    }
    if (page.unsupported) {
      await markError(users, "Releases are only available on GitHub", false);
      return;
    }
    const items = page.items;
    // The ETag rides the SAME update as the cursors that judged this page: written apart, a stop
    // between the two persisted the new ETag beside the old cursors, and every later 304 hid the
    // changes that page held until the listing changed again.
    await commit(
      poller,
      users,
      (entry, cursor) => {
        if (entry.event.kind === "pull_request") return detectPullRequests(entry.event, cursor, items as PullRequestInfo[], poller.repo);
        if (entry.event.kind === "release") return detectReleases(entry.event, cursor, items as ReleaseInfo[], poller.repo);
        return null;
      },
      (draft) => {
        if (page.etag) draft.etags[key] = { etag: page.etag, body: null };
        else delete draft.etags[key];
      }
    );
  }

  /**
   * Applies each trigger's detection to its cursor in ONE state update (synchronous against the
   * live state, so an edit's re-baseline cannot interleave), waits for it to land, then fires.
   * `null` = nothing decidable this poll (only `lastPollAt` moves); "unchanged" = a 304.
   */
  async function commit(
    poller: RepoPoller,
    users: TriggerEntry[],
    detect: (entry: TriggerEntry, cursor: GitTriggerCursor) => Detection | null | "unchanged",
    alsoWrite?: (draft: WorkflowStateFile) => void
  ): Promise<void> {
    if (stopped || poller.removed) return;
    const now = clock.now().toISOString();
    const toFire: { entry: TriggerEntry; event: DetectedEvent }[] = [];
    const toSkip: { entry: TriggerEntry; event: DetectedEvent }[] = [];
    const written = update((draft) => {
      for (const entry of users) {
        const cursor = draft.git[entry.key];
        if (!cursor || cursor.repoKey !== entry.pollerKey || cursor.eventKey !== entry.eventKey) continue;
        const detection = detect(entry, cursor);
        const base = { ...cursor, lastPollAt: now, lastError: null, failures: 0 };
        if (detection === null || detection === "unchanged") {
          draft.git[entry.key] = base;
          continue;
        }
        const fired = new Set(cursor.fired);
        const fresh = detection.events.filter((event) => !fired.has(event.key));
        const newKeys: string[] = [];
        fresh.forEach((event, index) => {
          if (fired.has(event.key)) return;
          fired.add(event.key);
          newKeys.push(event.key);
          (index < MAX_FIRES_PER_POLL ? toFire : toSkip).push({ entry, event });
        });
        draft.git[entry.key] = { ...base, baselined: true, seen: detection.seen, fired: pushFired(cursor.fired, newKeys) };
      }
      alsoWrite?.(draft);
    });
    try {
      await written;
    } catch (error) {
      logger.error("workflow git trigger: could not persist a poll (firing anyway; memory dedups)", {
        repo: poller.repo.name,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    await completeAbbreviatedHeads(poller, toFire.map(({ event }) => event));
    for (const { entry, event } of toFire) {
      if (stopped) return;
      const request = fireRequest(entry, event, event.text);
      try {
        await host.fire(request);
      } catch (error) {
        logger.error("workflow git trigger: could not start a run", {
          trigger: entry.key,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    for (const { entry, event } of toSkip) {
      if (stopped) return;
      try {
        await host.recordSkipped(fireRequest(entry, event, `${event.text} (more than ${MAX_FIRES_PER_POLL} events in one poll)`), "missed");
      } catch (error) {
        logger.error("workflow git trigger: could not record a skipped run", {
          trigger: entry.key,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  /**
   * Bitbucket Cloud lists a PR's head as 12 hex, which a clone cannot fetch by id. Before a PR event
   * fires, its head is completed from the repo's branch heads (one `ls-remote`, only when needed):
   * a same-repo PR's branch still at that commit names it in full. Best effort — a fork's PR, a
   * branch that moved on or a failed read keeps the abbreviation (the clone resolves or refuses
   * it). The dedup key is left as detected.
   */
  async function completeAbbreviatedHeads(poller: RepoPoller, events: DetectedEvent[]): Promise<void> {
    const short = events.filter((event) => event.payload.pr !== undefined && event.payload.sha !== "" && !isFullSha(event.payload.sha));
    if (short.length === 0 || stopped || poller.removed) return;
    let heads: Record<string, string>;
    try {
      heads = (await remote.lsRemote(poller.accountId, poller.url, { defaultBranch: false })).heads;
    } catch (error) {
      logger.debug("workflow git trigger: could not complete an abbreviated PR head", {
        repo: poller.repo.name,
        error: describePollError(error)
      });
      return;
    }
    for (const event of short) {
      const pr = event.payload.pr!;
      const full = heads[pr.head];
      if (full === undefined || !isFullSha(full) || !sameSha(full, event.payload.sha)) continue;
      event.payload = { ...event.payload, sha: full, pr: { ...pr, headSha: full } };
    }
  }

  function fireRequest(entry: TriggerEntry, event: DetectedEvent, text: string): FireRequest {
    return { workflowId: entry.workflowId, triggerNodeId: entry.nodeId, kind: "git", payload: event.payload, text };
  }

  async function markError(users: TriggerEntry[], message: string, countFailure: boolean): Promise<void> {
    await update((draft) => {
      for (const entry of users) {
        const cursor = draft.git[entry.key];
        if (!cursor || cursor.repoKey !== entry.pollerKey || cursor.eventKey !== entry.eventKey) continue;
        draft.git[entry.key] = {
          ...cursor,
          lastError: message,
          failures: countFailure ? cursor.failures + 1 : cursor.failures
        };
      }
    }).catch(() => undefined);
  }

  async function recordFailure(poller: RepoPoller, channel: ChannelName, error: unknown): Promise<void> {
    const message = describePollError(error);
    logger.warn("workflow git trigger: poll failed", { repo: poller.repo.name, channel, error: message });
    if (stopped || poller.removed) return;
    await markError(usersOf(poller, channel), message, true);
  }

  // -------------------------------------------------------------------------

  function armResolveTimer(): void {
    resolveTimer?.cancel();
    resolveTimer = null;
    if (stopped) return;
    resolveTimer = clock.setTimeout(() => {
      resolveTimer = null;
      void rearm();
    }, RESOLVE_INTERVAL_MS);
  }

  function rearm(): Promise<void> {
    const next = chain
      .then(async () => {
        if (stopped || !started) return;
        await reconcile();
        armResolveTimer();
      })
      .catch((error: unknown) => {
        logger.error("workflow git trigger: rearm failed", { error: error instanceof Error ? error.message : String(error) });
      });
    chain = next;
    return next;
  }

  return {
    start() {
      if (started) return chain;
      started = true;
      stopped = false;
      view = state.get();
      unsubscribe = host.onDefinitionsChanged(() => void rearm());
      return rearm();
    },
    stop() {
      stopped = true;
      unsubscribe?.();
      unsubscribe = null;
      resolveTimer?.cancel();
      resolveTimer = null;
      for (const poller of pollers.values()) {
        for (const channel of CHANNELS) {
          poller.channels[channel].timer?.cancel();
          poller.channels[channel].timer = null;
        }
      }
    },
    rearm,
    triggerState(workflowId, nodeId) {
      const key = gitCursorKey(workflowId, nodeId);
      const cursor = view.git[key];
      const problem = unresolved.get(key);
      if (!cursor && problem === undefined) return null;
      return {
        repo: repoOfTrigger.get(key) ?? null,
        baselined: cursor?.baselined ?? false,
        lastPollAt: cursor?.lastPollAt ?? null,
        lastError: problem ?? cursor?.lastError ?? null,
        failures: cursor?.failures ?? 0
      };
    },
    async idle() {
      for (;;) {
        const seenChain = chain;
        const pending = [...inflight];
        await seenChain;
        await Promise.all(pending);
        if (seenChain === chain && inflight.size === 0) return;
      }
    }
  };
}
