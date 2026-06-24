import React, { useEffect, useState, useRef } from "react";
import { Loader2, Paperclip } from "lucide-react";
import { useApi } from "../../context/orquester-context";
import { useIsDesktop } from "../../hooks";
import { useActiveTabId, useProjectTabs } from "../../store/app";
import { uploadFilesToSession, type UploadStatus } from "../../lib/session-upload";

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

  return (
    <div className="flex shrink-0 flex-col border-t border-neutral-800 bg-neutral-900">
      {status && (
        <div
          className={`px-3 py-1 text-xs ${
            status.kind === "uploading" ? "text-neutral-400" : "text-red-400"
          }`}
        >
          {status.text}
        </div>
      )}
      <div className="flex items-stretch gap-1 overflow-x-auto px-2 py-1.5">
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
