import React from "react";

import { useApi } from "../../../context/orquester-context";
import { ApiError } from "../../../lib/api-client";
import { DiffView } from "../../git/DiffView";
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
 * lands. A new request starts over; an answer for a request that was closed
 * or replaced meanwhile is dropped.
 */
export function useTurnDiff(request: TurnDiffRequest | null): TurnDiffState | null {
  const api = useApi();
  const [answer, setAnswer] = React.useState<{ request: TurnDiffRequest; state: TurnDiffState } | null>(
    null
  );
  React.useEffect(() => {
    if (request === null) {
      return;
    }
    let current = true;
    api
      .agentChatTurnDiff(request.sessionId, request.turnCount)
      .then((response) => {
        if (current) setAnswer({ request, state: { loading: false, diff: response.diff } });
      })
      .catch((error: unknown) => {
        if (current) {
          setAnswer({
            request,
            state: { loading: false, error: errorText(error, "That turn's diff could not be read.") }
          });
        }
      });
    return () => {
      current = false;
    };
  }, [api, request]);
  if (request === null) {
    return null;
  }
  return answer !== null && answer.request === request ? answer.state : { loading: true };
}

/** The diff itself, or why it is not there — the modal's body, and the rail sheet's inline view. */
export function TurnDiffBody({ state }: { state: TurnDiffState }): React.ReactElement {
  if (state.error) {
    return <p className="px-4 py-6 text-sm text-danger">{state.error}</p>;
  }
  return (
    <DiffView
      diff={state.diff ?? ""}
      loading={state.loading}
      emptyLabel="This turn changed no files."
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
  const state = useTurnDiff(request);
  return (
    <Modal open={request !== null} onClose={onClose} className="max-h-[85vh] max-w-4xl">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-neutral-800 px-3">
          <span className="truncate text-sm text-neutral-200">
            {request !== null ? turnDiffTitle(request) : null}
          </span>
          <ModalCloseButton onClose={onClose} />
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {state !== null ? <TurnDiffBody state={state} /> : null}
        </div>
      </div>
    </Modal>
  );
}
