import React from "react";
import { Clock } from "lucide-react";

import { cn } from "../../../lib/cn";
import { nextClockTime, parseDelay, sendsAtText } from "../../../lib/agent-chat/scheduled-prompts.logic";
import { ComposerPopover } from "./ComposerPopover";

export interface ComposerScheduleProps {
  /** Non-null: the draft cannot be scheduled now, and this says why. */
  disabledReason: string | null;
  /** Schedule the draft at `sendAt`; resolves true once the daemon holds it (the draft is cleared then). */
  onSchedule: (sendAt: Date) => Promise<boolean>;
  returnFocusTo?: () => HTMLElement | null;
}

const QUICK_PICKS = ["5m", "30m", "1h", "2h", "4h", "8h"] as const;

const FIELD =
  "h-8 w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 text-sm text-neutral-100 " +
  "placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none";
const TAB = "ac-press flex-1 rounded-md px-2 py-1 text-xs font-medium focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500";

/**
 * "Send later": the clock beside Send. Its panel takes a delay ("in 1h 24m", with quick picks) or
 * a clock time ("at 4:30"), always says when the prompt will go out, and schedules the whole draft
 * with the daemon, which sends it at that time whether or not any window is open.
 */
export function ComposerSchedule({ disabledReason, onSchedule, returnFocusTo }: ComposerScheduleProps): React.ReactElement {
  return (
    <ComposerPopover
      label="Send later"
      align="end"
      width="w-72"
      {...(returnFocusTo ? { returnFocusTo } : {})}
      renderTrigger={(trigger) => (
        <button
          type="button"
          ref={trigger.ref}
          onClick={trigger.onClick}
          aria-expanded={trigger["aria-expanded"]}
          aria-haspopup={trigger["aria-haspopup"]}
          onPointerDown={(event) => event.preventDefault()}
          disabled={disabledReason !== null}
          aria-label="Send later"
          title={disabledReason ?? "Send later"}
          className={cn(
            "ac-press inline-flex h-9 w-9 items-center justify-center rounded-full text-neutral-400 sm:h-8 sm:w-8",
            "hover:bg-neutral-800 hover:text-neutral-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
            "disabled:pointer-events-none disabled:opacity-30"
          )}
        >
          <Clock size={15} aria-hidden />
        </button>
      )}
    >
      {(close) => <SchedulePanel onSchedule={onSchedule} close={close} />}
    </ComposerPopover>
  );
}

function SchedulePanel({ onSchedule, close }: { onSchedule: (sendAt: Date) => Promise<boolean>; close: () => void }): React.ReactElement {
  const [mode, setMode] = React.useState<"in" | "at">("in");
  const [delayText, setDelayText] = React.useState("1h");
  const [clockText, setClockText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  // Redrawn each minute, so the "Sends at … (in …)" line stays true while the panel is open.
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const sendAt = React.useMemo((): Date | null => {
    if (mode === "at") return nextClockTime(clockText, now);
    const delay = parseDelay(delayText);
    return delay === null ? null : new Date(now.getTime() + delay);
  }, [clockText, delayText, mode, now]);

  const submit = async (): Promise<void> => {
    if (busy) return;
    // Measured from the click, not from the panel's last redraw.
    const at = mode === "at" ? nextClockTime(clockText, new Date()) : (() => {
      const delay = parseDelay(delayText);
      return delay === null ? null : new Date(Date.now() + delay);
    })();
    if (!at) return;
    setBusy(true);
    try {
      if (await onSchedule(at)) close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-2 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void submit();
      }}
    >
      <div className="flex gap-1 rounded-md bg-neutral-950 p-0.5" role="tablist" aria-label="Schedule by">
        {(["in", "at"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => setMode(value)}
            className={cn(TAB, mode === value ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-200")}
          >
            {value === "in" ? "Send in" : "Send at"}
          </button>
        ))}
      </div>

      {mode === "in" ? (
        <>
          <input
            aria-label="Send in"
            autoFocus
            value={delayText}
            onChange={(event) => setDelayText(event.target.value)}
            placeholder="1h 24m"
            className={FIELD}
          />
          <div className="flex flex-wrap gap-1">
            {QUICK_PICKS.map((pick) => (
              <button
                key={pick}
                type="button"
                onClick={() => setDelayText(pick)}
                className={cn(
                  "ac-press rounded-md border px-2 py-0.5 text-[11px] focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
                  delayText.trim() === pick
                    ? "border-neutral-500 bg-neutral-800 text-neutral-100"
                    : "border-neutral-800 text-neutral-400 hover:text-neutral-100"
                )}
              >
                {pick}
              </button>
            ))}
          </div>
        </>
      ) : (
        <input
          aria-label="Send at"
          type="time"
          autoFocus
          value={clockText}
          onChange={(event) => setClockText(event.target.value)}
          className={cn(FIELD, "[color-scheme:dark]")}
        />
      )}

      <p className="ac-tabular text-[11px] text-neutral-400" aria-live="polite">
        {sendAt ? sendsAtText(sendAt, now) : mode === "in" ? "Type a delay, like 45m or 1h 24m." : "Pick a time."}
      </p>

      <button
        type="submit"
        disabled={!sendAt || busy}
        className={cn(
          "ac-press h-8 rounded-md bg-neutral-200 text-xs font-medium text-neutral-900 hover:bg-neutral-50",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 disabled:pointer-events-none disabled:opacity-40"
        )}
      >
        {busy ? "Scheduling…" : "Schedule"}
      </button>
    </form>
  );
}
