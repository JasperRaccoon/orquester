import React, { useEffect, useState, useRef } from "react";
import { ClipboardPaste, Loader2, Paperclip } from "lucide-react";
import { useApi } from "../../context/orquester-context";
import { useIsDesktop } from "../../hooks";
import { useActiveTabId, useAppStore, useProjectTabs, useTerminalFontSize } from "../../store/app";
import { uploadFilesToSession, type UploadStatus } from "../../lib/session-upload";
import { pasteTextForSession } from "../../lib/paste";
import { TERMINAL_FONT_MIN, TERMINAL_FONT_MAX, TERMINAL_FONT_STEP } from "../../lib/terminal-font";

// Control keys Android/iOS soft keyboards usually lack. Values are the bytes a
// PTY expects.
const KEYS: { label: string; data: string; wide?: boolean }[] = [
  { label: "Esc", data: "\x1b" },
  { label: "Tab", data: "\t" },
  { label: "⌃C", data: "\x03" },
  { label: "⌃D", data: "\x04" },
  { label: "←", data: "\x1b[D" },
  { label: "↑", data: "\x1b[A" },
  { label: "↓", data: "\x1b[B" },
  { label: "→", data: "\x1b[C" },
  { label: "↵", data: "\r", wide: true }
];

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

  const active = tabs.find((t) => t.id === activeId);
  if (isDesktop || !active || active.type !== "session") {
    return null;
  }
  const sessionId = active.session.id;
  const isAgent = active.session.kind === "agent";

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

  const handlePaste = async () => {
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
      {status && (
        <div
          className={`px-3 py-1 text-xs ${
            status.kind === "uploading" ? "text-neutral-400" : "text-danger"
          }`}
        >
          {status.text}
        </div>
      )}
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
        {KEYS.map((key) => (
          <button
            key={key.label}
            type="button"
            // Don't take focus → the keyboard stays up.
            onPointerDown={(e) => {
              e.preventDefault();
              void api.sendSessionInput(sessionId, key.data);
            }}
            className={`flex h-9 shrink-0 items-center justify-center rounded-md bg-neutral-800 px-3 font-mono text-sm text-neutral-200 active:bg-neutral-700 ${key.wide ? "flex-1" : ""}`}
          >
            {key.label}
          </button>
        ))}
      </div>
    </div>
  );
};
