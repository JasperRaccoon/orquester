import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, ArrowRight, Crosshair, Monitor, RotateCw, ShieldAlert, Smartphone
} from "lucide-react";
import type { BrowserPickPayload, BrowserStateMessage, BrowserSummary } from "@orquester/api";
import { useAppStore } from "../../store/app";
import { cn } from "../../lib/cn";
import { PickComposeSheet } from "./PickComposeSheet";

const VIEWPORT = { desktop: { w: 1280, h: 800 }, mobile: { w: 390, h: 844 } } as const;

/** CDP Input modifier bits: 1=Alt, 2=Ctrl, 4=Meta, 8=Shift. */
function modifiersOf(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

export const BrowserView: React.FC<{ browser: BrowserSummary; active: boolean }> = ({ browser, active }) => {
  const api = useAppStore((s) => s.api);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<BrowserStateMessage | null>(null);
  const [urlDraft, setUrlDraft] = useState(browser.url === "about:blank" ? "" : browser.url);
  const [urlFocused, setUrlFocused] = useState(false);
  // Live focus mirror read inside onState (which closes over stale urlFocused
  // because the subscribe effect deliberately doesn't re-run on focus changes).
  const urlFocusedRef = useRef(false);
  // Monotonic frame counters for latest-frame-wins: async JPEG decodes can
  // finish out of order, so an older frame must never paint over a newer one.
  const frameSeq = useRef(0);
  const lastDrawnSeq = useRef(0);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  // Picks accumulate into one batch ("Pick another" re-arms) and send together.
  const [picks, setPicks] = useState<BrowserPickPayload[]>([]);
  const [zoom, setZoom] = useState({ scale: 1, tx: 0, ty: 0 });
  const gesture = useRef<{ dist: number; scale: number; tx: number; ty: number; cx: number; cy: number } | null>(null);

  const channel = useMemo(() => api?.browserChannel(), [api]);
  const vp = VIEWPORT[state?.viewportMode ?? browser.viewportMode];

  // Subscribe while active; the canvas keeps its last frame when hidden (grid
  // view shows it frozen). No replay semantic: resubscribe re-primes.
  useEffect(() => {
    if (!channel || !active) return;
    const handle = channel.open(browser.id, {
      onFrame: (jpeg) => {
        const seq = ++frameSeq.current;
        void createImageBitmap(new Blob([jpeg], { type: "image/jpeg" })).then((bmp) => {
          // Drop a frame whose decode lost the race to a newer one, and read the
          // canvas fresh — it remounts as a new node after a crash → Relaunch.
          if (seq < lastDrawnSeq.current) { bmp.close(); return; }
          const canvas = canvasRef.current;
          const ctx = canvas?.getContext("2d");
          if (!canvas || !ctx) { bmp.close(); return; }
          if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
            canvas.width = bmp.width;
            canvas.height = bmp.height;
          }
          ctx.drawImage(bmp, 0, 0);
          lastDrawnSeq.current = seq;
          bmp.close();
        });
      },
      onState: (s) => {
        setState(s);
        if (!urlFocusedRef.current) setUrlDraft(s.url === "about:blank" ? "" : s.url);
      },
      onPicked: (payload) => { setPicking(false); setPicks((prev) => [...prev, payload]); },
      onEnd: () => {}
    });
    return () => handle.close();
    // urlFocused deliberately omitted: resubscribing on focus would flash the stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, browser.id, active]);

  // Client coords → server-viewport CSS pixels through letterbox scale + zoom.
  const toPage = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect(); // includes the zoom transform
    // The canvas element box can be a different aspect than the raster: `h-full`
    // makes height definite while `max-w-full` clamps width, so `object-contain`
    // letterboxes the drawn image inside the box (common in mobile-portrait with
    // the wide desktop viewport). Map against the actual contained image rect, not
    // the full element box, or taps land on the wrong element. The zoom transform
    // scales box + letterbox uniformly, so ratios computed from the transformed
    // rect stay exact.
    const boxAspect = rect.width / rect.height;
    const imgAspect = vp.w / vp.h;
    let imgW = rect.width;
    let imgH = rect.height;
    let padX = 0;
    let padY = 0;
    if (boxAspect > imgAspect) {
      imgW = rect.height * imgAspect; // height-limited: pillarbox left/right
      padX = (rect.width - imgW) / 2;
    } else {
      imgH = rect.width / imgAspect; // width-limited: letterbox top/bottom
      padY = (rect.height - imgH) / 2;
    }
    const x = ((clientX - rect.left - padX) / imgW) * vp.w;
    const y = ((clientY - rect.top - padY) / imgH) * vp.h;
    if (x < 0 || y < 0 || x > vp.w || y > vp.h) return null;
    return { x: Math.round(x), y: Math.round(y) };
  }, [vp.w, vp.h]);

  const send = channel?.send.bind(channel);

  const onPointer = (kind: "move" | "down" | "up") => (e: React.PointerEvent) => {
    if (e.pointerType === "touch") return; // touch goes through onTouch* below
    const p = toPage(e.clientX, e.clientY);
    if (!p || !send) return;
    if (kind === "down") { canvasRef.current?.focus(); hiddenInputRef.current?.focus({ preventScroll: true }); }
    const button = e.button === 2 ? "right" : e.button === 1 ? "middle" : kind === "move" && e.buttons === 0 ? "none" : "left";
    send({ t: "pointer", id: browser.id, kind, x: p.x, y: p.y, button, modifiers: modifiersOf(e), clickCount: 1 });
  };

  const onWheel = (e: React.WheelEvent) => {
    const p = toPage(e.clientX, e.clientY);
    if (p && send) send({ t: "wheel", id: browser.id, x: p.x, y: p.y, dx: e.deltaX, dy: e.deltaY });
  };

  // Touch: 1 finger → forwarded taps/drags; 2 fingers → client-side pinch/pan.
  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      gesture.current = {
        dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        scale: zoom.scale, tx: zoom.tx, ty: zoom.ty,
        cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2
      };
      return;
    }
    const t = e.touches[0];
    const p = t && toPage(t.clientX, t.clientY);
    if (p && send) send({ t: "touch", id: browser.id, kind: "start", points: [p] });
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && gesture.current) {
      e.preventDefault();
      const [a, b] = [e.touches[0], e.touches[1]];
      const g = gesture.current;
      const scale = Math.min(4, Math.max(1, g.scale * (Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / g.dist)));
      const cx = (a.clientX + b.clientX) / 2, cy = (a.clientY + b.clientY) / 2;
      setZoom({ scale, tx: g.tx + cx - g.cx, ty: g.ty + cy - g.cy });
      return;
    }
    const t = e.touches[0];
    const p = t && toPage(t.clientX, t.clientY);
    if (p && send) send({ t: "touch", id: browser.id, kind: "move", points: [p] });
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (gesture.current) {
      if (e.touches.length < 2) gesture.current = null;
      if (zoom.scale <= 1.02) setZoom({ scale: 1, tx: 0, ty: 0 });
      return;
    }
    send?.({ t: "touch", id: browser.id, kind: "end", points: [] });
    hiddenInputRef.current?.focus({ preventScroll: true });
  };

  const onKey = (kind: "down" | "up") => (e: React.KeyboardEvent) => {
    if (!send) return;
    e.preventDefault();
    send({ t: "key", id: browser.id, kind, key: e.key, code: e.code, modifiers: modifiersOf(e) });
    if (kind === "down" && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      send({ t: "key", id: browser.id, kind: "char", key: e.key, code: e.code, text: e.key, modifiers: modifiersOf(e) });
    }
  };

  const navigate = (action: "goto" | "back" | "forward" | "reload", url?: string) =>
    send?.({ t: "nav", id: browser.id, action, url });

  const togglePick = () => {
    const on = !picking;
    setPicking(on);
    send?.({ t: "pick", id: browser.id, on });
  };

  const loadSuggestions = () => {
    void api?.browserSuggestions(browser.projectPath).then((r) => setSuggestions(r.urls)).catch(() => undefined);
  };

  return (
    <div className="flex h-full w-full flex-col bg-neutral-950">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-neutral-800 bg-neutral-900/40 px-2">
        <button type="button" aria-label="Back" disabled={!state?.canGoBack} onClick={() => navigate("back")}
          className="rounded p-1 text-neutral-400 enabled:hover:bg-neutral-800 disabled:opacity-40">
          <ArrowLeft size={14} />
        </button>
        <button type="button" aria-label="Forward" disabled={!state?.canGoForward} onClick={() => navigate("forward")}
          className="rounded p-1 text-neutral-400 enabled:hover:bg-neutral-800 disabled:opacity-40">
          <ArrowRight size={14} />
        </button>
        <button type="button" aria-label="Reload" onClick={() => navigate("reload")}
          className={cn("rounded p-1 text-neutral-400 hover:bg-neutral-800", state?.loading && "animate-spin")}>
          <RotateCw size={14} />
        </button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => { e.preventDefault(); if (urlDraft.trim()) navigate("goto", urlDraft.trim()); }}
        >
          <input
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onFocus={() => { urlFocusedRef.current = true; setUrlFocused(true); loadSuggestions(); }}
            onBlur={() => { urlFocusedRef.current = false; setUrlFocused(false); }}
            list={`browser-suggestions-${browser.id}`}
            placeholder="Enter URL (e.g. localhost:5173)"
            spellCheck={false} autoCapitalize="off" autoCorrect="off"
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-neutral-500"
          />
          <datalist id={`browser-suggestions-${browser.id}`}>
            {suggestions.map((url) => <option key={url} value={url} />)}
          </datalist>
        </form>
        <button type="button" aria-label="Toggle viewport"
          onClick={() => send?.({ t: "viewport", id: browser.id, mode: (state?.viewportMode ?? browser.viewportMode) === "desktop" ? "mobile" : "desktop" })}
          className="rounded p-1 text-neutral-400 hover:bg-neutral-800">
          {(state?.viewportMode ?? browser.viewportMode) === "desktop" ? <Monitor size={14} /> : <Smartphone size={14} />}
        </button>
        <button type="button" aria-label="Pick element" onClick={togglePick}
          className={cn("rounded p-1 hover:bg-neutral-800", picking ? "text-sky-400" : "text-neutral-400")}>
          <Crosshair size={14} />
        </button>
        {state && !state.sandboxed && (
          <span title="Chromium is running without its sandbox on this host">
            <ShieldAlert size={14} className="text-amber-500" />
          </span>
        )}
      </div>

      <div ref={wrapRef} className="relative min-h-0 flex-1 touch-none overflow-hidden"
        onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
        {!channel ? (
          // No screencast transport (e.g. the desktop unix socket): the browser
          // record exists on the daemon but no frames can stream, so explain
          // instead of showing a silent blank canvas.
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-neutral-400">
            <span>Browser tabs require a remote (HTTP) connection.</span>
          </div>
        ) : state?.status === "crashed" || state?.status === "error" ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-neutral-400">
            <span>{state.status === "crashed" ? "Browser crashed" : (browser.errorMessage ?? "Browser failed to start")}</span>
            <button type="button" onClick={() => navigate("reload")}
              className="rounded border border-neutral-700 px-3 py-1 text-xs hover:bg-neutral-800">
              Relaunch
            </button>
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            tabIndex={0}
            onPointerMove={onPointer("move")} onPointerDown={onPointer("down")} onPointerUp={onPointer("up")}
            onWheel={onWheel} onKeyDown={onKey("down")} onKeyUp={onKey("up")}
            onContextMenu={(e) => e.preventDefault()}
            className="mx-auto block h-full max-w-full object-contain outline-none"
            style={{
              aspectRatio: `${vp.w} / ${vp.h}`,
              transform: zoom.scale !== 1 ? `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})` : undefined,
              transformOrigin: "0 0"
            }}
          />
        )}
        {/* Off-screen input: keeps the mobile soft keyboard up; keystrokes forward as CDP keys. */}
        <input
          ref={hiddenInputRef}
          aria-hidden
          className="absolute -left-[9999px] top-0 h-px w-px opacity-0"
          autoCapitalize="off" autoCorrect="off"
          onKeyDown={onKey("down")} onKeyUp={onKey("up")}
          onChange={(e) => { e.target.value = ""; }}
        />
        {picks.length > 0 && (
          <PickComposeSheet
            payloads={picks}
            projectPath={browser.projectPath}
            onRemove={(index) => setPicks((prev) => prev.filter((_, i) => i !== index))}
            onPickAnother={() => {
              setPicking(true);
              send?.({ t: "pick", id: browser.id, on: true });
            }}
            onClose={() => setPicks([])}
          />
        )}
      </div>
    </div>
  );
};
