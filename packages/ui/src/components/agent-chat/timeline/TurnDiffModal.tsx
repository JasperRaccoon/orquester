import React from "react";

import { useApi } from "../../../context/orquester-context";
import { ApiError } from "../../../lib/api-client";
import { cn } from "../../../lib/cn";
import { DiffFilesView } from "../../git/DiffFilesView";
import { Modal, ModalCloseButton } from "../../ui";

/**
 * One turn's diff — `GET …/turns/:n/diff` (§6.3) — read on demand and shown
 * read-only in the diff view. A §6.3 read with no store slice behind it: the
 * answer is something the user asked to look at once, not thread state every
 * later render pays for.
 *
 * Opened from the timeline's changed-files card (`AgentChatView`) and from the
 * right rail's History (checkpoints, and the prompt that started a turn), so
 * both show the same thing the same way.
 */

/** Which turn's diff to show. */
export interface TurnDiffRequest {
  sessionId: string;
  /** The checkpoint's turn count — the `:n` of `GET …/turns/:n/diff`. */
  turnCount: number;
  /** The header; "Turn N" when absent. */
  title?: string;
}

export interface TurnDiffState {
  loading: boolean;
  /** The unified diff, once read. */
  diff?: string;
  /** Why it could not be read, in words. */
  error?: string;
}

/** The daemon's own message where it sent one, else a plain fallback. */
function errorText(error: unknown, fallback: string): string {
  return (error instanceof ApiError ? error.serverMessage : null) ?? fallback;
}

/** The header a request shows. */
export function turnDiffTitle(request: TurnDiffRequest): string {
  return request.title ?? `Turn ${request.turnCount}`;
}

/**
 * Read `request`'s diff: `null` with no request, loading until the answer
 * lands. A new request — or a flip of `ignoreWhitespace` — starts over; an
 * answer for a read that was closed or replaced meanwhile is dropped.
 */
export function useTurnDiff(
  request: TurnDiffRequest | null,
  options: { ignoreWhitespace?: boolean } = {}
): TurnDiffState | null {
  const api = useApi();
  const ignoreWhitespace = options.ignoreWhitespace === true;
  const [answer, setAnswer] = React.useState<{
    request: TurnDiffRequest;
    ignoreWhitespace: boolean;
    state: TurnDiffState;
  } | null>(null);
  React.useEffect(() => {
    if (request === null) {
      return;
    }
    let current = true;
    api
      .agentChatTurnDiff(request.sessionId, request.turnCount, { ignoreWhitespace })
      .then((response) => {
        if (current) setAnswer({ request, ignoreWhitespace, state: { loading: false, diff: response.diff } });
      })
      .catch((error: unknown) => {
        if (current) {
          setAnswer({
            request,
            ignoreWhitespace,
            state: { loading: false, error: errorText(error, "That turn's diff could not be read.") }
          });
        }
      });
    return () => {
      current = false;
    };
  }, [api, request, ignoreWhitespace]);
  if (request === null) {
    return null;
  }
  return answer !== null && answer.request === request && answer.ignoreWhitespace === ignoreWhitespace
    ? answer.state
    : { loading: true };
}

/**
 * The diff itself, per file, or why it is not there — the modal's body, and
 * the rail sheet's inline view. It owns the read: whitespace-only changes show
 * by default (an indentation change is a real change in Python or YAML), and
 * its toggle re-reads the turn with them hidden.
 */
export function TurnDiffBody({ request }: { request: TurnDiffRequest }): React.ReactElement {
  const [ignoreWhitespace, setIgnoreWhitespace] = React.useState(false);
  const state = useTurnDiff(request, { ignoreWhitespace });
  const toggle = (
    <button
      type="button"
      aria-pressed={ignoreWhitespace}
      onClick={() => setIgnoreWhitespace((value) => !value)}
      title={ignoreWhitespace ? "Whitespace-only changes are hidden" : "Hide whitespace-only changes"}
      className={cn(
        "h-6 rounded px-1.5 text-[11px] focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
        ignoreWhitespace
          ? "bg-neutral-700 text-neutral-100 hover:bg-neutral-600"
          : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
      )}
    >
      Hide whitespace
    </button>
  );
  if (state?.error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 justify-end border-b border-neutral-800 px-3 py-1.5">{toggle}</div>
        <p className="px-4 py-6 text-sm text-danger">{state.error}</p>
      </div>
    );
  }
  return (
    <DiffFilesView
      diff={state?.diff ?? ""}
      loading={state?.loading ?? true}
      emptyLabel={
        ignoreWhitespace ? "This turn changed no files, apart from whitespace." : "This turn changed no files."
      }
      controls={toggle}
    />
  );
}

export interface TurnDiffModalProps {
  /** The turn to show; `null` keeps the modal closed. */
  request: TurnDiffRequest | null;
  onClose: () => void;
}

/**
 * The turn-diff viewer on the app's own modal layer (z-100) — above the chat
 * overlays by construction, so the ladder needs no new z-index.
 */
export function TurnDiffModal({ request, onClose }: TurnDiffModalProps): React.ReactElement {
  return (
    <Modal open={request !== null} onClose={onClose} className="max-h-[85vh] max-w-4xl">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-neutral-800 px-3">
          <span className="truncate text-sm text-neutral-200">
            {request !== null ? turnDiffTitle(request) : null}
          </span>
          <ModalCloseButton onClose={onClose} />
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          {request !== null ? <TurnDiffBody request={request} /> : null}
        </div>
      </div>
    </Modal>
  );
}
