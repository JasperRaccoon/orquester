// Adapted from T3 Code (MIT): apps/web/src/components/chat/SecretRequestCard.tsx
import React from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import { SECRET_VALUE_MAX_CHARS, type SecretRequestSummary } from "@orquester/api/agent-chat";

import { cn } from "../../../lib/cn";
import { BannerCard } from "../primitives";
import { CARD_INPUT_CLASS, SECRET_INPUT_ATTRIBUTES } from "./secret-input";

/**
 * What happens to the value, said plainly: the agent that asked receives it,
 * and with it the agent's model provider (its own transcript keeps what the
 * agent read). Orquester never shows it and masks it — and later repeats of
 * it — in this thread's records.
 */
export const SECRET_REQUEST_PRIVACY_NOTE =
  "Never shown in the chat. Orquester masks it, and any later repeat of it, in this thread's records.";
export const SECRET_REQUEST_SHARING_NOTE =
  "The value goes to the agent that asked, and so to its model provider.";

/** What a failed answer says. Never the server's words or the value: a fixed sentence. */
export function secretAnswerFailureText(status: number | null): string {
  if (status === 404) return "This request has already ended.";
  return "Could not send the answer. Try again.";
}

export type SecretRequestAnswer = { answer: "provide"; value: string } | { answer: "decline" };

export interface SecretRequestCardProps {
  request: SecretRequestSummary;
  /** How many requests are pending in this thread, this one included. */
  pendingCount: number;
  /**
   * Send the answer. Resolves once the daemon took it; rejects with the HTTP
   * status (or null) when it did not. The card clears its field either way
   * once it resolves.
   */
  onAnswer: (answer: SecretRequestAnswer) => Promise<void>;
}

/**
 * An agent's `request_secret`, docked like a question (design 2026-10-14 §5).
 *
 * The typed value lives only in this component's state and the answer's
 * request body: never logged, toasted, carried into the draft or persisted;
 * the field clears once the answer is sent. Like every dock card it never
 * steals focus.
 */
export function SecretRequestCard({ request, pendingCount, onAnswer }: SecretRequestCardProps): React.ReactElement {
  const [value, setValue] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Enter then a click can both land before a re-render; this guard is synchronous.
  const inFlight = React.useRef(false);
  const inputId = React.useId();
  const noteId = React.useId();

  // A new request is a new card.
  React.useEffect(() => {
    setValue("");
    setError(null);
  }, [request.requestId]);

  const send = async (answer: SecretRequestAnswer): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onAnswer(answer);
      setValue("");
    } catch (failure) {
      setError(secretAnswerFailureText(typeof failure === "number" ? failure : null));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  // Sent exactly as typed: only an all-whitespace value is held back.
  const canSave = !submitting && value.trim().length > 0 && value.length <= SECRET_VALUE_MAX_CHARS;

  return (
    <BannerCard
      variant="info"
      density="spacious"
      icon={<KeyRound size={14} aria-hidden />}
      title={<label htmlFor={inputId}>{request.name}</label>}
      description="Secret requested"
      counter={pendingCount > 1 ? `1/${pendingCount}` : undefined}
    >
      <div className="min-w-0" data-secret-request={request.requestId}>
        <p className="break-words text-sm text-neutral-200">{request.prompt}</p>
        {request.purpose ? (
          <p className="mt-1 break-words text-[11px] text-neutral-500">For: {request.purpose}</p>
        ) : null}
        <p className="mt-1 break-words text-[11px] text-neutral-500">{SECRET_REQUEST_SHARING_NOTE}</p>
        <div className="mt-2 flex min-w-0 items-center gap-2">
          <input
            id={inputId}
            {...SECRET_INPUT_ATTRIBUTES}
            value={value}
            disabled={submitting}
            maxLength={SECRET_VALUE_MAX_CHARS}
            placeholder="Enter the value (hidden)"
            aria-describedby={noteId}
            aria-invalid={error !== null || undefined}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return;
              event.preventDefault();
              if (canSave) void send({ answer: "provide", value });
            }}
            className={cn(CARD_INPUT_CLASS, "min-w-0 flex-1")}
          />
        </div>
        {error !== null ? (
          <p role="alert" className="mt-1.5 text-[11px] text-danger-300">
            {error}
          </p>
        ) : null}
        <div className="mt-3 flex min-w-0 items-center justify-between gap-2">
          <p id={noteId} className="flex min-w-0 items-center gap-1.5 text-[11px] text-neutral-500">
            <ShieldCheck size={12} className="shrink-0" aria-hidden />
            {SECRET_REQUEST_PRIVACY_NOTE}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={submitting}
              onClick={() => void send({ answer: "decline" })}
              className={cn(
                "ac-press inline-flex h-7 items-center rounded-full border border-neutral-700 px-3",
                "text-xs text-neutral-200 hover:bg-neutral-800",
                "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
                "disabled:pointer-events-none disabled:opacity-50"
              )}
            >
              Decline
            </button>
            <button
              type="button"
              disabled={!canSave}
              onClick={() => void send({ answer: "provide", value })}
              className={cn(
                "ac-press inline-flex h-7 items-center rounded-full bg-neutral-200 px-4",
                "text-xs font-medium text-neutral-900 hover:bg-neutral-50",
                "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
                "disabled:pointer-events-none disabled:opacity-50"
              )}
            >
              {submitting ? "Sending…" : "Send securely"}
            </button>
          </div>
        </div>
      </div>
    </BannerCard>
  );
}
