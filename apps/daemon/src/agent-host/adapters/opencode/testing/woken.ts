/**
 * OpenCode adapter — test support: the frames of a parent session a
 * background `task` call's answer wakes, in the order 1.18.32 sends them.
 *
 * Read from the source, not captured (fixtures README observation 27):
 * `TaskTool.injectBackgroundResult` prompts the calling session through
 * `SessionPrompt.prompt` — the path a `prompt_async` takes — with the child's
 * answer as a user message whose one text part is `synthetic`, its id minted
 * by the server; the session then runs its reply: `busy`, the reply's
 * assistant message naming that prompt as its parent, its parts, its
 * completion, and `busy` → `idle` → `session.idle`. Each frame here mirrors
 * fixture 12's own (lines 122-123, 186-187, 197-202, 177-179), which
 * `normalize.replay.test.ts` clones verbatim.
 *
 * Not a `*.test.ts`, so `pnpm test` does not execute it; it is typechecked
 * with the rest of the package.
 */

import type { OpenCodeRawEvent } from "../protocol.ts";

/**
 * When these frames say they happened — `created`, as 1.18.32 stamps a
 * message: milliseconds since the epoch (fixture 12, line 187). A test that
 * reads times runs its clocks from here.
 */
export const WOKEN_AT_MS = 1_789_961_358_831;
const CREATED = WOKEN_AT_MS;

/**
 * The answer a background run's end prompts its caller with: the user
 * message, then its one `synthetic` text part — the `task` tool's envelope
 * naming the child, as `normalize.ts`'s `takeBackgroundResult` reads it.
 */
export function injectedAnswer(input: {
  sessionId: string;
  promptId: string;
  childId: string;
  answer: string;
  description?: string;
}): OpenCodeRawEvent[] {
  return [
    {
      type: "message.updated",
      properties: {
        sessionID: input.sessionId,
        info: {
          id: input.promptId,
          role: "user",
          sessionID: input.sessionId,
          time: { created: CREATED },
          agent: "build",
          model: { providerID: "openrouter", modelID: "google/gemini-3.1-flash-lite" }
        }
      }
    },
    {
      type: "message.part.updated",
      properties: {
        sessionID: input.sessionId,
        part: {
          type: "text",
          synthetic: true,
          text: [
            `<task id="${input.childId}" state="completed">`,
            `<summary>Background task completed: ${input.description ?? "list files"}</summary>`,
            "<task_result>",
            input.answer,
            "</task_result>",
            "</task>"
          ].join("\n"),
          messageID: input.promptId,
          sessionID: input.sessionId,
          id: `prt_${input.promptId}`
        },
        time: CREATED
      }
    }
  ];
}

/** One reply of a woken run, in three stretches a test can feed apart. */
export interface WokenReply {
  /** The run's `busy`, then the reply's assistant message — the frame that names the prompt. */
  begins: OpenCodeRawEvent[];
  /** Its step starting and its text part opening and streaming. */
  streams: OpenCodeRawEvent[];
  /** The text closing, the step finishing (with its tokens), the message finishing and completing. */
  ends: OpenCodeRawEvent[];
}

/** A step's usage, as `step-finish` and the finished message carry it (fixture 12, line 201). */
const TOKENS = { total: 43_950, input: 1_346, output: 13, reasoning: 77, cache: { write: 0, read: 42_514 } };

/** The reply `replyId` answering `promptId` with `text`. */
export function wokenReply(input: {
  sessionId: string;
  promptId: string;
  replyId: string;
  text: string;
}): WokenReply {
  const { sessionId, promptId, replyId, text } = input;
  const info = (over: Record<string, unknown>) => ({
    type: "message.updated",
    properties: {
      sessionID: sessionId,
      info: {
        id: replyId,
        parentID: promptId,
        role: "assistant",
        mode: "build",
        agent: "build",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "google/gemini-3.1-flash-lite",
        providerID: "openrouter",
        time: { created: CREATED },
        sessionID: sessionId,
        ...over
      }
    }
  });
  const part = (fields: Record<string, unknown>) => ({
    type: "message.part.updated",
    properties: {
      sessionID: sessionId,
      part: { messageID: replyId, sessionID: sessionId, ...fields },
      time: CREATED
    }
  });
  const textId = `prt_text_${replyId}`;
  return {
    begins: [
      { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } },
      info({})
    ],
    streams: [
      part({ id: `prt_start_${replyId}`, type: "step-start" }),
      part({ id: textId, type: "text", text: "", time: { start: CREATED } }),
      {
        type: "message.part.delta",
        properties: { sessionID: sessionId, messageID: replyId, partID: textId, field: "text", delta: text }
      }
    ],
    ends: [
      part({ id: textId, type: "text", text, time: { start: CREATED, end: CREATED + 72 } }),
      part({
        id: `prt_step_${replyId}`,
        reason: "stop",
        type: "step-finish",
        tokens: TOKENS,
        cost: 0.00153435
      }),
      info({ cost: 0.00153435, tokens: TOKENS, finish: "stop" }),
      info({ cost: 0.00153435, tokens: TOKENS, finish: "stop", time: { created: CREATED, completed: CREATED + 1_200 } })
    ]
  };
}

/**
 * A compaction's prompt, as 1.18.32's `SessionCompaction.create` writes it: a
 * user message whose one part is `{type: "compaction", auto}` — `auto: false`
 * for a `/compact` (`summarize`, fixture 09 line 89), `auto: true` for the one
 * a run starts itself when its context overflowed (read from the source).
 */
export function compactionPrompt(input: {
  sessionId: string;
  promptId: string;
  auto: boolean;
}): OpenCodeRawEvent[] {
  return [
    {
      type: "message.updated",
      properties: {
        sessionID: input.sessionId,
        info: {
          id: input.promptId,
          role: "user",
          sessionID: input.sessionId,
          agent: "build",
          model: { providerID: "openrouter", modelID: "google/gemini-3.1-flash-lite" },
          time: { created: CREATED }
        }
      }
    },
    {
      type: "message.part.updated",
      properties: {
        sessionID: input.sessionId,
        part: {
          id: `prt_${input.promptId}`,
          messageID: input.promptId,
          sessionID: input.sessionId,
          type: "compaction",
          auto: input.auto
        },
        time: CREATED
      }
    }
  ];
}

/**
 * The summary a compaction writes: an assistant message answering its prompt
 * with `mode` and `agent` `"compaction"` and `summary: true` (fixture 09 line
 * 91; `SessionCompaction.process`), streaming like any reply.
 */
export function compactionSummary(input: {
  sessionId: string;
  promptId: string;
  replyId: string;
  text: string;
}): WokenReply {
  const reply = wokenReply(input);
  const asSummary = (frame: OpenCodeRawEvent): OpenCodeRawEvent => {
    const copy = JSON.parse(JSON.stringify(frame)) as {
      type: string;
      properties: { info?: Record<string, unknown> };
    };
    if (copy.type === "message.updated" && copy.properties.info !== undefined) {
      Object.assign(copy.properties.info, { mode: "compaction", agent: "compaction", summary: true });
    }
    return copy;
  };
  return {
    begins: reply.begins.map(asSummary),
    streams: reply.streams.map(asSummary),
    ends: reply.ends.map(asSummary)
  };
}

/**
 * What an automatic compaction writes once its summary is done (read from
 * 1.18.32's `SessionCompaction.process`): the prompt the run goes on with — a
 * user message whose one text part is `synthetic`, marked
 * `metadata.compaction_continue` — then `session.compacted`.
 */
export function compactionContinues(input: { sessionId: string; promptId: string }): OpenCodeRawEvent[] {
  return [
    {
      type: "message.updated",
      properties: {
        sessionID: input.sessionId,
        info: { id: input.promptId, role: "user", sessionID: input.sessionId, agent: "build", time: { created: CREATED } }
      }
    },
    {
      type: "message.part.updated",
      properties: {
        sessionID: input.sessionId,
        part: {
          id: `prt_${input.promptId}`,
          messageID: input.promptId,
          sessionID: input.sessionId,
          type: "text",
          metadata: { compaction_continue: true },
          synthetic: true,
          text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
          time: { start: CREATED, end: CREATED }
        },
        time: CREATED
      }
    },
    { type: "session.compacted", properties: { sessionID: input.sessionId } }
  ];
}

/** The run's end: its last `busy`, then `idle` and `session.idle` (fixture 12, lines 177-179). */
export function runSettles(sessionId: string): OpenCodeRawEvent[] {
  return [
    { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } },
    { type: "session.status", properties: { sessionID: sessionId, status: { type: "idle" } } },
    { type: "session.idle", properties: { sessionID: sessionId } }
  ];
}
