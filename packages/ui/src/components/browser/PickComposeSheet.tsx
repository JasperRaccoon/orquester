import React, { useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Send, X } from "lucide-react";
import type { BrowserPickPayload } from "@orquester/api";
import { useAppStore } from "../../store/app";
import { formatDesignFeedback, type PickIntent } from "../../lib/design-feedback";
import { Button, IconButton } from "../ui";
import { cn } from "../../lib/cn";

/**
 * Bottom sheet shown after element picks: per-element summary + screenshot
 * thumbnails + one comment/intent/target for the whole batch. "Pick another"
 * re-arms the picker while the batch accumulates. Delivery reuses the existing
 * routes verbatim: upload each PNG (→ daemon path), then ONE bracketed-paste
 * input write + "\r" to submit (see session-upload.ts for the paste format).
 */
export const PickComposeSheet: React.FC<{
  payloads: BrowserPickPayload[];
  projectPath: string;
  onRemove: (index: number) => void;
  onPickAnother: () => void;
  onClose: () => void;
}> = ({ payloads, projectPath, onRemove, onPickAnother, onClose }) => {
  const api = useAppStore((s) => s.api);
  const sessions = useAppStore((s) => s.sessions);
  const agents = useMemo(
    () => sessions.filter((s) => s.kind === "agent" && s.projectPath === projectPath && s.status === "running"),
    [sessions, projectPath]
  );
  const [targetId, setTargetId] = useState<string>(agents[0]?.id ?? "");
  // The initial seed is mount-time only; agents open/close while the sheet is
  // up (e.g. user picks an element FIRST, then starts Claude). Re-seed when
  // the current target is empty or gone so Send enables without a manual pick.
  useEffect(() => {
    if (!targetId || !agents.some((a) => a.id === targetId)) {
      setTargetId(agents[0]?.id ?? "");
    }
  }, [agents, targetId]);
  const [comment, setComment] = useState("");
  const [intent, setIntent] = useState<PickIntent>("fix");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Uploads that already succeeded for this batch, keyed by payload identity —
  // a retry after a partial failure reuses them instead of re-uploading and
  // orphaning duplicate design-pick-*.png files in the agent's upload dir.
  // Keyed per target session too: a path is only valid for the session it was
  // uploaded to.
  const uploadedRef = useRef(new WeakMap<BrowserPickPayload, { targetId: string; path: string }>());

  const sendToAgent = async () => {
    if (!api || !targetId || payloads.length === 0) return;
    setSending(true);
    setError(null);
    try {
      const picks: Array<{ payload: BrowserPickPayload; screenshotPath?: string }> = [];
      // Sequential uploads so path numbering matches pick order.
      for (let i = 0; i < payloads.length; i++) {
        const payload = payloads[i];
        let screenshotPath: string | undefined;
        const cached = uploadedRef.current.get(payload);
        if (cached && cached.targetId === targetId) {
          screenshotPath = cached.path;
        } else if (payload.screenshotBase64) {
          const uploaded = await api.uploadSessionFile(targetId, {
            name: payloads.length === 1 ? "design-pick.png" : `design-pick-${i + 1}.png`,
            type: "image/png",
            dataBase64: payload.screenshotBase64
          });
          screenshotPath = uploaded.path;
          uploadedRef.current.set(payload, { targetId, path: uploaded.path });
        }
        picks.push({ payload, screenshotPath });
      }
      const markdown = formatDesignFeedback(picks, { comment, intent });
      await api.sendSessionInput(targetId, `\x1b[200~${markdown}\x1b[201~\r`);
      onClose();
    } catch {
      setError("Failed to send to agent");
      setSending(false);
    }
  };

  return (
    <div className="absolute inset-x-0 bottom-0 z-10 border-t border-neutral-800 bg-neutral-900 shadow-2xl shadow-black/40">
      <div className="flex items-center gap-2 px-3 pb-1.5 pt-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">
          Design feedback{payloads.length > 1 ? ` · ${payloads.length} elements` : ""}
        </span>
        <div className="flex-1" />
        <IconButton label="Dismiss" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>

      <div className="max-h-40 space-y-1.5 overflow-y-auto px-3">
        {payloads.map((payload, i) => (
          <div
            key={`${payload.target.selector}-${i}`}
            className="flex items-start gap-2.5 rounded-md border border-neutral-800 bg-neutral-950/60 p-2"
          >
            {payload.screenshotBase64 && (
              <img
                src={`data:image/png;base64,${payload.screenshotBase64}`}
                alt="Picked element"
                className="max-h-16 max-w-[104px] rounded border border-neutral-800 object-contain"
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-xs text-neutral-200">{payload.target.selector}</div>
              {payload.target.reactSource && (
                <div className="truncate font-mono text-[11px] text-neutral-500">{payload.target.reactSource}</div>
              )}
              <div className="truncate text-[11px] text-neutral-600">{payload.target.elementPath}</div>
            </div>
            {payloads.length > 1 && (
              <button
                type="button"
                aria-label="Remove element"
                onClick={() => onRemove(i)}
                className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
              >
                <X size={13} />
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="px-3 pt-2">
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={payloads.length === 1
            ? "What should the agent do with this element?"
            : `What should the agent do with these ${payloads.length} elements?`}
          rows={2}
          className={cn(
            "w-full resize-none rounded-md border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-sm",
            "text-neutral-100 placeholder:text-neutral-500",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
          )}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-1.5">
        <div className="flex rounded-md border border-neutral-700 p-0.5">
          {(["fix", "change", "question"] as const).map((i) => (
            <button
              key={i}
              type="button"
              onClick={() => setIntent(i)}
              className={cn(
                "rounded px-2.5 py-1 text-xs capitalize transition-colors",
                intent === i ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"
              )}
            >
              {i}
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={onPickAnother} disabled={sending}>
          <Crosshair size={12} /> Pick another
        </Button>
        <div className="flex-1" />
        <select
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          className={cn(
            "h-7 max-w-[40%] rounded-md border border-neutral-700 bg-neutral-900 px-2 text-xs text-neutral-200",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
          )}
        >
          {agents.length === 0 && <option value="">No agent session</option>}
          {agents.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
        </select>
        <Button size="sm" disabled={!targetId || sending} onClick={() => void sendToAgent()}>
          <Send size={12} /> {sending ? "Sending…" : payloads.length > 1 ? `Send ${payloads.length}` : "Send"}
        </Button>
      </div>
      {error && <div className="px-3 pb-2 text-xs text-red-400">{error}</div>}
    </div>
  );
};
