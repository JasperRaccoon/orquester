import React, { useEffect, useState, useRef } from "react";
import { ClipboardPaste, Loader2, Lock, Paperclip } from "lucide-react";
import { useApi } from "../../context/orquester-context";
import { useIsDesktop } from "../../hooks";
import { useActiveTabId, useAppStore, useProjectTabs, useTerminalFontSize } from "../../store/app";
import { uploadFilesToSession, type UploadStatus } from "../../lib/session-upload";
import { isLegacyAgentTerminal } from "../../lib/session-kind";
import { UploadProgressBar } from "../ui/upload-progress";
import { pasteTextForSession } from "../../lib/paste";
import { TERMINAL_FONT_MIN, TERMINAL_FONT_MAX, TERMINAL_FONT_STEP } from "../../lib/terminal-font";
import {
  activeModifiers,
  consumeModifiers,
  encodeKey,
  resetModifierLatches,
  tapModifier,
  useModifierLatches,
  type LatchState,
  type ModifierName,
  type TerminalKey
} from "../../lib/terminal-keys";

// Keys Android/iOS soft keyboards usually lack, encoded through the latched
// Ctrl/Alt modifiers (`encodeKey`); `ctrl` keys always carry Ctrl. Unmodified,
// each sends the bytes a PTY expects for that key.
// Adapted from T3 Code (MIT): apps/mobile/src/features/terminal/ThreadTerminalRouteScreen.tsx
const KEYS: { label: string; key: TerminalKey; ctrl?: true; wide?: true }[] = [
  { label: "Tab", key: { kind: "special", key: "tab" } },
  { label: "⌃C", key: { kind: "char", char: "c" }, ctrl: true },
  { label: "⌃D", key: { kind: "char", char: "d" }, ctrl: true },
  { label: "←", key: { kind: "special", key: "left" } },
  { label: "↑", key: { kind: "special", key: "up" } },
  { label: "↓", key: { kind: "special", key: "down" } },
  { label: "→", key: { kind: "special", key: "right" } },
  { label: "~", key: { kind: "char", char: "~" } },
  { label: "|", key: { kind: "char", char: "|" } },
  { label: "/", key: { kind: "char", char: "/" } },
  { label: "-", key: { kind: "char", char: "-" } },
  { label: "↵", key: { kind: "special", key: "enter" }, wide: true }
];

const ESC_KEY: TerminalKey = { kind: "special", key: "escape" };

const MODIFIERS: { name: ModifierName; label: string }[] = [
  { name: "ctrl", label: "Ctrl" },
  { name: "alt", label: "Alt" }
];

const LATCH_CLASS: Record<LatchState, string> = {
  off: "bg-neutral-800 text-neutral-200 active:bg-neutral-700",
  armed: "bg-info-soft/40 text-info ring-1 ring-inset ring-info/60",
  locked: "bg-info text-neutral-950"
};

const LATCH_LABEL: Record<LatchState, string> = {
  off: "off",
  armed: "on for the next key",
  locked: "locked on"
};

// Per-kind auto-dismiss for the upload status line (ms). A hard failure warrants
// a longer read than a benign over-the-cap skip; `uploading` isn't timed — it's
// superseded by the success (null) or error that follows.
const STATUS_CLEAR_MS: Record<UploadStatus["kind"], number | null> = {
  uploading: null,
  skipped: 4000,
  error: 10000
};

/**
 * Read the clipboard via the async Clipboard API. This exists for iOS: its soft
 * keyboard has no paste key and the long-press "Paste" callout needs an editable
 * target under the finger, which xterm's hidden textarea isn't — so the OS-level
 * paste that Android keyboards provide simply cannot be triggered there. Must be
 * called from a user gesture (iOS shows its native paste-permission callout).
 *
 * `read()` gives text AND raw image blobs (a copied screenshot); where only
 * `readText()` exists we degrade to text. Image blobs have no filename, so
 * synthesize `pasted-<id>.<ext>` the same way TerminalView's desktop paste
 * handler does.
 */
async function readClipboard(): Promise<{ text: string; images: File[] }> {
  const clip = navigator.clipboard;
  const images: File[] = [];
  let text = "";
  if (clip?.read) {
    for (const item of await clip.read()) {
      const imageType = item.types.find((t) => t.startsWith("image/"));
      if (imageType) {
        const blob = await item.getType(imageType);
        // Strip MIME parameters before taking the subtype (mirrors the daemon's
        // split(";") handling); crypto id mirrors its randomUUID().slice(0, 8).
        const subtype = (imageType.split(";")[0] || "").split("/")[1] || "bin";
        const ext = subtype.replace(/[^a-z0-9]/gi, "") || "bin";
        const id = crypto.randomUUID().slice(0, 8);
        images.push(new File([blob], `pasted-${id}.${ext}`, { type: blob.type || imageType }));
      } else if (item.types.includes("text/plain")) {
        text += await (await item.getType("text/plain")).text();
      }
    }
  } else if (clip?.readText) {
    text = await clip.readText();
  } else {
    // Insecure context or ancient browser — the button reports it inline.
    throw new Error("clipboard API unavailable");
  }
  return { text, images };
}

/**
 * Mobile-only toolbar of terminal control keys for the active session. It lives
 * in the layout flow (shrink-0) so it pushes/resizes the terminal rather than
 * overlaying it; since the app shell is sized to the visual viewport, it ends
 * up just above the on-screen keyboard. Sends bytes straight to the daemon
 * session without stealing focus (the keyboard stays open).
 *
 * Its Ctrl and Alt are latches (`lib/terminal-keys.ts`): a tap applies the
 * modifier to the next key, from this bar or the on-screen keyboard; a quick
 * double tap locks it until it is tapped again.
 *
 * For agent sessions it also shows a file-attach button: a phone has no drag
 * source, so this is the mobile equivalent of the desktop drag/drop — it opens
 * the native file picker and runs the same upload + path-injection flow
 * (`uploadFilesToSession`) that drops the file's daemon-side path into the prompt.
 */
export const MobileKeyBar: React.FC = () => {
  const api = useApi();
  const isDesktop = useIsDesktop();
  const tabs = useProjectTabs();
  const activeId = useActiveTabId();
  const fontSize = useTerminalFontSize();
  const nudgeTerminalFontSize = useAppStore((s) => s.nudgeTerminalFontSize);

  const [status, setStatus] = useState<UploadStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-dismiss the status line per kind. Re-running on each `status` change
  // means a newer status cancels the previous pending clear (effect cleanup).
  useEffect(() => {
    if (!status) {
      return;
    }
    const ms = STATUS_CLEAR_MS[status.kind];
    if (ms == null) {
      return;
    }
    const timer = window.setTimeout(() => setStatus(null), ms);
    return () => window.clearTimeout(timer);
  }, [status]);

  const latches = useModifierLatches();

  const active = tabs.find((t) => t.id === activeId);
  const activeSessionId = !isDesktop && active?.type === "session" ? active.session.id : null;
  // The latches belong to the session the bar is driving: switching tabs, or
  // the bar going away, releases them so a stale Ctrl never lands elsewhere.
  useEffect(() => {
    resetModifierLatches(activeSessionId);
    return () => resetModifierLatches();
  }, [activeSessionId]);
  // `type === "session"` and nothing else: the bar writes raw control bytes into
  // a PTY, so a chat tab (the sixth `ProjectTab` arm) must never mount it — its
  // composer supplies its own send/attach/paste affordances (chat spec §7.1).
  if (isDesktop || !active || active.type !== "session") {
    return null;
  }
  const sessionId = active.session.id;
  // A LEGACY agent terminal (§5.2): the `↵` submit key exists because an agent
  // TUI reads a bare Enter as "newline" on a soft keyboard. Chat tabs never
  // reach here — the guard above already excluded them.
  const isAgent = isLegacyAgentTerminal(active.session);

  const handlePick = async (files: File[]) => {
    if (files.length === 0) {
      return;
    }
    setBusy(true);
    try {
      await uploadFilesToSession(api, sessionId, files, { onStatus: setStatus });
    } finally {
      setBusy(false);
    }
  };

  // A key-bar key goes out through the latched modifiers and spends the
  // one-shots, the same as a key from the on-screen keyboard (TerminalView).
  const sendKey = (key: TerminalKey, ctrl = false) => {
    const mods = activeModifiers(sessionId);
    consumeModifiers(sessionId);
    void api.sendSessionInput(sessionId, encodeKey(key, { ctrl: ctrl || mods.ctrl, alt: mods.alt }));
  };

  const latchOf = (name: ModifierName): LatchState =>
    latches.sessionId === sessionId ? latches[name].state : "off";

  const handlePaste = async () => {
    // A paste is not a key: it disarms a one-shot modifier rather than carry it.
    consumeModifiers(sessionId);
    let content: { text: string; images: File[] };
    try {
      content = await readClipboard();
    } catch {
      setStatus({ kind: "error", text: "Clipboard unavailable — allow paste access and try again." });
      return;
    }
    if (content.images.length > 0) {
      if (isAgent) {
        // Same upload + path-injection flow as the attach button.
        await handlePick(content.images);
      } else {
        setStatus({ kind: "skipped", text: "Image paste works in agent sessions only." });
      }
    }
    if (content.text) {
      void api.sendSessionInput(sessionId, pasteTextForSession(isAgent, content.text));
    } else if (content.images.length === 0) {
      setStatus({ kind: "skipped", text: "Clipboard is empty." });
    }
  };

  return (
    // No bottom safe-area padding here on purpose: the app shell owns every
    // inset for the whole in-flow tree (see the `#root > *` rule in
    // apps/web/src/styles.css). This bar is only *sometimes* the bottom-most
    // element — hide it and the main view or the sidebar footer is — so making
    // it an inset owner would leave the other cases uncovered and double-pad
    // this one.
    <div className="flex shrink-0 flex-col border-t border-neutral-800 bg-neutral-900">
      {status && status.kind === "uploading" ? (
        <div className="border-b border-neutral-800 px-3 py-2">
          <UploadProgressBar progress={status.progress} label="Attaching" />
        </div>
      ) : status ? (
        <div className="px-3 py-1 text-xs text-danger">{status.text}</div>
      ) : null}
      <div className="flex items-stretch gap-1 overflow-x-auto px-2 py-1.5">
        <button
          type="button"
          aria-label="Paste from clipboard"
          disabled={busy}
          // preventDefault on pointerdown = no focus steal (keyboard stays up);
          // the clipboard read itself runs on click, still inside the gesture's
          // user activation. On iOS the native paste callout appears over the tap.
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => void handlePaste()}
          className="flex h-9 shrink-0 items-center justify-center rounded-md bg-neutral-800 px-3 text-neutral-200 active:bg-neutral-700 disabled:opacity-50"
        >
          <ClipboardPaste size={16} />
        </button>
        {isAgent && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = e.target.files ? Array.from(e.target.files) : [];
                // Reset so re-picking the same file fires `change` again.
                e.target.value = "";
                void handlePick(files);
              }}
            />
            <button
              type="button"
              aria-label="Attach file"
              disabled={busy}
              // Normal onClick (not onPointerDown): opening the native picker
              // inherently takes focus / closes the keyboard, which is expected.
              onClick={() => fileInputRef.current?.click()}
              className="flex h-9 shrink-0 items-center justify-center rounded-md bg-neutral-800 px-3 text-neutral-200 active:bg-neutral-700 disabled:opacity-50"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Paperclip size={16} />}
            </button>
          </>
        )}
        <div className="flex shrink-0 items-stretch gap-1">
          <button
            type="button"
            aria-label="Decrease terminal text size"
            disabled={fontSize <= TERMINAL_FONT_MIN}
            // onPointerDown + preventDefault keeps the soft keyboard up (no focus steal).
            onPointerDown={(e) => {
              e.preventDefault();
              nudgeTerminalFontSize(-TERMINAL_FONT_STEP);
            }}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-neutral-800 font-mono text-sm text-neutral-200 active:bg-neutral-700 disabled:opacity-40"
          >
            A−
          </button>
          <span className="flex h-9 w-7 shrink-0 items-center justify-center font-mono text-xs text-neutral-400">
            {fontSize}
          </span>
          <button
            type="button"
            aria-label="Increase terminal text size"
            disabled={fontSize >= TERMINAL_FONT_MAX}
            onPointerDown={(e) => {
              e.preventDefault();
              nudgeTerminalFontSize(TERMINAL_FONT_STEP);
            }}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-neutral-800 font-mono text-sm text-neutral-200 active:bg-neutral-700 disabled:opacity-40"
          >
            A+
          </button>
        </div>
        <KeyButton label="Esc" onPress={() => sendKey(ESC_KEY)} />
        {MODIFIERS.map(({ name, label }) => {
          const state = latchOf(name);
          return (
            <button
              key={name}
              type="button"
              aria-label={`${label} modifier, ${LATCH_LABEL[state]}`}
              aria-pressed={state !== "off"}
              // Tap arms for the next key; a quick second tap locks; tap again releases.
              onPointerDown={(e) => {
                e.preventDefault();
                tapModifier(sessionId, name, e.timeStamp);
              }}
              className={`flex h-9 shrink-0 touch-manipulation items-center justify-center gap-1 rounded-md px-3 font-mono text-sm ${LATCH_CLASS[state]}`}
            >
              {label}
              {state === "locked" && <Lock size={11} aria-hidden />}
            </button>
          );
        })}
        {KEYS.map((key) => (
          <KeyButton
            key={key.label}
            label={key.label}
            wide={key.wide}
            onPress={() => sendKey(key.key, key.ctrl)}
          />
        ))}
      </div>
    </div>
  );
};

const KeyButton: React.FC<{ label: string; wide?: boolean; onPress: () => void }> = ({
  label,
  wide,
  onPress
}) => (
  <button
    type="button"
    // Don't take focus → the keyboard stays up.
    onPointerDown={(e) => {
      e.preventDefault();
      onPress();
    }}
    className={`flex h-9 shrink-0 items-center justify-center rounded-md bg-neutral-800 px-3 font-mono text-sm text-neutral-200 active:bg-neutral-700 ${wide ? "flex-1" : ""}`}
  >
    {label}
  </button>
);
