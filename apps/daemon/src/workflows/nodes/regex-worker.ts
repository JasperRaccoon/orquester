// Automated workflows — the IF / Switch `matches` operator, run OFF the event loop (spec §4).
//
// The pattern guard in @orquester/api (`unsafeRegexReason`) refuses the classic catastrophic shapes,
// but no heuristic catches every slow pattern: `.*foo.*bar` over 100 KB took seconds, `a*a*a*b`
// never finished. A regular expression cannot be interrupted in the thread that runs it, so the
// daemon runs every `matches` search in ONE lazily started worker thread with a hard deadline: past
// it the worker is terminated (the next search starts a fresh one) and the rule reads false, with a
// warning on the block. Searches are serialized — one worker, one search at a time.

import { Worker } from "node:worker_threads";

import type { RuleMatcher, RuleMatchJob } from "@orquester/api";

export const RULE_MATCH_TIMEOUT_MS = 250;

// Plain JavaScript evaluated as the worker's body: no loader, no imports of ours.
const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (message) => {
  let result = false;
  let error;
  try {
    result = new RegExp(message.source, message.flags).test(message.text);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  parentPort.postMessage({ id: message.id, result, error });
});
`;

interface Pending {
  id: number;
  resolve(value: { result: boolean; warning?: string }): void;
}

export interface RegexMatcher {
  match: RuleMatcher;
  /** Terminates the worker (tests, daemon stop); a later search starts a new one. */
  close(): Promise<void>;
}

export function createRegexMatcher(options: { timeoutMs?: number } = {}): RegexMatcher {
  const timeoutMs = options.timeoutMs ?? RULE_MATCH_TIMEOUT_MS;
  let worker: Worker | null = null;
  /** Resolves once the current worker runs: its boot never counts against a search's deadline. */
  let online: Promise<void> = Promise.resolve();
  let pending: Pending | null = null;
  let nextId = 1;
  let chain: Promise<unknown> = Promise.resolve();

  const settle = (value: { result: boolean; warning?: string }): void => {
    const current = pending;
    pending = null;
    current?.resolve(value);
  };

  const ensureWorker = (): Worker => {
    if (worker) return worker;
    const created = new Worker(WORKER_SOURCE, { eval: true });
    created.unref();
    online = new Promise<void>((resolve) => {
      created.once("online", () => resolve());
      created.once("exit", () => resolve());
    });
    created.on("message", (message: { id: number; result: boolean; error?: string }) => {
      if (pending === null || message.id !== pending.id) return;
      settle(
        message.error !== undefined
          ? { result: false, warning: `Rule "matches": the pattern could not be evaluated — ${message.error}` }
          : { result: message.result === true }
      );
    });
    const gone = (): void => {
      // A worker the timeout already replaced ends quietly: its search was settled then.
      if (worker !== created) return;
      worker = null;
      settle({ result: false, warning: `Rule "matches": the pattern could not be evaluated — the regex worker stopped` });
    };
    created.on("error", gone);
    created.on("exit", gone);
    worker = created;
    return created;
  };

  const runOne = async (job: RuleMatchJob): Promise<{ result: boolean; warning?: string }> => {
    try {
      ensureWorker();
    } catch (error) {
      return { result: false, warning: `Rule "matches": the pattern could not be evaluated — ${error instanceof Error ? error.message : String(error)}` };
    }
    await online;
    return new Promise((resolve) => {
      const id = nextId++;
      let timer: ReturnType<typeof setTimeout> | null = null;
      pending = {
        id,
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        }
      };
      let target: Worker;
      try {
        target = ensureWorker();
      } catch (error) {
        settle({ result: false, warning: `Rule "matches": the pattern could not be evaluated — ${error instanceof Error ? error.message : String(error)}` });
        return;
      }
      timer = setTimeout(() => {
        if (pending?.id !== id) return;
        // The search cannot be interrupted: end the worker; the next search starts a fresh one.
        if (worker === target) worker = null;
        settle({
          result: false,
          warning: `Rule "matches": the pattern took longer than ${timeoutMs} ms to search and was stopped; the rule reads false`
        });
        void target.terminate().catch(() => undefined);
      }, timeoutMs);
      target.postMessage({ id, source: job.source, flags: job.flags, text: job.text });
    });
  };

  const match: RuleMatcher = (job) => {
    const next = chain.then(() => runOne(job));
    chain = next.catch(() => undefined);
    return next;
  };

  return {
    match,
    async close() {
      const current = worker;
      worker = null;
      if (current) await current.terminate().catch(() => undefined);
    }
  };
}

let shared: RegexMatcher | null = null;

/** The daemon's one matcher (lazy: no worker exists until a `matches` rule runs). */
export function sharedRegexMatcher(): RegexMatcher {
  shared ??= createRegexMatcher();
  return shared;
}
