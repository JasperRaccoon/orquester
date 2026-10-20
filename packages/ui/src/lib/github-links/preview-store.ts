import {
  githubPreviewKey,
  type GitHubLinkPreview,
  type GitHubPreviewTarget
} from "@orquester/api";

/**
 * The client half of GitHub link previews: one in-memory store per API client
 * that every pill on screen shares.
 *
 * - A pill asks only once it is visible or hovered (`request`), never on
 *   mount, so a long transcript does not read every link it ever contained.
 * - One ask per item: concurrent pills naming the same PR share its state.
 * - At most `maxConcurrent` asks travel at once; the rest queue, newest last.
 * - A failure is remembered with a retry time — a missing item for minutes, a
 *   spent rate limit until the daemon says it resets, an outage briefly — so
 *   scrolling back and forth does not re-ask for a dead link.
 *
 * The daemon caches too (per credential, with state-aware TTLs); this layer is
 * what keeps the requests off the wire in the first place.
 */

export type LinkPreviewUnavailableReason = "not_found" | "rate_limited" | "error";

export type LinkPreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; preview: GitHubLinkPreview }
  | { status: "unavailable"; reason: LinkPreviewUnavailableReason; retryAt: number };

/** Shared by every pill naming the item, so it is never cancelled when one of them unmounts. */
export type LinkPreviewFetcher = (url: string, projectPath: string | null) => Promise<GitHubLinkPreview>;

export interface LinkPreviewStoreOptions {
  maxConcurrent?: number;
  now?: () => number;
  /** A ready preview older than this is re-read (in the background) on the next ask. */
  freshMs?: number;
  maxEntries?: number;
}

export const PREVIEW_FRESH_MS = 2 * 60_000;
export const NOT_FOUND_RETRY_MS = 10 * 60_000;
export const ERROR_RETRY_MS = 30_000;
export const RATE_LIMIT_RETRY_MS = 60_000;
const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_MAX_ENTRIES = 1_000;

const IDLE: LinkPreviewState = { status: "idle" };
const LOADING: LinkPreviewState = { status: "loading" };

interface Entry {
  state: LinkPreviewState;
  fetchedAt: number;
  inflight: boolean;
  listeners: Set<() => void>;
}

interface Job {
  key: string;
  url: string;
  projectPath: string | null;
}

/** How a failed ask reads: 404/400 → not found, 429 → rate limited (with the daemon's wait), else an error. */
export function classifyPreviewError(error: unknown, now: number): { reason: LinkPreviewUnavailableReason; retryAt: number } {
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
  if (status === 404 || status === 400) return { reason: "not_found", retryAt: now + NOT_FOUND_RETRY_MS };
  if (status === 429) {
    const body = (error as { body?: unknown }).body;
    const fromBody = typeof body === "object" && body !== null ? (body as { retryAfterMs?: unknown }).retryAfterMs : undefined;
    const fromHeader = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
    const wait =
      typeof fromBody === "number" && Number.isFinite(fromBody) && fromBody > 0
        ? fromBody
        : typeof fromHeader === "number" && Number.isFinite(fromHeader) && fromHeader > 0
          ? fromHeader * 1000
          : RATE_LIMIT_RETRY_MS;
    return { reason: "rate_limited", retryAt: now + wait };
  }
  return { reason: "error", retryAt: now + ERROR_RETRY_MS };
}

const ITEM_STATES = new Set(["open", "draft", "merged", "closed"]);

/** The daemon's answer, checked before it reaches shared UI state. */
export function isGitHubLinkPreview(value: unknown): value is GitHubLinkPreview {
  if (typeof value !== "object" || value === null) return false;
  const preview = value as Record<string, unknown>;
  if (typeof preview.title !== "string" || typeof preview.owner !== "string" || typeof preview.repo !== "string") return false;
  if (typeof preview.url !== "string" || !preview.url.startsWith("https://github.com/")) return false;
  if (preview.kind === "commit") return typeof preview.sha === "string" && typeof preview.body === "string";
  if (preview.kind === "issue") return typeof preview.number === "number" && (preview.state === "open" || preview.state === "closed");
  if (preview.kind === "pull") return typeof preview.number === "number" && ITEM_STATES.has(preview.state as string);
  return false;
}

export class LinkPreviewStore {
  private readonly entries = new Map<string, Entry>();
  private readonly queue: Job[] = [];
  private active = 0;
  private readonly maxConcurrent: number;
  private readonly now: () => number;
  private readonly freshMs: number;
  private readonly maxEntries: number;

  constructor(
    private readonly fetcher: LinkPreviewFetcher,
    options: LinkPreviewStoreOptions = {}
  ) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    this.now = options.now ?? Date.now;
    this.freshMs = options.freshMs ?? PREVIEW_FRESH_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  }

  /** One key per item and project: the project picks which stored account reads it. */
  keyOf(target: GitHubPreviewTarget, projectPath: string | null | undefined): string {
    return `${projectPath ?? ""}\u0000${githubPreviewKey(target)}`;
  }

  get(key: string): LinkPreviewState {
    return this.entries.get(key)?.state ?? IDLE;
  }

  subscribe(key: string, listener: () => void): () => void {
    const entry = this.entry(key);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }

  /** Ask for the item unless it is fresh, already on its way, or failed and not yet due a retry. */
  request(key: string, url: string, projectPath: string | null): void {
    const entry = this.entry(key);
    if (entry.inflight) return;
    const now = this.now();
    const { state } = entry;
    if (state.status === "ready" && now - entry.fetchedAt < this.freshMs) return;
    if (state.status === "unavailable" && now < state.retryAt) return;
    entry.inflight = true;
    // A stale preview stays on screen while it is re-read; only a first read shows "loading".
    if (state.status !== "ready") this.set(entry, LOADING);
    this.queue.push({ key, url, projectPath });
    this.pump();
  }

  private entry(key: string): Entry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { state: IDLE, fetchedAt: 0, inflight: false, listeners: new Set() };
      this.entries.set(key, entry);
      this.evict(key);
    }
    return entry;
  }

  /** Drop the oldest entries nobody is watching or waiting on — never the one just made. */
  private evict(keep: string): void {
    if (this.entries.size <= this.maxEntries) return;
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries) break;
      if (key !== keep && entry.listeners.size === 0 && !entry.inflight) this.entries.delete(key);
    }
  }

  private set(entry: Entry, state: LinkPreviewState): void {
    entry.state = state;
    for (const listener of [...entry.listeners]) listener();
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.active += 1;
      void this.run(job).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  private async run(job: Job): Promise<void> {
    const entry = this.entry(job.key);
    try {
      const preview = await this.fetcher(job.url, job.projectPath);
      if (!isGitHubLinkPreview(preview)) throw new Error("Malformed link preview.");
      entry.fetchedAt = this.now();
      entry.inflight = false;
      this.set(entry, { status: "ready", preview });
    } catch (error) {
      entry.inflight = false;
      // A re-read that fails keeps the preview it already had.
      if (entry.state.status === "ready") {
        entry.fetchedAt = this.now();
        return;
      }
      const { reason, retryAt } = classifyPreviewError(error, this.now());
      this.set(entry, { status: "unavailable", reason, retryAt });
    }
  }
}
