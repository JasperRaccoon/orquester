import { useEffect, useMemo, useRef, useState } from "react";
import {
  deviceScreenAspect,
  flatDeviceGeometry,
  flatDeviceScale,
  flatMediaRotation,
  flatMediaStyle,
  flatScreenPoint,
  type Size,
} from "./flat.ts";
import type { DeviceShapeProfile } from "./shapeProfile.ts";
import type { DeviceOrientation, DevicePlatform } from "./types.ts";

// The procedural body's colours (phoneScene): polished metal edge, dark front glass.
const METAL = "#b5bcc7";
const GLASS = "#141820";

/**
 * The stream canvas in a 2D bezel. While mounted it holds `source` in its own DOM; the canvas
 * keeps drawing itself, so frames need no copy.
 */
export function DeviceFlatViewport(props: {
  readonly source: HTMLCanvasElement | null;
  readonly platform: DevicePlatform;
  /** Raw frame size in device pixels, or null before the first frame. */
  readonly frame: Size | null;
  readonly orientation: DeviceOrientation;
  readonly profile: DeviceShapeProfile;
  readonly onTouch: (phase: "begin" | "move" | "end", x: number, y: number) => void;
}) {
  const { source, platform, frame, orientation, profile, onTouch } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mediaRef = useRef<HTMLDivElement | null>(null);
  const active = useRef<{ id: number; x: number; y: number } | null>(null);
  const [host, setHost] = useState<Size>({ width: 0, height: 0 });
  const sized = host.width > 0 && host.height > 0;

  useEffect(() => {
    const node = hostRef.current;
    if (!node) return;
    const update = () => {
      const { width, height } = node.getBoundingClientRect();
      setHost((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
    };
    update();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = mediaRef.current;
    if (!node || !source) return;
    const previousStyle = source.style.cssText;
    source.style.cssText = "display:block;width:100%;height:100%;";
    node.append(source);
    return () => {
      if (source.parentElement === node) source.remove();
      source.style.cssText = previousStyle;
    };
    // The media box exists only once the host has a size: attach then too.
  }, [source, sized]);

  const aspect = deviceScreenAspect(platform, frame, orientation);
  const geometry = useMemo(
    () => flatDeviceGeometry(profile, aspect, orientation),
    [profile, aspect, orientation],
  );
  const scale = flatDeviceScale(geometry, host);
  const px = (units: number) => units * scale;
  const screen = { width: px(geometry.screen.width), height: px(geometry.screen.height) };
  const media = flatMediaStyle(screen, flatMediaRotation(platform, frame, orientation));

  const point = (event: React.PointerEvent<HTMLElement>, captured: boolean) =>
    flatScreenPoint(
      event.currentTarget.getBoundingClientRect(),
      event.clientX,
      event.clientY,
      captured,
    );
  const end = (event: React.PointerEvent<HTMLElement>, moved: boolean) => {
    const current = active.current;
    if (current?.id !== event.pointerId) return;
    active.current = null;
    const last = (moved && point(event, true)) || current;
    onTouch("end", last.x, last.y);
  };

  return (
    <div ref={hostRef} className="absolute inset-0 flex items-center justify-center">
      {scale > 0 ? (
        <div
          className="relative shrink-0"
          style={{
            width: px(geometry.width),
            height: px(geometry.height),
            borderRadius: px(geometry.bodyRadius),
            background: GLASS,
            boxShadow: `0 0 0 ${Math.max(1, px(0.012))}px ${METAL}, 0 12px 32px rgba(0,0,0,0.45)`,
          }}
        >
          {geometry.buttons.map((button, index) => (
            <div
              key={index}
              aria-hidden
              className="pointer-events-none absolute"
              style={{
                left: px(button.x),
                top: px(button.y),
                width: px(button.width),
                height: px(button.height),
                borderRadius: px(0.01),
                background: METAL,
              }}
            />
          ))}
          <div
            data-device-flat-screen=""
            className="absolute touch-none select-none overflow-hidden bg-black"
            style={{
              left: px(geometry.screen.x),
              top: px(geometry.screen.y),
              width: screen.width,
              height: screen.height,
              borderRadius: px(geometry.screenRadius),
            }}
            onPointerDown={(event) => {
              if (event.button !== 0 || active.current) return;
              const touch = point(event, false);
              if (!touch) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              (event.currentTarget.closest("[data-device-view]") as HTMLElement | null)?.focus();
              active.current = { id: event.pointerId, ...touch };
              onTouch("begin", touch.x, touch.y);
            }}
            onPointerMove={(event) => {
              if (active.current?.id !== event.pointerId) return;
              const touch = point(event, true);
              if (!touch) return;
              active.current = { id: event.pointerId, ...touch };
              onTouch("move", touch.x, touch.y);
            }}
            onPointerUp={(event) => end(event, true)}
            onPointerCancel={(event) => end(event, false)}
            onLostPointerCapture={(event) => end(event, false)}
          >
            <div ref={mediaRef} className="absolute" style={media} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
