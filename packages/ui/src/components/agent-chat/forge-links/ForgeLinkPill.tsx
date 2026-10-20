import React from "react";
import { createPortal } from "react-dom";
import {
  CircleCheck,
  CircleDot,
  CirclePlay,
  CircleSlash,
  CircleX,
  ExternalLink,
  FileCode,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Github,
  Gitlab,
  LoaderCircle,
  MessageSquare,
  MessagesSquare,
  Tag
} from "lucide-react";
import {
  forgeLinkDescription,
  forgeLinkLabel,
  githubPreviewTarget,
  type ForgeLink,
  type GitHubLinkPreview,
  type GitHubPreviewTarget
} from "@orquester/api";

import { useOptionalApi } from "../../../context/orquester-context";
import { BitbucketIcon } from "../../../icons/Bitbucket";
import { cn } from "../../../lib/cn";
import type { ApiClient } from "../../../lib/api-client";
import {
  checksPresentation,
  forgePillPresentation,
  previewTimeline,
  type ChecksTone,
  type ForgePillIcon,
  type ForgePillTone
} from "../../../lib/github-links/pill.logic";
import { LinkPreviewStore, type LinkPreviewState } from "../../../lib/github-links/preview-store";
import { relativeTime } from "../../../lib/relative-time";
import { useAppStore } from "../../../store/app";
import { useTimelineRowContext } from "../timeline/context";

/**
 * A forge link as a compact pill (T3: `ChatMarkdown.tsx` link handling and
 * `PullRequestLinkPreview.tsx`): a kind-or-state icon and a short label such
 * as `owner/repo#123`, or the author's own words when the link had them.
 *
 * It stays a real `<a target="_blank" rel="noopener noreferrer">`, so a click,
 * a middle-click, a long-press menu and the desktop shell's external-open all
 * behave as for any link. GitHub PRs, issues and commits read their metadata
 * through the daemon (`/api/github/link-preview`) — only once the pill is on
 * screen or hovered — and then take GitHub's state colour. Hover, or keyboard
 * focus, opens a card with the details; a touch tap just follows the link.
 */

// ---------------------------------------------------------------------------
// Presentation maps
// ---------------------------------------------------------------------------

/** A lucide icon or our Bitbucket mark: both render from these props (and are aria-hidden). */
type IconComponent = (props: { size?: number; className?: string; "aria-hidden"?: boolean }) => React.ReactNode;

const ICONS: Record<ForgePillIcon, IconComponent> = {
  pull: GitPullRequest,
  "pull-draft": GitPullRequestDraft,
  "pull-merged": GitMerge,
  "pull-closed": GitPullRequestClosed,
  issue: CircleDot,
  "issue-done": CircleCheck,
  "issue-not-planned": CircleSlash,
  discussion: MessagesSquare,
  commit: GitCommitHorizontal,
  repo: Github,
  file: FileCode,
  folder: Folder,
  release: Tag,
  run: CirclePlay,
  gitlab: Gitlab,
  bitbucket: BitbucketIcon
};

/** GitHub's state colours through our tokens; merged purple has its own variable (globals.css). */
export const TONE_TEXT: Record<ForgePillTone, string> = {
  open: "text-ok",
  merged: "text-[color:var(--gh-merged)]",
  closed: "text-danger",
  draft: "text-neutral-500",
  neutral: "text-neutral-400"
};

const CHECKS_TEXT: Record<ChecksTone, string> = {
  passed: "text-ok",
  failed: "text-danger",
  pending: "text-warn",
  neutral: "text-neutral-500"
};

const CHECKS_ICON: Record<ChecksTone, IconComponent> = {
  passed: CircleCheck,
  failed: CircleX,
  pending: CircleDot,
  neutral: CircleSlash
};

// ---------------------------------------------------------------------------
// Scope: which project the link is read for
// ---------------------------------------------------------------------------

export interface ForgeLinkScope {
  /** The project whose workspace account reads previews; null reads anonymously. */
  projectPath: string | null;
  /** That project's `repoKey`, so links into its own repo drop `owner/repo`. */
  currentRepoKey: string | null;
}

/** The scope a pill renders in: the given project, else the timeline's. */
export function useForgeLinkScope(projectPath?: string | null): ForgeLinkScope {
  const { workspaceRoot } = useTimelineRowContext();
  const path = projectPath === undefined ? (workspaceRoot ?? null) : projectPath;
  const currentRepoKey = useAppStore((state) =>
    path ? (state.projects.find((project) => project.path === path)?.repoKey ?? null) : null
  );
  return { projectPath: path, currentRepoKey };
}

// ---------------------------------------------------------------------------
// Previews: one store per API client, read when a pill is seen
// ---------------------------------------------------------------------------

const stores = new WeakMap<ApiClient, LinkPreviewStore>();

function storeFor(api: ApiClient): LinkPreviewStore {
  let store = stores.get(api);
  if (!store) {
    store = new LinkPreviewStore(async (url, projectPath) => (await api.getGitHubLinkPreview(url, projectPath)).preview);
    stores.set(api, store);
  }
  return store;
}

const IDLE: LinkPreviewState = { status: "idle" };
const NO_SUBSCRIPTION = (): (() => void) => () => undefined;

function useLinkPreview(target: GitHubPreviewTarget | null, url: string, projectPath: string | null, wanted: boolean): LinkPreviewState {
  const api = useOptionalApi();
  const store = api ? storeFor(api) : null;
  const key = store && target ? store.keyOf(target, projectPath) : null;
  const subscribe = React.useCallback(
    (listener: () => void) => (store && key ? store.subscribe(key, listener) : NO_SUBSCRIPTION()),
    [store, key]
  );
  const snapshot = React.useCallback(() => (store && key ? store.get(key) : IDLE), [store, key]);
  const state = React.useSyncExternalStore(subscribe, snapshot, () => IDLE);
  React.useEffect(() => {
    if (wanted && store && key) store.request(key, url, projectPath);
  }, [wanted, store, key, url, projectPath]);
  return state;
}

/** One shared observer: a pill counts as seen once it comes within a screen of the viewport. */
const seenCallbacks = new Map<Element, () => void>();
let seenObserver: IntersectionObserver | null = null;

function observeSeen(element: Element, onSeen: () => void): () => void {
  if (typeof IntersectionObserver === "undefined") return () => undefined;
  seenObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const callback = seenCallbacks.get(entry.target);
        seenCallbacks.delete(entry.target);
        seenObserver?.unobserve(entry.target);
        callback?.();
      }
    },
    { rootMargin: "200px 0px" }
  );
  seenCallbacks.set(element, onSeen);
  seenObserver.observe(element);
  return () => {
    seenCallbacks.delete(element);
    seenObserver?.unobserve(element);
  };
}

// ---------------------------------------------------------------------------
// The hover card
// ---------------------------------------------------------------------------

const OPEN_DELAY_MS = 350;
const CLOSE_DELAY_MS = 150;
const CARD_GAP = 6;
const CARD_MARGIN = 8;

interface CardPosition {
  left: number;
  top?: number;
  bottom?: number;
  maxWidth: number;
}

function placeCard(anchor: HTMLElement, cardWidth: number): CardPosition {
  // A pill that wraps has several boxes; the card hangs off the first.
  const rect = anchor.getClientRects()[0] ?? anchor.getBoundingClientRect();
  const maxWidth = Math.max(200, window.innerWidth - CARD_MARGIN * 2);
  const width = Math.min(cardWidth, maxWidth);
  const left = Math.min(Math.max(CARD_MARGIN, rect.left), Math.max(CARD_MARGIN, window.innerWidth - CARD_MARGIN - width));
  const spaceBelow = window.innerHeight - rect.bottom;
  const below = spaceBelow >= 220 || spaceBelow >= rect.top;
  return below
    ? { left, top: rect.bottom + CARD_GAP, maxWidth }
    : { left, bottom: window.innerHeight - rect.top + CARD_GAP, maxWidth };
}

function isFocusVisible(element: HTMLElement): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

function TimeAgo({ at }: { at: string | null }): React.ReactElement | null {
  if (!at) return null;
  const label = relativeTime(at);
  if (!label) return null;
  const date = new Date(at);
  return (
    <time dateTime={at} title={date.toLocaleString()}>
      {label}
    </time>
  );
}

function PreviewDetails({ preview }: { preview: GitHubLinkPreview }): React.ReactElement {
  const timeline = previewTimeline(preview);
  const checks = preview.kind === "pull" ? checksPresentation(preview.checks) : null;
  const ChecksIcon = checks ? CHECKS_ICON[checks.tone] : null;
  return (
    <>
      <p className="mt-1 text-sm font-medium leading-snug text-neutral-100 [overflow-wrap:anywhere] line-clamp-3">
        {preview.title || "(no title)"}
      </p>
      {preview.kind === "commit" && preview.body ? (
        <p className="mt-1 whitespace-pre-wrap text-xs leading-snug text-neutral-400 [overflow-wrap:anywhere] line-clamp-4">
          {preview.body}
        </p>
      ) : null}
      {preview.kind === "pull" && preview.baseRef && preview.headRef ? (
        <p className="mt-2 flex min-w-0 items-center gap-1 text-xs text-neutral-400">
          <GitBranch size={12} aria-hidden className="shrink-0 text-neutral-500" />
          <span className="min-w-0 truncate font-mono text-[11px]" title={`${preview.headLabel ?? preview.headRef} into ${preview.baseRef}`}>
            {preview.baseRef} ← {preview.headLabel ?? preview.headRef}
          </span>
        </p>
      ) : null}
      <p className="mt-2 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-neutral-500">
        <span className="min-w-0 truncate text-neutral-300">{preview.author ?? "ghost"}</span>
        {timeline.at ? (
          <span>
            {timeline.verb} <TimeAgo at={timeline.at} />
          </span>
        ) : null}
        {preview.kind !== "commit" && preview.comments > 0 ? (
          <span className="inline-flex items-center gap-0.5" title={`${preview.comments} comments`}>
            <MessageSquare size={11} aria-hidden />
            <span className="ac-tabular">{preview.comments}</span>
            <span className="sr-only">comments</span>
          </span>
        ) : null}
        {preview.kind === "pull" && preview.additions !== null && preview.deletions !== null ? (
          <span className="ac-tabular">
            <span className="text-ok">+{preview.additions}</span> <span className="text-danger">−{preview.deletions}</span>
            {preview.changedFiles !== null ? ` · ${preview.changedFiles} ${preview.changedFiles === 1 ? "file" : "files"}` : ""}
          </span>
        ) : null}
      </p>
      {checks && ChecksIcon ? (
        <p className={cn("mt-1.5 flex items-center gap-1 text-xs", CHECKS_TEXT[checks.tone])}>
          <ChecksIcon size={12} aria-hidden className="shrink-0" />
          <span className="text-neutral-400">{checks.label}</span>
        </p>
      ) : null}
    </>
  );
}

const UNAVAILABLE_COPY = {
  not_found: "Not found, or in a private repository no connected GitHub account can read.",
  rate_limited: "GitHub's rate limit is reached; details will load again shortly.",
  error: "Couldn't reach GitHub for details."
} as const;

function CardBody({
  link,
  state,
  fetchable
}: {
  link: ForgeLink;
  state: LinkPreviewState;
  fetchable: boolean;
}): React.ReactElement {
  const preview = state.status === "ready" ? state.preview : null;
  const presentation = forgePillPresentation(link, preview);
  const StateIcon = ICONS[presentation.icon];
  const repoName = link.forge === "github" ? `${link.owner}/${link.repo}` : link.repository;
  const reference =
    preview?.kind === "commit"
      ? preview.sha.slice(0, 7)
      : preview
        ? `#${preview.number}`
        : link.forge !== "github" || link.kind === "pull" || link.kind === "issue" || link.kind === "discussion"
          ? `#${link.number}`
          : link.kind === "commit"
            ? link.sha.slice(0, 7)
            : null;
  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-neutral-500">
        <span className="min-w-0 truncate">{repoName}</span>
        {reference ? <span className="ac-tabular shrink-0">{reference}</span> : null}
        {presentation.stateLabel ? (
          <>
            <span aria-hidden>·</span>
            <span className={cn("inline-flex shrink-0 items-center gap-1", TONE_TEXT[presentation.tone])}>
              <StateIcon size={12} aria-hidden />
              {presentation.stateLabel}
            </span>
          </>
        ) : null}
      </div>
      {preview ? (
        <PreviewDetails preview={preview} />
      ) : (
        <>
          <p className="mt-1 text-sm font-medium leading-snug text-neutral-100 [overflow-wrap:anywhere]">
            {forgeLinkDescription(link)}
          </p>
          {fetchable && (state.status === "loading" || state.status === "idle") ? (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-neutral-500" role="status">
              <LoaderCircle size={12} aria-hidden className="animate-spin motion-reduce:animate-none" />
              Loading details…
            </p>
          ) : null}
          {state.status === "unavailable" ? (
            <p className="mt-2 text-xs leading-snug text-neutral-500">{UNAVAILABLE_COPY[state.reason]}</p>
          ) : null}
        </>
      )}
      <p className="mt-2 truncate font-mono text-[10.5px] text-neutral-600" title={link.url}>
        {link.url}
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// The pill
// ---------------------------------------------------------------------------

export interface ForgeLinkPillProps {
  link: ForgeLink;
  /** The author's own link text. Absent: the generated label (`owner/repo#123`). */
  children?: React.ReactNode;
  /** The project to read previews for. Absent: the timeline's project. */
  projectPath?: string | null;
  /** `inline` sits in prose and wraps with it; `chip` is the composer row's fixed-height chip. */
  variant?: "inline" | "chip";
  className?: string;
}

const PILL_BASE =
  "rounded-md border border-neutral-700/70 bg-neutral-800/50 text-neutral-200 no-underline " +
  "transition-colors hover:border-neutral-600 hover:bg-neutral-800 hover:text-neutral-50 " +
  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500";

export function ForgeLinkPill({ link, children, projectPath, variant = "inline", className }: ForgeLinkPillProps): React.ReactElement {
  const scope = useForgeLinkScope(projectPath);
  const target = React.useMemo(() => githubPreviewTarget(link), [link]);
  const anchorRef = React.useRef<HTMLAnchorElement>(null);
  const cardRef = React.useRef<HTMLDivElement | null>(null);
  const [seen, setSeen] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [position, setPosition] = React.useState<CardPosition | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardId = React.useId();

  const state = useLinkPreview(target, link.url, scope.projectPath, seen || open);
  const preview = state.status === "ready" ? state.preview : null;
  const presentation = forgePillPresentation(link, preview);
  const Icon = ICONS[presentation.icon];
  const label = forgeLinkLabel(link, { currentRepoKey: scope.currentRepoKey });

  React.useEffect(() => {
    const element = anchorRef.current;
    if (!element || !target || seen) return;
    if (typeof IntersectionObserver === "undefined") return;
    return observeSeen(element, () => setSeen(true));
  }, [target, seen]);

  const clearTimer = React.useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  React.useEffect(() => clearTimer, [clearTimer]);

  const show = React.useCallback(
    (delay: number) => {
      clearTimer();
      if (delay === 0) setOpen(true);
      else timer.current = setTimeout(() => setOpen(true), delay);
    },
    [clearTimer]
  );
  const hide = React.useCallback(
    (delay: number) => {
      clearTimer();
      if (delay === 0) setOpen(false);
      else timer.current = setTimeout(() => setOpen(false), delay);
    },
    [clearTimer]
  );

  const reposition = React.useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    setPosition(placeCard(anchor, cardRef.current?.getBoundingClientRect().width ?? 320));
  }, []);

  // A passive effect (the static renderer warns on a layout one): the card stays hidden until placed.
  React.useEffect(() => {
    if (open) reposition();
    else setPosition(null);
  }, [open, reposition]);

  React.useEffect(() => {
    if (!open) return;
    // Escape dismisses the card without taking the key from the chat (it still stops a turn).
    // Window capture, beside the chat's own Escape handlers, so none of them can hide it from us.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide(0);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, hide, reposition]);

  const custom = children !== undefined && children !== null;
  const chip = variant === "chip";
  // The colour says the state to sighted users; this says it to everyone else.
  const stateSuffix = presentation.stateLabel ? <span className="sr-only"> ({presentation.stateLabel})</span> : null;

  const anchor = (
    <a
      ref={anchorRef}
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      data-forge-link={link.forge === "github" ? link.kind : link.forge}
      data-forge-state={presentation.tone}
      aria-describedby={open ? cardId : undefined}
      onPointerEnter={(event) => {
        // A tap opens the link; a card would only stand in its way.
        if (event.pointerType !== "touch") show(OPEN_DELAY_MS);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "touch") hide(CLOSE_DELAY_MS);
      }}
      onFocus={(event) => {
        if (isFocusVisible(event.currentTarget)) show(0);
      }}
      onBlur={() => hide(0)}
      onClick={() => hide(0)}
      className={cn(
        PILL_BASE,
        chip
          ? "ac-press inline-flex h-7 max-w-56 items-center gap-1 px-2 text-xs"
          : // Inline: wraps with the sentence, each line box keeps the pill's chrome.
            "px-1 py-px [-webkit-box-decoration-break:clone] [box-decoration-break:clone]",
        className
      )}
    >
      {chip ? (
        <>
          <Icon size={12} aria-hidden className={cn("shrink-0", TONE_TEXT[presentation.tone])} />
          <span className="truncate">{label}</span>
          {stateSuffix}
        </>
      ) : (
        <>
          <Icon
            size={13}
            aria-hidden
            className={cn("me-1 inline-block size-[0.95em] align-[-0.125em]", TONE_TEXT[presentation.tone])}
          />
          {custom ? children : <span className="[overflow-wrap:anywhere]">{label}</span>}
          {stateSuffix}
        </>
      )}
    </a>
  );

  return (
    <>
      {anchor}
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={cardRef}
              id={cardId}
              role="tooltip"
              data-forge-link-card="true"
              onPointerEnter={() => clearTimer()}
              onPointerLeave={() => hide(CLOSE_DELAY_MS)}
              style={{
                position: "fixed",
                left: position?.left ?? -9999,
                top: position?.top,
                bottom: position?.bottom,
                maxWidth: position?.maxWidth,
                visibility: position ? "visible" : "hidden"
              }}
              className={cn(
                "z-[120] w-80 rounded-lg border border-neutral-800 bg-neutral-900 p-3 text-left",
                "shadow-xl shadow-black/40"
              )}
            >
              <CardBody link={link} state={state} fetchable={target !== null} />
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                // The pill itself is the keyboard's way there; this is the pointer's.
                tabIndex={-1}
                onClick={() => hide(0)}
                className="mt-2 inline-flex items-center gap-1 rounded text-xs text-info-300 hover:underline hover:decoration-dotted"
              >
                Open on {link.forge === "github" ? "GitHub" : link.forge === "gitlab" ? "GitLab" : "Bitbucket"}
                <ExternalLink size={11} aria-hidden />
              </a>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
