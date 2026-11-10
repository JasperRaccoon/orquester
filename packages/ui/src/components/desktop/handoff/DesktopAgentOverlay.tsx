/**
 * What the agent does, drawn over the desktop (spec 2026-11-10 R2.4): a ripple where it clicked
 * (a right click in another colour, the count shown), the trail of a drag, chevrons for a scroll, a
 * bubble with typed text, a chip for a key combo. Each mark fades in and out over
 * {@link DESKTOP_MARK_MS}; with `prefers-reduced-motion` it shows still, then disappears.
 *
 * Only actions that arrive while the view is live draw; the history a load brings does not. It
 * never takes input (`pointer-events: none`) and is hidden from assistive tech: the Activity log
 * is the accessible record of the same actions.
 */

import React from "react";

import type { DesktopActionEntry } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { DESKTOP_MARK_MS, desktopOverlayMark, newDesktopEntries, type DesktopOverlayMark, type MapDisplayPoint } from "./overlay.logic";

function reducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Run a Web Animation where there is one (and motion is welcome). */
function animate(node: Element | null, frames: Keyframe[], options: KeyframeAnimationOptions): void {
  if (!node || reducedMotion() || typeof (node as HTMLElement).animate !== "function") return;
  (node as HTMLElement).animate(frames, options);
}

const FADE: Keyframe[] = [{ opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }];

function useFade<T extends Element>(): React.MutableRefObject<T | null> {
  const ref = React.useRef<T | null>(null);
  React.useEffect(() => animate(ref.current, FADE, { duration: DESKTOP_MARK_MS, fill: "forwards" }), []);
  return ref;
}

/** Tone classes: the agent's amber, a right click blue, a middle click neutral, a failure red. */
function toneOf(mark: { failed: boolean }, button: "left" | "middle" | "right" = "left") {
  if (mark.failed) return { ring: "border-danger", fill: "bg-danger/25", text: "text-danger", chip: "bg-danger-soft text-danger ring-danger/40" };
  if (button === "right") return { ring: "border-info", fill: "bg-info/25", text: "text-info", chip: "bg-neutral-950/90 text-info ring-info/40" };
  if (button === "middle") return { ring: "border-neutral-300", fill: "bg-neutral-300/25", text: "text-neutral-300", chip: "bg-neutral-950/90 text-neutral-200 ring-neutral-500/50" };
  return { ring: "border-warn", fill: "bg-warn/25", text: "text-warn", chip: "bg-neutral-950/90 text-warn ring-warn-500/40" };
}

function Chip({ text, className }: { text: string; className: string }) {
  return <span className={cn("max-w-[16rem] truncate whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium shadow-md ring-1", className)}>{text}</span>;
}

function ClickMark({ mark }: { mark: Extract<DesktopOverlayMark, { kind: "click" | "press" }> }) {
  const root = useFade<HTMLDivElement>();
  const ring = React.useRef<HTMLSpanElement | null>(null);
  React.useEffect(() => {
    animate(ring.current, [{ transform: "translate(-50%, -50%) scale(0.4)" }, { transform: "translate(-50%, -50%) scale(1.7)" }], {
      duration: 600,
      easing: "cubic-bezier(.2,.7,.3,1)",
      fill: "forwards"
    });
  }, []);
  const tone = toneOf(mark, mark.kind === "click" ? mark.button : "left");
  const count = mark.kind === "click" && mark.count > 1 ? mark.count : null;
  const hollow = mark.kind === "press" && !mark.down;
  return (
    <div ref={root} className="absolute" style={{ left: mark.at.x, top: mark.at.y }}>
      <span className={cn("absolute left-0 top-0 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2", tone.ring, !hollow && tone.fill)}>
        {count ? <span className={cn("text-[10px] font-semibold leading-none", tone.text)}>{count}</span> : null}
      </span>
      <span ref={ring} className={cn("absolute left-0 top-0 h-10 w-10 rounded-full border opacity-70", tone.ring)} style={{ transform: "translate(-50%, -50%)" }} />
      <span className="absolute bottom-4 left-0 -translate-x-1/2">
        <Chip text={mark.label} className={tone.chip} />
      </span>
    </div>
  );
}

function MoveMark({ mark }: { mark: Extract<DesktopOverlayMark, { kind: "move" }> }) {
  const root = useFade<HTMLSpanElement>();
  const tone = toneOf(mark);
  return <span ref={root} className={cn("absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border", tone.ring, tone.fill)} style={{ left: mark.at.x, top: mark.at.y }} />;
}

function DragMark({ mark }: { mark: Extract<DesktopOverlayMark, { kind: "drag" }> }) {
  const root = useFade<SVGSVGElement>();
  const line = React.useRef<SVGLineElement | null>(null);
  React.useEffect(() => {
    animate(line.current, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 450, easing: "ease-out", fill: "forwards" });
  }, []);
  const { from, to } = mark;
  return (
    <svg ref={root} className={cn("absolute inset-0 h-full w-full overflow-visible", toneOf(mark).text)}>
      <line ref={line} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="currentColor" strokeWidth={5} strokeLinecap="round" strokeOpacity={0.55} pathLength={1} strokeDasharray="1" />
      <circle cx={from.x} cy={from.y} r={5} fill="currentColor" fillOpacity={0.35} />
      <circle cx={to.x} cy={to.y} r={7} fill="currentColor" fillOpacity={0.85} />
    </svg>
  );
}

const CHEVRON_TURN = { up: 0, right: 90, down: 180, left: 270 } as const;

function ScrollMark({ mark }: { mark: Extract<DesktopOverlayMark, { kind: "scroll" }> }) {
  const root = useFade<HTMLDivElement>();
  const arrows = React.useRef<HTMLDivElement | null>(null);
  const vertical = mark.direction === "up" || mark.direction === "down";
  const sign = mark.direction === "up" || mark.direction === "left" ? -1 : 1;
  React.useEffect(() => {
    const shift = (px: number) => (vertical ? `translateY(${px * sign}px)` : `translateX(${px * sign}px)`);
    animate(arrows.current, [{ transform: shift(-6) }, { transform: shift(6) }], { duration: 700, easing: "ease-out", fill: "forwards" });
  }, [vertical, sign]);
  const tone = toneOf(mark);
  const style: React.CSSProperties = mark.at ? { left: mark.at.x, top: mark.at.y } : { left: "50%", top: "50%" };
  return (
    <div ref={root} className="absolute -translate-x-1/2 -translate-y-1/2" style={style}>
      <div ref={arrows} className={cn("flex h-10 w-10 items-center justify-center rounded-full bg-neutral-950/70 ring-1", tone.text, mark.failed ? "ring-danger/40" : "ring-warn-500/40")}>
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" style={{ transform: `rotate(${CHEVRON_TURN[mark.direction]}deg)` }}>
          <path d="M4 8.5 9 3.5l5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 14 9 9l5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeOpacity="0.55" />
        </svg>
      </div>
    </div>
  );
}

function BubbleMark({ mark, icon, text }: { mark: DesktopOverlayMark; icon: string; text: string }) {
  const root = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    animate(root.current, FADE.map((frame, index) => ({ ...frame, transform: index === 0 ? "translate(-50%, 6px)" : "translate(-50%, 0)" })), {
      duration: DESKTOP_MARK_MS,
      fill: "forwards"
    });
  }, []);
  const at = "at" in mark ? mark.at : null;
  return (
    <div
      ref={root}
      className="absolute"
      style={at ? { left: at.x, top: at.y + 14, transform: "translate(-50%, 0)" } : { left: "50%", bottom: 16, transform: "translate(-50%, 0)" }}
    >
      <span
        className={cn(
          "inline-flex max-w-[20rem] items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1 text-[12px] shadow-lg ring-1",
          mark.failed ? "bg-danger-soft text-danger ring-danger/40" : "bg-neutral-950/90 text-neutral-100 ring-warn-500/40"
        )}
      >
        <span className={mark.failed ? "text-danger" : "text-warn"}>{icon}</span>
        <span className="truncate">{text}</span>
      </span>
    </div>
  );
}

function LabelMark({ mark }: { mark: Extract<DesktopOverlayMark, { kind: "label" }> }) {
  const root = useFade<HTMLDivElement>();
  return (
    <div ref={root} className="absolute left-1/2 top-3 -translate-x-1/2">
      <Chip text={mark.label} className={toneOf(mark).chip} />
    </div>
  );
}

function Mark({ mark }: { mark: DesktopOverlayMark }) {
  switch (mark.kind) {
    case "click":
    case "press":
      return <ClickMark mark={mark} />;
    case "move":
      return <MoveMark mark={mark} />;
    case "drag":
      return <DragMark mark={mark} />;
    case "scroll":
      return <ScrollMark mark={mark} />;
    case "text":
      return <BubbleMark mark={mark} icon="⌨" text={`“${mark.text}”`} />;
    case "key":
      return <BubbleMark mark={mark} icon="⌘" text={mark.label} />;
    case "label":
      return <LabelMark mark={mark} />;
  }
}

/** At most this many marks at once (a burst of moves must not pile up). */
const MAX_MARKS = 8;

export interface DesktopAgentOverlayProps {
  entries: readonly DesktopActionEntry[];
  /** Display pixels → this overlay's pixels (null: the mark's label alone). */
  mapPoint: MapDisplayPoint;
  /** Off while the view shows nothing: entries seen then never animate. */
  active: boolean;
}

export function DesktopAgentOverlay({ entries, mapPoint, active }: DesktopAgentOverlayProps): React.ReactElement | null {
  const seen = React.useRef<Set<string> | null>(null);
  const [marks, setMarks] = React.useState<DesktopOverlayMark[]>([]);
  const mapRef = React.useRef(mapPoint);
  mapRef.current = mapPoint;
  const timers = React.useRef(new Set<ReturnType<typeof setTimeout>>());

  React.useEffect(() => {
    // The first look (and every look while inactive) only records what is there.
    if (seen.current === null || !active) {
      seen.current = new Set(entries.map((entry) => entry.id));
      return;
    }
    const fresh = newDesktopEntries(entries, seen.current);
    if (fresh.length === 0) return;
    for (const entry of fresh) seen.current.add(entry.id);
    const next = fresh
      .slice(-MAX_MARKS)
      .map((entry) => desktopOverlayMark(entry, mapRef.current))
      .filter((mark): mark is DesktopOverlayMark => mark !== null);
    if (next.length === 0) return;
    setMarks((current) => [...current, ...next].slice(-MAX_MARKS));
    const ids = new Set(next.map((mark) => mark.id));
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setMarks((current) => current.filter((mark) => !ids.has(mark.id)));
    }, DESKTOP_MARK_MS);
    timers.current.add(timer);
  }, [entries, active]);

  React.useEffect(() => {
    if (!active) setMarks([]);
  }, [active]);

  React.useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
      timers.current.clear();
    },
    []
  );

  if (marks.length === 0) return null;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-10 overflow-hidden" data-desktop-agent-overlay="">
      {marks.map((mark) => (
        <Mark key={mark.id} mark={mark} />
      ))}
    </div>
  );
}
