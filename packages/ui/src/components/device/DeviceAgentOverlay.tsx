/**
 * What the agent does, drawn over the device (spec §10.1): a ripple with the target's label where
 * it tapped, the trail of a swipe, a bubble with typed text, a chip for a key. Each mark fades after
 * {@link OVERLAY_MARK_MS}; with `prefers-reduced-motion` it shows still and disappears.
 *
 * Only actions that arrive while the device is on screen draw; the history a load brings does not.
 * Points map through the viewport's `projectPoint` (3D or flat); a scene that cannot project shows
 * the label alone, at the top.
 */

import React from "react";

import type { DeviceActionEntry, DeviceScreen } from "@orquester/api";

import { cn } from "../../lib/cn";
import { newOverlayEntries, OVERLAY_MARK_MS, overlayMarkOf, type NormalizedPoint, type OverlayMark, type ScreenOrientation } from "./overlay.logic";

type Project = (x: number, y: number) => { x: number; y: number } | null;

interface Placed {
  mark: OverlayMark;
  /** Pixels in the overlay box; null: the label alone, at the top. */
  at: { x: number; y: number } | null;
  to: { x: number; y: number } | null;
}

function reducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Run a Web Animation where there is one (jsdom has none). */
function animate(node: Element | null, frames: Keyframe[], options: KeyframeAnimationOptions): void {
  if (!node || reducedMotion() || typeof (node as HTMLElement).animate !== "function") return;
  (node as HTMLElement).animate(frames, options);
}

const FADE: Keyframe[] = [{ opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }];

function MarkLabel({ text, failed, className }: { text: string; failed: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "max-w-[14rem] truncate rounded-full px-2 py-0.5 text-[11px] font-medium shadow-md ring-1",
        failed ? "bg-danger-soft text-danger ring-danger/40" : "bg-neutral-950/90 text-warn ring-warn-500/40",
        className
      )}
    >
      {text}
    </span>
  );
}

function TapMark({ placed }: { placed: Placed & { mark: Extract<OverlayMark, { kind: "tap" }> } }) {
  const root = React.useRef<HTMLDivElement | null>(null);
  const ring = React.useRef<HTMLSpanElement | null>(null);
  React.useEffect(() => {
    animate(root.current, FADE, { duration: OVERLAY_MARK_MS, fill: "forwards" });
    animate(ring.current, [{ transform: "translate(-50%, -50%) scale(0.4)" }, { transform: "translate(-50%, -50%) scale(1.6)" }], {
      duration: placed.mark.long ? 900 : 600,
      easing: "cubic-bezier(.2,.7,.3,1)",
      fill: "forwards"
    });
  }, [placed.mark.long]);
  const { mark, at } = placed;
  if (!at) {
    return (
      <div ref={root} className="absolute left-1/2 top-3 -translate-x-1/2">
        <MarkLabel text={mark.label} failed={mark.failed} />
      </div>
    );
  }
  const tone = mark.failed ? "border-danger bg-danger/20" : "border-warn bg-warn/25";
  return (
    <div ref={root} className="absolute" style={{ left: at.x, top: at.y }}>
      <span aria-hidden className={cn("absolute left-0 top-0 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2", tone)} />
      <span ref={ring} aria-hidden className={cn("absolute left-0 top-0 h-9 w-9 rounded-full border", mark.failed ? "border-danger/70" : "border-warn/70")} style={{ transform: "translate(-50%, -50%)" }} />
      <MarkLabel text={mark.long ? `Held · ${mark.label}` : mark.label} failed={mark.failed} className="absolute bottom-4 left-0 -translate-x-1/2" />
    </div>
  );
}

function SwipeMark({ placed }: { placed: Placed & { mark: Extract<OverlayMark, { kind: "swipe" }> } }) {
  const root = React.useRef<SVGSVGElement | null>(null);
  const line = React.useRef<SVGLineElement | null>(null);
  React.useEffect(() => {
    animate(root.current, FADE, { duration: OVERLAY_MARK_MS, fill: "forwards" });
    animate(line.current, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 450, easing: "ease-out", fill: "forwards" });
  }, []);
  const { mark, at, to } = placed;
  if (!at || !to) {
    return (
      <div className="absolute left-1/2 top-3 -translate-x-1/2">
        <MarkLabel text={mark.label} failed={mark.failed} />
      </div>
    );
  }
  return (
    <svg ref={root} aria-hidden className={cn("absolute inset-0 h-full w-full overflow-visible", mark.failed ? "text-danger" : "text-warn")}>
      <line ref={line} x1={at.x} y1={at.y} x2={to.x} y2={to.y} stroke="currentColor" strokeWidth={6} strokeLinecap="round" strokeOpacity={0.5} pathLength={1} strokeDasharray="1" />
      <circle cx={at.x} cy={at.y} r={5} fill="currentColor" fillOpacity={0.35} />
      <circle cx={to.x} cy={to.y} r={7} fill="currentColor" fillOpacity={0.85} />
    </svg>
  );
}

function BubbleMark({ placed, text, icon }: { placed: Placed; text: string; icon: string }) {
  const root = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    animate(root.current, [...FADE.map((frame, index) => (index === 0 ? { ...frame, transform: "translate(-50%, 6px)" } : { ...frame, transform: "translate(-50%, 0)" }))], {
      duration: OVERLAY_MARK_MS,
      fill: "forwards"
    });
  }, []);
  const at = placed.at;
  return (
    <div
      ref={root}
      className="absolute"
      style={at ? { left: at.x, top: at.y + 14, transform: "translate(-50%, 0)" } : { left: "50%", bottom: 16, transform: "translate(-50%, 0)" }}
    >
      <span
        className={cn(
          "inline-flex max-w-[16rem] items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] shadow-lg ring-1",
          placed.mark.failed ? "bg-danger-soft text-danger ring-danger/40" : "bg-neutral-950/90 text-neutral-100 ring-warn-500/40"
        )}
      >
        <span aria-hidden className="text-warn">
          {icon}
        </span>
        <span className="truncate">{text}</span>
      </span>
    </div>
  );
}

export function DeviceAgentOverlay(props: {
  entries: readonly DeviceActionEntry[];
  screen: Pick<DeviceScreen, "width" | "height"> | undefined;
  orientation: ScreenOrientation;
  project: Project;
  /** Off while nothing is on screen: entries seen then never animate. */
  active: boolean;
}): React.ReactElement {
  const seen = React.useRef<Set<string> | null>(null);
  const [placed, setPlaced] = React.useState<Placed[]>([]);
  const latest = React.useRef(props);
  latest.current = props;
  const timers = React.useRef(new Set<ReturnType<typeof setTimeout>>());

  React.useEffect(() => {
    // The first look (and every look while hidden) only records what is there.
    if (seen.current === null || !props.active) {
      seen.current = new Set(props.entries.map((entry) => entry.id));
      return;
    }
    const fresh = newOverlayEntries(props.entries, seen.current);
    if (fresh.length === 0) return;
    for (const entry of fresh) seen.current.add(entry.id);
    const { screen, orientation, project } = latest.current;
    const place = (point: NormalizedPoint | null) => (point ? project(point.x, point.y) : null);
    const next: Placed[] = [];
    for (const entry of fresh.slice(-4)) {
      const mark = overlayMarkOf(entry, screen, orientation);
      if (!mark) continue;
      if (mark.kind === "swipe") next.push({ mark, at: place(mark.from), to: place(mark.to) });
      else if (mark.kind === "key") next.push({ mark, at: null, to: null });
      else next.push({ mark, at: place(mark.at), to: null });
    }
    if (next.length === 0) return;
    setPlaced((current) => [...current, ...next].slice(-6));
    const ids = new Set(next.map((item) => item.mark.id));
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setPlaced((current) => current.filter((item) => !ids.has(item.mark.id)));
    }, OVERLAY_MARK_MS);
    timers.current.add(timer);
  }, [props.entries, props.active]);

  React.useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
      timers.current.clear();
    },
    []
  );

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-10 overflow-hidden" data-device-overlay="">
      {placed.map((item) => {
        const { mark } = item;
        switch (mark.kind) {
          case "tap":
            return <TapMark key={mark.id} placed={{ ...item, mark }} />;
          case "swipe":
            return <SwipeMark key={mark.id} placed={{ ...item, mark }} />;
          case "text":
            return <BubbleMark key={mark.id} placed={item} text={mark.text} icon="⌨" />;
          case "key":
            return <BubbleMark key={mark.id} placed={item} text={mark.label} icon="●" />;
        }
      })}
    </div>
  );
}
