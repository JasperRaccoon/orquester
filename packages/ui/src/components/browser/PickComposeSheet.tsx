import React, { useMemo, useState } from "react";
import { Send, X } from "lucide-react";
import type { BrowserPickPayload } from "@orquester/api";
import { useAppStore } from "../../store/app";
import { formatDesignFeedback, type PickIntent } from "../../lib/design-feedback";
import { cn } from "../../lib/cn";

/**
 * Bottom sheet shown after an element pick: summary + screenshot thumbnail +
 * comment + intent + target agent session. Delivery reuses the existing
 * routes verbatim: upload the PNG (→ daemon path), then one bracketed-paste
 * input write + "\r" to submit (see session-upload.ts for the paste format).
 */
export const PickComposeSheet: React.FC<{
  payload: BrowserPickPayload;
  projectPath: string;
  onClose: () => void;
}> = ({ payload, projectPath, onClose }) => {
  const api = useAppStore((s) => s.api);
  const sessions = useAppStore((s) => s.sessions);
  const agents = useMemo(
    () => sessions.filter((s) => s.kind === "agent" && s.projectPath === projectPath && s.status === "running"),
    [sessions, projectPath]
  );
  const [targetId, setTargetId] = useState<string>(agents[0]?.id ?? "");
  const [comment, setComment] = useState("");
  const [intent, setIntent] = useState<PickIntent>("fix");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendToAgent = async () => {
    if (!api || !targetId) return;
    setSending(true);
    setError(null);
    try {
      let screenshotPath: string | undefined;
      if (payload.screenshotBase64) {
        const uploaded = await api.uploadSessionFile(targetId, {
          name: "design-pick.png",
          type: "image/png",
          dataBase64: payload.screenshotBase64
        });
        screenshotPath = uploaded.path;
      }
      const markdown = formatDesignFeedback(payload, { comment, intent, screenshotPath });
      await api.sendSessionInput(targetId, `\x1b[200~${markdown}\x1b[201~\r`);
      onClose();
    } catch {
      setError("Failed to send to agent");
      setSending(false);
    }
  };

  return (
    <div className="absolute inset-x-0 bottom-0 z-10 border-t border-neutral-700 bg-neutral-900 p-3 shadow-2xl">
      <div className="mb-2 flex items-start gap-3">
        {payload.screenshotBase64 && (
          <img
            src={`data:image/png;base64,${payload.screenshotBase64}`}
            alt="Picked element"
            className="max-h-20 max-w-[120px] rounded border border-neutral-700 object-contain"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-xs text-sky-300">{payload.target.selector}</div>
          {payload.target.reactSource && (
            <div className="truncate font-mono text-[11px] text-neutral-400">{payload.target.reactSource}</div>
          )}
          <div className="truncate text-[11px] text-neutral-500">{payload.target.elementPath}</div>
        </div>
        <button type="button" aria-label="Dismiss" onClick={onClose}
          className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200">
          <X size={14} />
        </button>
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="What should the agent do with this element?"
        rows={2}
        className="mb-2 w-full resize-none rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-neutral-500"
      />
      <div className="flex items-center gap-2">
        {(["fix", "change", "question"] as const).map((i) => (
          <button key={i} type="button" onClick={() => setIntent(i)}
            className={cn("rounded border px-2 py-0.5 text-[11px] capitalize",
              intent === i ? "border-sky-500 text-sky-300" : "border-neutral-700 text-neutral-400 hover:bg-neutral-800")}>
            {i}
          </button>
        ))}
        <div className="flex-1" />
        <select
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          className="max-w-[40%] rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-200"
        >
          {agents.length === 0 && <option value="">No agent session</option>}
          {agents.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
        </select>
        <button type="button" disabled={!targetId || sending} onClick={() => void sendToAgent()}
          className="flex items-center gap-1 rounded bg-sky-600 px-3 py-1 text-xs text-white enabled:hover:bg-sky-500 disabled:opacity-50">
          <Send size={12} /> {sending ? "Sending…" : "Send"}
        </button>
      </div>
      {error && <div className="mt-1 text-[11px] text-red-400">{error}</div>}
    </div>
  );
};
