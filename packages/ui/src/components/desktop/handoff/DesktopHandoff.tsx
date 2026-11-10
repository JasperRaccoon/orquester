/**
 * The agent ↔ user handoff in a desktop tab (spec 2026-11-10 §3, R2.2–R2.4):
 *
 * - {@link useDesktopHandoff}: the desktop's control state and recent actions, the handoff calls,
 *   and the **implicit takeover** — the user's first pointer or key input in the view while an
 *   agent controls the desktop takes control once (`PUT control {controller: "user"}`) and raises a
 *   toast with **Give back**. Hardware keys and mouse or pen presses over the display are seen in
 *   the capture phase on the view, whatever renders the stream; touch, the key bar and the soft
 *   keyboard take over through `inputReachedDesktop` once they send something (a pinch or a pan
 *   while zoomed stays local, and so does a key bar's Fn or a modifier latch).
 * - {@link DesktopHandoffControls}: the toolbar's control pill, the Activity popover's button and
 *   the size-lock notice.
 * - {@link DesktopHandoffLayer}: over the stream — the agent overlay and the takeover toast.
 *
 * A desktop nobody automated (control `null`, no actions) renders none of it.
 */

import React from "react";
import { Hand, ListTree, Lock } from "lucide-react";

import type { DesktopActor, DesktopControl, DesktopController, DesktopSize, DesktopSummary } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { parseDesktopSummary } from "../../../lib/desktop-state";
import { desktopActionsStore, loadDesktopActionLog } from "../../../lib/desktops/actions-store";
import {
  desktopControlPill,
  desktopHasHandoff,
  EMPTY_DESKTOP_RING,
  inputTakesOver,
  liveDesktopActions,
  sizeLockNotice,
  takeoverToastText,
  unseenBadge,
  viewInputReachesDesktop,
  type DesktopActionRing
} from "../../../lib/desktops/handoff.logic";
import { useAppStore } from "../../../store/app";
import { Dropdown } from "../../ui/dropdown";
import { DesktopActionLogPanel } from "./DesktopActionLog";
import { DesktopAgentOverlay } from "./DesktopAgentOverlay";
import { canvasShowsWholeDisplay, mapDisplayPoint, unionRect, type Rect, type ViewPoint } from "./overlay.logic";

/** Elements whose input is not desktop input (the toolbar, this UI's own controls, local-only controls). */
const NOT_DESKTOP_INPUT = "[data-desktop-toolbar], [data-desktop-handoff]";
const TOAST_MS = 6000;

function errorText(err: unknown): string {
  const server = (err as { serverMessage?: unknown } | null)?.serverMessage;
  if (typeof server === "string" && server) return server;
  return err instanceof Error && err.message ? err.message : "The request failed.";
}

/** A desktop's recent actions (oldest first) and unseen count, as the store has them. */
export function useDesktopActionRing(desktopId: string): DesktopActionRing {
  return React.useSyncExternalStore(
    desktopActionsStore.subscribe,
    () => desktopActionsStore.getState().rings[desktopId] ?? EMPTY_DESKTOP_RING,
    () => EMPTY_DESKTOP_RING
  );
}

export interface DesktopToast {
  text: string;
  tone: "info" | "danger";
  /** Offer Give back (after a takeover). */
  giveBack: boolean;
}

export interface DesktopHandoff {
  desktop: DesktopSummary;
  control: DesktopControl | null;
  ring: DesktopActionRing;
  /** A handoff call is in flight. */
  busy: boolean;
  changeControl: (controller: DesktopController) => void;
  toast: DesktopToast | null;
  dismissToast: () => void;
  /** The view shows the stream (marks draw only then). */
  live: boolean;
  /** Input went to the desktop through the view's sink (touch, key bar, soft keyboard): the implicit takeover. */
  inputReachedDesktop: () => void;
}

/** The view's elements the implicit takeover listens on. */
export interface DesktopHandoffTargets {
  /** The view's root: hardware keys anywhere in it. */
  root: React.RefObject<HTMLElement | null>;
  /** The view's (untransformed) box and the stage inside it: what counts as "over the display". */
  viewport: React.RefObject<HTMLElement | null>;
  stage: React.RefObject<HTMLElement | null>;
}

/**
 * The handoff state and calls for one desktop view, and the implicit takeover on `targets`.
 * `live`: the stream is connected, so input reaches the desktop.
 */
export function useDesktopHandoff(targets: DesktopHandoffTargets, desktop: DesktopSummary, live: boolean): DesktopHandoff {
  const api = useAppStore((s) => s.api);
  const upsertDesktop = useAppStore((s) => s.upsertDesktop);
  const control = desktop.control ?? null;
  const ring = useDesktopActionRing(desktop.id);
  const [busy, setBusy] = React.useState(false);
  const [toast, setToast] = React.useState<DesktopToast | null>(null);
  const busyRef = React.useRef(false);

  // The daemon's log, once per desktop and connection, so a desktop agents used shows its Activity.
  React.useEffect(() => {
    if (!api || !live) return;
    loadDesktopActionLog(api, desktop.id).catch(() => undefined);
  }, [api, desktop.id, live]);

  const apply = React.useCallback(
    (controller: DesktopController, why: "button" | "input", from: DesktopActor | undefined) => {
      if (!api || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      api
        .setDesktopControl(desktop.id, controller)
        .then((summary) => {
          const parsed = parseDesktopSummary(summary);
          if (parsed) upsertDesktop(parsed);
          setToast(why === "input" ? { text: takeoverToastText(from), tone: "info", giveBack: true } : null);
        })
        .catch((err: unknown) => setToast({ text: errorText(err), tone: "danger", giveBack: false }))
        .finally(() => {
          busyRef.current = false;
          setBusy(false);
        });
    },
    [api, desktop.id, upsertDesktop]
  );

  const changeControl = React.useCallback(
    (controller: DesktopController) => apply(controller, "button", desktop.control?.actor),
    [apply, desktop.control?.actor]
  );

  // --- Implicit takeover ---------------------------------------------------------------------
  const latest = React.useRef({ control, live, apply });
  latest.current = { control, live, apply };
  /** The `since` of the agent control this view already took over. */
  const tookFrom = React.useRef<string | null>(null);
  const inputReachedDesktop = React.useCallback(() => {
    const { control: now, live: streaming, apply: take } = latest.current;
    if (!streaming || !inputTakesOver(now, tookFrom.current)) return;
    tookFrom.current = now!.since;
    take("user", "input", now!.actor);
  }, []);
  const { root: rootRef, viewport: viewportRef, stage: stageRef } = targets;
  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onInput = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      const viewport = viewportRef.current;
      const reaches = viewInputReachesDesktop({
        kind: event.type === "keydown" ? "keydown" : "pointerdown",
        pointerType: (event as Partial<PointerEvent>).pointerType,
        repeat: (event as Partial<KeyboardEvent>).repeat,
        onDisplay: target !== null && (target === viewport || stageRef.current?.contains(target) === true),
        local: target?.closest(NOT_DESKTOP_INPUT) != null
      });
      if (reaches) inputReachedDesktop();
    };
    root.addEventListener("pointerdown", onInput, true);
    root.addEventListener("keydown", onInput, true);
    return () => {
      root.removeEventListener("pointerdown", onInput, true);
      root.removeEventListener("keydown", onInput, true);
    };
  }, [rootRef, viewportRef, stageRef, inputReachedDesktop]);

  // The toast lasts a while, and never past the user's control.
  React.useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  React.useEffect(() => {
    if (control?.controller !== "user") setToast((current) => (current?.giveBack ? null : current));
  }, [control?.controller]);

  const dismissToast = React.useCallback(() => setToast(null), []);
  return { desktop, control, ring, busy, changeControl, toast, dismissToast, live, inputReachedDesktop };
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function ControlPill({ handoff, narrow }: { handoff: DesktopHandoff; narrow: boolean }) {
  const pill = desktopControlPill(handoff.control);
  if (!pill) return null;
  const agent = pill.tone === "agent";
  const short = agent ? (handoff.control?.actor?.label ?? "Agent") : "You";
  return (
    <div
      className={cn(
        "inline-flex h-7 min-w-0 max-w-[18rem] shrink items-center gap-1.5 rounded-full py-0.5 pl-2 pr-0.5 text-[11.5px] ring-1",
        agent ? "bg-warn-500/10 text-warn ring-warn-500/35" : "bg-neutral-800/70 text-neutral-200 ring-neutral-700/70"
      )}
      role="status"
      data-controller={pill.tone}
      title={pill.text}
    >
      <span aria-hidden className="relative flex h-2 w-2 shrink-0">
        {agent ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warn opacity-60 motion-reduce:animate-none" /> : null}
        <span className={cn("relative inline-flex h-2 w-2 rounded-full", agent ? "bg-warn" : "bg-info")} />
      </span>
      <span className="min-w-0 truncate font-medium">{narrow ? short : pill.text}</span>
      <button
        type="button"
        disabled={handoff.busy}
        aria-label={pill.action.ariaLabel}
        onClick={() => handoff.changeControl(pill.action.controller)}
        className={cn(
          "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400 disabled:opacity-50",
          agent ? "bg-warn/90 text-neutral-950 hover:bg-warn" : "bg-neutral-700 text-neutral-100 hover:bg-neutral-600"
        )}
      >
        {pill.action.label}
      </button>
    </div>
  );
}

const TRIGGER_CLASS =
  "relative inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100";

function ActivityButton({ handoff }: { handoff: DesktopHandoff }) {
  const badge = unseenBadge(handoff.ring.unseen);
  const label = badge ? `Agent activity, ${handoff.ring.unseen} new` : "Agent activity";
  return (
    <Dropdown
      role="dialog"
      ariaLabel="Agent activity on this desktop"
      align="right"
      width="w-[22rem]"
      focusOnOpen
      trigger={
        <span className={TRIGGER_CLASS} title={label} aria-label={label}>
          <ListTree size={14} />
          {badge ? (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-warn px-[3px] text-[9px] font-semibold leading-none text-neutral-950 tabular-nums">
              {badge}
            </span>
          ) : null}
        </span>
      }
    >
      <DesktopActionLogPanel desktopId={handoff.desktop.id} entries={handoff.ring.entries} loaded={handoff.ring.loaded} />
    </Dropdown>
  );
}

function SizeLock({ handoff, narrow }: { handoff: DesktopHandoff; narrow: boolean }) {
  const notice = sizeLockNotice(handoff.control);
  if (!notice) return null;
  if (narrow) {
    return (
      <span role="note" aria-label={notice} title={notice} className="inline-flex h-7 w-7 shrink-0 items-center justify-center text-neutral-500">
        <Lock size={13} aria-hidden />
      </span>
    );
  }
  return (
    <span role="note" title={notice} className="inline-flex h-7 min-w-0 shrink items-center gap-1 truncate px-1 text-[11px] text-neutral-500">
      <Lock size={12} aria-hidden className="shrink-0" />
      <span className="truncate">{notice}</span>
    </span>
  );
}

/** The toolbar's handoff controls, shown only once someone controls the desktop or agents acted on it. */
export function DesktopHandoffControls({ handoff, narrow }: { handoff: DesktopHandoff; narrow: boolean }): React.ReactElement | null {
  if (!desktopHasHandoff(handoff.control, handoff.ring)) return null;
  return (
    <div className="flex min-w-0 shrink items-center gap-1" data-desktop-handoff="">
      <ControlPill handoff={handoff} narrow={narrow} />
      <ActivityButton handoff={handoff} />
      <SizeLock handoff={handoff} narrow={narrow} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Over the stream
// ---------------------------------------------------------------------------

function rectOf(element: Element): Rect {
  const { left, top, width, height } = element.getBoundingClientRect();
  return { left, top, width, height };
}

/**
 * A display point in `container`'s pixels, from the stream's on-screen surface inside `streamRoot`:
 * an element marked `data-desktop-surface`, else the canvases and videos there (a striped video is
 * their union). Null while it cannot be placed — no surface, or noVNC clipping the display.
 */
export function mapStreamPoint(streamRoot: Element | null, container: Element | null, display: DesktopSize, point: ViewPoint): ViewPoint | null {
  if (!streamRoot || !container) return null;
  const marked = streamRoot.querySelector("[data-desktop-surface]");
  let surface: Rect | null;
  if (marked) {
    surface = rectOf(marked);
  } else {
    const media = [...streamRoot.querySelectorAll("canvas, video")];
    const only = media.length === 1 ? media[0] : null;
    if (only instanceof HTMLCanvasElement && !canvasShowsWholeDisplay({ width: only.width, height: only.height }, display)) return null;
    surface = unionRect(media.map(rectOf));
  }
  return surface ? mapDisplayPoint(point, display, surface, rectOf(container)) : null;
}

function TakeoverToast({ handoff }: { handoff: DesktopHandoff }) {
  const { toast } = handoff;
  if (!toast) return null;
  return (
    <div
      className="pointer-events-auto absolute bottom-3 left-1/2 z-20 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-full bg-neutral-900/95 py-1 pl-2.5 pr-1 text-[11.5px] text-neutral-200 shadow-lg ring-1 ring-neutral-700"
      role="status"
      data-desktop-handoff=""
    >
      <Hand size={12} aria-hidden className={cn("shrink-0", toast.tone === "danger" ? "text-danger" : "text-info")} />
      <span className={cn("truncate", toast.tone === "danger" && "text-danger")}>{toast.text}</span>
      {toast.giveBack ? (
        <button
          type="button"
          disabled={handoff.busy}
          onClick={() => handoff.changeControl("agent")}
          className="shrink-0 rounded-full bg-neutral-800 px-2 py-0.5 text-[11px] font-medium text-neutral-200 hover:bg-neutral-700 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400 disabled:opacity-50"
        >
          Give back
        </button>
      ) : (
        <button
          type="button"
          onClick={handoff.dismissToast}
          className="shrink-0 rounded-full px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}

/**
 * Over the stream (a sibling of its element, covering the same box): the agent's marks and the
 * takeover toast. `streamRoot` holds the rendered surface; `display` is the desktop's size.
 */
export function DesktopHandoffLayer({
  handoff,
  streamRoot,
  display
}: {
  handoff: DesktopHandoff;
  streamRoot: React.RefObject<HTMLElement | null>;
  display: DesktopSize;
}): React.ReactElement {
  const box = React.useRef<HTMLDivElement | null>(null);
  const displayRef = React.useRef(display);
  displayRef.current = display;
  const mapPoint = React.useCallback((x: number, y: number) => mapStreamPoint(streamRoot.current, box.current, displayRef.current, { x, y }), [streamRoot]);
  // History the log load brings never animates: only what arrived as events.
  const live = React.useMemo(() => liveDesktopActions(handoff.ring), [handoff.ring]);
  return (
    <div ref={box} className="pointer-events-none absolute inset-0 z-10">
      <DesktopAgentOverlay entries={live} mapPoint={mapPoint} active={handoff.live} />
      <TakeoverToast handoff={handoff} />
    </div>
  );
}
