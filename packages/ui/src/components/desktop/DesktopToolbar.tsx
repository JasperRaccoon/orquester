import React, { useRef, useState } from "react";
import {
  AppWindow, Check, Clipboard, Copy, Info, Keyboard, LayoutGrid, Maximize2, Monitor, MoreHorizontal,
  Plus, Power, RotateCw, Volume2, VolumeX, X
} from "lucide-react";
import type { DesktopSummary, DesktopWindow, DesktopWindowAction } from "@orquester/api";
import type { DesktopAudioState } from "../../lib/desktop-audio";
import { DESKTOP_FIXED_SIZES, type DesktopPrefs } from "../../lib/desktop-prefs";
import { cn } from "../../lib/cn";
import { AdaptiveMenu } from "../ui/adaptive-menu";
import { BottomSheet } from "../ui/sheet";
import { ContextMenu } from "../ui/context-menu";
import { Dropdown, DropdownItem, DropdownLabel, DropdownSeparator } from "../ui/dropdown";
import { IconButton } from "../ui/icon-button";

/** Toolbar icon look for triggers that are wrapped in a menu's own <button>. */
const TRIGGER_CLASS =
  "inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100";

function windowInitial(win: DesktopWindow): string {
  const source = win.wmClass?.trim() || win.title.trim();
  return (source.charAt(0) || "?").toUpperCase();
}

function windowLabel(win: DesktopWindow): string {
  return win.title.trim() || win.wmClass || "Untitled window";
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

const LONG_PRESS_MS = 500;

const WindowPill: React.FC<{
  win: DesktopWindow;
  active: boolean;
  onAction: (action: DesktopWindowAction) => void;
  onMenu: (x: number, y: number) => void;
}> = ({ win, active, onAction, onMenu }) => {
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  return (
    <button
      type="button"
      title={`${windowLabel(win)} — right-click or long-press for more`}
      aria-pressed={active}
      onClick={() => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        onAction("activate");
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        cancelPress();
        onMenu(e.clientX, e.clientY);
      }}
      onPointerDown={(e) => {
        if (e.pointerType !== "touch") return;
        const { clientX: x, clientY: y } = e;
        cancelPress();
        press.current = {
          x,
          y,
          timer: setTimeout(() => {
            press.current = null;
            suppressClick.current = true;
            onMenu(x, y);
          }, LONG_PRESS_MS)
        };
      }}
      onPointerMove={(e) => {
        const p = press.current;
        if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) cancelPress();
      }}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      className={cn(
        "flex h-7 min-w-0 max-w-[12rem] shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
        active
          ? "border-neutral-600 bg-neutral-800 text-neutral-100"
          : "border-transparent text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
      )}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-neutral-700 text-[10px] font-semibold text-neutral-200">
        {windowInitial(win)}
      </span>
      <span className="truncate">{windowLabel(win)}</span>
    </button>
  );
};

export const DesktopWindows: React.FC<{
  desktop: DesktopSummary;
  narrow: boolean;
  onAction: (win: DesktopWindow, action: DesktopWindowAction) => void;
}> = ({ desktop, narrow, onAction }) => {
  const [menu, setMenu] = useState<{ x: number; y: number; win: DesktopWindow } | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const windows = desktop.windows;

  if (narrow) {
    return (
      <>
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          disabled={windows.length === 0}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
        >
          <LayoutGrid size={14} />
          Windows ({windows.length})
        </button>
        <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Windows">
          {windows.map((win) => (
            <div key={win.id} className="flex items-center gap-1 py-0.5">
              <button
                type="button"
                onClick={() => {
                  onAction(win, "activate");
                  setSheetOpen(false);
                }}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2.5 text-left",
                  win.id === desktop.activeWindowId ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:bg-neutral-800"
                )}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-neutral-700 text-xs font-semibold">
                  {windowInitial(win)}
                </span>
                <span className="truncate">{windowLabel(win)}</span>
              </button>
              <IconButton label="Maximize" className="h-10 w-10" onClick={() => onAction(win, "maximize")}>
                <Maximize2 size={16} />
              </IconButton>
              <IconButton label="Close window" className="h-10 w-10" onClick={() => onAction(win, "close")}>
                <X size={16} />
              </IconButton>
            </div>
          ))}
          {windows.length === 0 && <p className="px-2 py-3 text-sm text-neutral-500">No windows open.</p>}
        </BottomSheet>
      </>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="toolbar" aria-label="Windows">
      {windows.length === 0 && <span className="truncate px-1 text-xs text-neutral-600">No windows</span>}
      {windows.map((win) => (
        <WindowPill
          key={win.id}
          win={win}
          active={win.id === desktop.activeWindowId}
          onAction={(action) => onAction(win, action)}
          onMenu={(x, y) => setMenu({ x, y, win })}
        />
      ))}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Activate", icon: <AppWindow size={14} />, onClick: () => onAction(menu.win, "activate") },
            { label: "Maximize", icon: <Maximize2 size={14} />, onClick: () => onAction(menu.win, "maximize") },
            { label: "Close", icon: <X size={14} />, danger: true, onClick: () => onAction(menu.win, "close") }
          ]}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Sound
// ---------------------------------------------------------------------------

export function audioUnavailableReason(desktop: DesktopSummary, audio: DesktopAudioState): string | null {
  if (desktop.audio === "unavailable") return "Sound is unavailable for this desktop (no PulseAudio or ffmpeg on the host)";
  if (audio.decoder === "none") return "This browser can't decode the desktop's Opus audio";
  if (audio.serverState?.audio === "unavailable") return audio.serverState.reason ?? "The desktop's audio stream is unavailable";
  return null;
}

export const DesktopSound: React.FC<{
  desktop: DesktopSummary;
  audio: DesktopAudioState;
  prefs: DesktopPrefs;
  onPrefs: (patch: Partial<DesktopPrefs>) => void;
  compact: boolean;
}> = ({ desktop, audio, prefs, onPrefs, compact }) => {
  const reason = audioUnavailableReason(desktop, audio);
  if (reason) {
    return (
      <span title={reason} className="inline-flex">
        <IconButton label={reason} disabled className="pointer-events-none opacity-40">
          <VolumeX size={14} />
        </IconButton>
      </span>
    );
  }
  if (!audio.unlocked) {
    return (
      <button
        type="button"
        title="Enable sound"
        // unlock() must run inside the click: browsers only let a user gesture
        // start an AudioContext.
        onClick={() => void audio.unlock()}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
      >
        <Volume2 size={14} />
        {!compact && <span>Enable sound</span>}
      </button>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-1" title={audio.error ?? undefined}>
      <IconButton
        label={prefs.muted ? "Unmute" : "Mute"}
        aria-pressed={prefs.muted}
        onClick={() => onPrefs({ muted: !prefs.muted })}
        className={cn(audio.error && "text-warn-500")}
      >
        {prefs.muted || prefs.volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
      </IconButton>
      {!compact && (
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={prefs.volume}
          aria-label="Volume"
          onChange={(e) => onPrefs({ volume: Number(e.target.value), muted: false })}
          className="h-1 w-20 cursor-pointer accent-neutral-300"
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export const DesktopViewMenu: React.FC<{
  prefs: DesktopPrefs;
  onPrefs: (patch: Partial<DesktopPrefs>) => void;
}> = ({ prefs, onPrefs }) => {
  const fixed = prefs.view === "fixed" ? prefs.fixedSize : undefined;
  const mode = prefs.fixedMode ?? "scale";
  const mark = (on: boolean) => (on ? <Check size={14} /> : <span />);
  return (
    <AdaptiveMenu
      title="View"
      align="right"
      width="w-60"
      trigger={
        <span className={TRIGGER_CLASS} title="View" aria-label="View">
          <Monitor size={14} />
        </span>
      }
    >
      <DropdownLabel>Display size</DropdownLabel>
      <DropdownItem icon={mark(prefs.view === "fit")} onClick={() => onPrefs({ view: "fit" })}>
        Fit to tab
      </DropdownItem>
      {DESKTOP_FIXED_SIZES.map((size) => (
        <DropdownItem
          key={`${size.width}x${size.height}`}
          icon={mark(fixed?.width === size.width && fixed.height === size.height)}
          onClick={() => onPrefs({ view: "fixed", fixedSize: { ...size }, fixedMode: mode })}
        >
          Fixed {size.width} × {size.height}
        </DropdownItem>
      ))}
      <DropdownSeparator />
      <DropdownLabel>Fixed display</DropdownLabel>
      <DropdownItem
        icon={mark(prefs.view === "fixed" && mode === "scale")}
        disabled={prefs.view !== "fixed"}
        onClick={() => onPrefs({ fixedMode: "scale" })}
      >
        Scale to fit
      </DropdownItem>
      <DropdownItem
        icon={mark(prefs.view === "fixed" && mode === "pan")}
        disabled={prefs.view !== "fixed"}
        onClick={() => onPrefs({ fixedMode: "pan" })}
      >
        Actual size (drag to pan)
      </DropdownItem>
    </AdaptiveMenu>
  );
};

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

export const DesktopClipboard: React.FC<{
  remoteText: string | null;
  connected: boolean;
  onSend: (text: string) => void;
}> = ({ remoteText, connected, onSend }) => {
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  return (
    <Dropdown
      role="dialog"
      ariaLabel="Clipboard"
      align="right"
      width="w-80"
      trigger={
        <span className={TRIGGER_CLASS} title="Clipboard" aria-label="Clipboard">
          <Clipboard size={14} />
        </span>
      }
    >
      <div className="flex flex-col gap-2 p-1 text-xs">
        <div className="flex items-center justify-between">
          <span className="font-medium uppercase tracking-wider text-neutral-500">From desktop</span>
          <button
            type="button"
            disabled={!remoteText}
            onClick={() => {
              if (!remoteText) return;
              void navigator.clipboard?.writeText(remoteText).then(
                () => setCopied(true),
                () => setCopied(false)
              );
            }}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <pre className="max-h-32 min-h-[2.5rem] overflow-auto whitespace-pre-wrap break-words rounded border border-neutral-800 bg-neutral-950 p-2 font-mono text-[11px] text-neutral-300">
          {remoteText || <span className="italic text-neutral-600">Nothing copied on the desktop yet.</span>}
        </pre>
        <span className="font-medium uppercase tracking-wider text-neutral-500">Send to desktop</span>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          placeholder="Text for the desktop's clipboard"
          className="w-full resize-y rounded border border-neutral-700 bg-neutral-900 p-2 font-mono text-[11px] text-neutral-200 outline-none focus:border-neutral-500"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-neutral-500">Then paste in the app with Ctrl+V.</span>
          <button
            type="button"
            disabled={!draft || !connected}
            onClick={() => {
              onSend(draft);
              setCopied(false);
            }}
            className="shrink-0 rounded-md bg-neutral-200 px-2.5 py-1 font-medium text-neutral-900 hover:bg-neutral-50 disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </Dropdown>
  );
};

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

export interface DesktopToolbarProps {
  desktop: DesktopSummary;
  narrow: boolean;
  touch: boolean;
  prefs: DesktopPrefs;
  onPrefs: (patch: Partial<DesktopPrefs>) => void;
  audio: DesktopAudioState;
  connected: boolean;
  remoteClipboard: string | null;
  keyboardOpen: boolean;
  onToggleKeyboard: () => void;
  onSendClipboard: (text: string) => void;
  onWindowAction: (win: DesktopWindow, action: DesktopWindowAction) => void;
  onLaunchApp: () => void;
  onOpenApps: () => void;
  onOpenInfo: () => void;
  onRestart: () => void;
  onStop: () => void;
  onCloseTab: () => void;
}

export const DesktopToolbar: React.FC<DesktopToolbarProps> = (props) => {
  const { desktop, narrow, prefs, onPrefs, audio } = props;
  const runningApps = desktop.apps.filter((a) => a.status !== "exited").length;
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-neutral-800 bg-neutral-900/40 px-2">
      <DesktopWindows desktop={desktop} narrow={narrow} onAction={props.onWindowAction} />
      {narrow && <div className="flex-1" />}
      <IconButton label="Launch app in this desktop" onClick={props.onLaunchApp}>
        <Plus size={14} />
      </IconButton>
      <DesktopSound desktop={desktop} audio={audio} prefs={prefs} onPrefs={onPrefs} compact={narrow} />
      <DesktopViewMenu prefs={prefs} onPrefs={onPrefs} />
      {props.touch && (
        // Focusing inside a button CLICK is the trusted-gesture path iOS
        // reliably raises the soft keyboard for.
        <IconButton
          label={props.keyboardOpen ? "Hide keyboard" : "Show keyboard"}
          aria-pressed={props.keyboardOpen}
          // Don't take focus from the hidden input: the toggle reads it.
          onPointerDown={(e) => e.preventDefault()}
          onClick={props.onToggleKeyboard}
          className={cn(props.keyboardOpen && "bg-neutral-800 text-neutral-100")}
        >
          <Keyboard size={14} />
        </IconButton>
      )}
      <DesktopClipboard remoteText={props.remoteClipboard} connected={props.connected} onSend={props.onSendClipboard} />
      <AdaptiveMenu
        title={desktop.title}
        align="right"
        width="w-56"
        trigger={
          <span className={TRIGGER_CLASS} title="More" aria-label="More">
            <MoreHorizontal size={14} />
          </span>
        }
      >
        <DropdownItem icon={<AppWindow size={14} />} onClick={props.onOpenApps}>
          Apps ({runningApps} running)…
        </DropdownItem>
        <DropdownItem icon={<Info size={14} />} onClick={props.onOpenInfo}>
          Info…
        </DropdownItem>
        <DropdownSeparator />
        <DropdownItem icon={<RotateCw size={14} />} onClick={props.onRestart} disabled={desktop.status === "starting"}>
          Restart desktop
        </DropdownItem>
        <DropdownItem icon={<Power size={14} />} onClick={props.onStop} disabled={desktop.status === "stopped"}>
          Stop desktop
        </DropdownItem>
        <DropdownSeparator />
        <DropdownItem icon={<X size={14} />} onClick={props.onCloseTab}>
          Close tab
        </DropdownItem>
      </AdaptiveMenu>
    </div>
  );
};
