/**
 * The right rail's History — the React seam. Everything these hooks return is
 * computed by the pure modules beside them (`prompts.logic`,
 * `checkpoints.logic`, `rewind.logic`, `index-cache`, `thread-inputs`).
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import type { Checkpoint, ThreadPromptEntry } from "@orquester/api/agent-chat";

import { useApi } from "../../context/orquester-context";
import type { ApiClient } from "../api-client";
import { useAgentChatThreadSelector, useProviderSnapshot } from "../agent-chat/hooks";
import { peekThreadStore } from "../agent-chat/store";
import { isComposerSending } from "../../components/agent-chat/composer/composer-sends";
import {
  checkpointsByTurnId,
  deriveCheckpointEntries,
  readyCheckpoints,
  type CheckpointEntry
} from "./checkpoints.logic";
import {
  PromptIndexCache,
  scheduleCatchUpReask,
  fillWantsOlder,
  PROMPT_PAGE_LIMIT,
  SEARCH_PAGE_LIMIT,
  searchWantsOlder,
  type PromptIndexState,
  type PromptTextState
} from "./index-cache";
import {
  knownTurnIdsOf,
  mergeHistoryPrompts,
  turnOrdinalsOf,
  type HistoryPrompt
} from "./prompts.logic";
import {
  CHAT_NOT_READY,
  revealMissReason,
  rowsRewindTargetsOf,
  runPromptRewind,
  type RevealResult,
  type RewindOutcome,
  type RewindPrompt
} from "./rewind.logic";
import {
  createHistoryThreadSelector,
  rewindBusyOf,
  type HistoryThreadInputs
} from "./thread-inputs";

const NO_INDEX_PROMPTS: readonly ThreadPromptEntry[] = [];

/**
 * A panel's prompt-index caches: one per daemon connection, held for as long
 * as the panel lives — so switching to another chat and back reuses the pages
 * fetched for it. Created by the panel without touching the app context, so
 * the panel's no-chat state renders anywhere.
 */
export class PromptIndexCaches {
  private readonly byApi = new WeakMap<ApiClient, PromptIndexCache>();

  forApi(api: ApiClient): PromptIndexCache {
    let cache = this.byApi.get(api);
    if (cache === undefined) {
      cache = new PromptIndexCache({
        page: (sessionId, query) => api.agentChatPrompts(sessionId, query),
        text: (sessionId, messageId) => api.agentChatPromptText(sessionId, messageId)
      });
      this.byApi.set(api, cache);
    }
    return cache;
  }
}

/** The panel's cache for the current daemon connection. */
export function usePromptIndexCache(caches: PromptIndexCaches): PromptIndexCache {
  const api = useApi();
  return useMemo(() => caches.forApi(api), [caches, api]);
}

/**
 * Whether `path` is inside a git work tree, asked only while `enabled` — the
 * empty Checkpoints view's hint. `null` until known, and on any failure.
 */
export function useIsGitRepo(path: string | null, enabled: boolean): boolean | null {
  const api = useApi();
  const [answer, setAnswer] = useState<{ path: string; isRepo: boolean } | null>(null);
  useEffect(() => {
    if (!enabled || path === null || path.length === 0) {
      return;
    }
    let current = true;
    api
      .gitStatus(path)
      .then((status) => {
        if (current) setAnswer({ path, isRepo: status.isRepo });
      })
      .catch(() => {
        // Unknown: the hint stays the generic one.
      });
    return () => {
      current = false;
    };
  }, [api, enabled, path]);
  return answer !== null && answer.path === path ? answer.isRepo : null;
}

/**
 * The session's index pages: asks for the first one the first time a session
 * is shown, and — while the host's index is still catching up with the thread
 * — asks again by itself, backing off, for as long as the panel shows it
 * (`scheduleCatchUpReask`; the effect's cleanup stops it).
 */
export function usePromptIndex(cache: PromptIndexCache, sessionId: string): PromptIndexState | undefined {
  useEffect(() => {
    cache.ensure(sessionId);
  }, [cache, sessionId]);
  const state = useSyncExternalStore(
    cache.subscribe,
    () => cache.get(sessionId),
    () => cache.get(sessionId)
  );
  useEffect(() => scheduleCatchUpReask(cache, sessionId, state) ?? undefined, [cache, sessionId, state]);
  return state;
}

/**
 * Fetch the session's older index pages by themselves: while `searching`, one
 * after another up to `SEARCH_PROMPT_CAP` (`searchWantsOlder`), so a search
 * finds a prompt from anywhere in the thread; otherwise until the list holds a
 * page's worth of prompts (`fillWantsOlder`), because a page can come back
 * short or empty with more behind it. Each landing page changes `state`,
 * which asks for the next one.
 */
export function useAutoLoadsOlder(
  cache: PromptIndexCache,
  sessionId: string,
  state: PromptIndexState | undefined,
  searching: boolean
): void {
  useEffect(() => {
    if (searching ? searchWantsOlder(state) : fillWantsOlder(state)) {
      cache.loadOlder(sessionId, searching ? SEARCH_PAGE_LIMIT : PROMPT_PAGE_LIMIT);
    }
  }, [cache, sessionId, state, searching]);
}

/**
 * The whole text of a prompt the index cut, fetched while `messageId` is set
 * (the card is open). `undefined` for a prompt that needs no fetch.
 */
export function usePromptText(
  cache: PromptIndexCache,
  sessionId: string,
  messageId: string | null
): PromptTextState | undefined {
  useEffect(() => {
    if (messageId !== null) cache.ensureText(sessionId, messageId);
  }, [cache, sessionId, messageId]);
  return useSyncExternalStore(
    cache.subscribe,
    () => (messageId === null ? undefined : cache.text(sessionId, messageId)),
    () => (messageId === null ? undefined : cache.text(sessionId, messageId))
  );
}

export interface PromptHistoryModel {
  thread: HistoryThreadInputs;
  index: PromptIndexState | undefined;
  /** Newest first: what the chat has loaded, then what the index adds. */
  prompts: readonly HistoryPrompt[];
  /** Turn id → its `ready` checkpoint. */
  checkpointByTurnId: ReadonlyMap<string, Checkpoint>;
  /** One per `ready` checkpoint, newest first. */
  checkpoints: readonly CheckpointEntry[];
  startedTurnCount: number;
  /** The adapter can roll the conversation back (and its snapshot is known). */
  rollbackSupported: boolean;
  /** Bring a turn on screen in the chat (`revealTurn`), or say why it could not be. Never rejects. */
  jumpTo: (turnId: string) => Promise<RevealResult>;
  /** The whole rewind (`runPromptRewind`); never rejects. */
  rewind: (prompt: RewindPrompt) => Promise<RewindOutcome>;
}

/** Everything the History panel shows for one chat. */
export function usePromptHistory(cache: PromptIndexCache, sessionId: string): PromptHistoryModel {
  const select = useMemo(() => createHistoryThreadSelector(), []);
  const thread = useAgentChatThreadSelector(sessionId, select);
  const provider = useProviderSnapshot(thread.refId);
  const index = usePromptIndex(cache, sessionId);
  // A host that said it has no index is asked once more when the thread's own
  // snapshot says its history IS indexed (it came back with a working one).
  useEffect(() => {
    if (thread.historyIndexed === true) cache.recheckUnindexed(sessionId);
  }, [cache, sessionId, thread.historyIndexed]);

  // The store's own rule (`store.ts` `project`): the capability, and only
  // once the provider's snapshot is known — the rows are stamped the same way.
  const rollbackSupported =
    provider !== null && provider.capabilities?.supportsConversationRollback !== false;

  const knownTurnIds = useMemo(
    () => (thread.hasHead ? knownTurnIdsOf(thread.turns) : null),
    [thread.hasHead, thread.turns]
  );
  const ordinals = useMemo(() => turnOrdinalsOf(thread.turns), [thread.turns]);
  const indexPrompts = index?.status === "ready" ? index.prompts : NO_INDEX_PROMPTS;
  const prompts = useMemo(
    () => mergeHistoryPrompts(thread.loaded.prompts, indexPrompts, knownTurnIds),
    [thread.loaded.prompts, indexPrompts, knownTurnIds]
  );
  const ready = useMemo(
    () => readyCheckpoints(thread.checkpoints, thread.pages),
    [thread.checkpoints, thread.pages]
  );
  const checkpointByTurnId = useMemo(() => checkpointsByTurnId(ready), [ready]);
  const checkpoints = useMemo(
    () =>
      deriveCheckpointEntries({
        ready,
        turns: thread.turns,
        ordinals,
        prompts,
        unlisted: thread.loaded.unlisted
      }),
    [ready, thread.turns, ordinals, prompts, thread.loaded.unlisted]
  );

  const { actions } = thread;
  // `revealTurn` answers only yes or no; the thread right after says why not.
  const jumpTo = useCallback(
    async (turnId: string): Promise<RevealResult> => {
      const shown = await actions.revealTurn(turnId).catch(() => false);
      if (shown) return { shown: true };
      const state = peekThreadStore(sessionId)?.getState();
      return {
        shown: false,
        reason:
          state === undefined
            ? CHAT_NOT_READY
            : revealMissReason({
                turnId,
                connection: state.slice.connection,
                turns: state.slice.turns,
                historyError: state.slice.history.error
              })
      };
    },
    [actions, sessionId]
  );
  const rewind = useCallback(
    (prompt: RewindPrompt) =>
      runPromptRewind({
        prompt,
        // Fresh at every step: the reveal pages history in, and a turn may
        // start while it does.
        read: () => {
          const state = peekThreadStore(sessionId)?.getState();
          return state === undefined
            ? {
                targets: thread.rewind.targets,
                busy: thread.busy,
                isSending: isComposerSending(sessionId),
                rollbackSupported
              }
            : {
                targets: rowsRewindTargetsOf(state.rows),
                busy: rewindBusyOf(state),
                isSending: isComposerSending(sessionId),
                rollbackSupported
              };
        },
        revealTurn: jumpTo,
        rewindTo: (target) => actions.rewindTo(target)
      }),
    [actions, jumpTo, rollbackSupported, sessionId, thread.busy, thread.rewind]
  );

  return {
    thread,
    index,
    prompts,
    checkpointByTurnId,
    checkpoints,
    startedTurnCount: ordinals.size,
    rollbackSupported,
    jumpTo,
    rewind
  };
}
