import { z } from "zod";
import type { SessionSummary } from "@orquester/api";
import { agentChatRoutes, THREAD_SEARCH_MAX_QUERY_CHARS, THREAD_SEARCH_MAX_RESULTS, type ThreadSearchHit, type ThreadSearchResponse } from "@orquester/api/agent-chat";
import { resolveProject } from "../addressing.ts";
import type { DaemonApi } from "../daemon-api.ts";
import { ToolError, expectOk } from "../errors.ts";
import { listSessions } from "../reads.ts";
import { capText, clipText, MAX_RESULT_BYTES, resultBytes } from "../result.ts";
import { defineTool, READ_ONLY, type ToolDef } from "../tool.ts";

/**
 * A hit's title, in code points: the longest title create_session and update_session accept, so a title set through
 * the MCP is never cut — only a longer one given in the GUI, which does not bound it.
 */
export const SEARCH_TITLE_CHARS = 300;
/**
 * A hit's snippet, in code points. The host's is FTS5's 12-token excerpt (`agent-host/index/queries.ts`), far shorter
 * in prose or code; only a giant token or a long run of separators — whitespace, rules, box drawing — reaches the cap.
 */
export const SEARCH_SNIPPET_CHARS = 300;

/** The palette's own count per search (`CONVERSATION_SEARCH_LIMIT`). */
const DEFAULT_LIMIT = 20;

/**
 * `indexed: false`: the host could not load or open its thread index, or it is stopping or being replaced (an older
 * host has no search at all). A rebuilt index is not this case: it answers while it catches up, with what it has.
 */
const UNAVAILABLE_HINT = "Search is unavailable on this host right now: the agent host has no usable thread index (it could not load or open one, or it is restarting). Try again later; read_transcript still reads each session.";

interface SearchHitView {
  sessionId: string;
  title: string;
  projectPath: string;
  turn: number | null;
  kind: "message" | "activity";
  role?: "user" | "assistant" | "reasoning";
  activityKind?: string;
  snippet: string;
  at: string;
}

/**
 * The chat sessions open now, by id: the only sessions a hit may name. Every tool addresses a hit by its sessionId, and
 * a terminal tab's id or a closed tab's is not one a chat tool takes (the GUI's palette lists only a tab it has, too).
 */
async function chatSessionsById(api: DaemonApi, projectPath: string | undefined): Promise<Map<string, SessionSummary>> {
  const sessions = await listSessions(api, projectPath);
  return new Map(sessions.filter((s) => s.kind === "agent-chat").map((s) => [s.id, s]));
}

/** A hit in its session's own terms — the title and project list_sessions shows — with the host's snippet and turn. */
function hitView(hit: ThreadSearchHit, session: SessionSummary): SearchHitView {
  const kind = hit.kind === "activity" ? "activity" : "message";
  return {
    sessionId: session.id,
    title: clipText(session.title, SEARCH_TITLE_CHARS),
    projectPath: session.projectPath,
    turn: typeof hit.ordinal === "number" ? hit.ordinal : null,
    kind,
    ...(kind === "message" && hit.role ? { role: hit.role } : {}),
    ...(kind === "activity" && hit.activityKind ? { activityKind: hit.activityKind } : {}),
    snippet: clipText(typeof hit.snippet === "string" ? hit.snippet : "", SEARCH_SNIPPET_CHARS),
    at: hit.at
  };
}

/**
 * The answer, bounded under the result cap: the hits keep the host's rank, best first, and the lowest-ranked go from the
 * end until the rest fits — ok() would otherwise cut the JSON and lose them all. `truncated` is also the host's own
 * "more matches than limit"; `omittedHits` counts only what the cap cut. Linear, as list_conversations' fit is: each
 * hit is measured once, with the comma before it; only the small frame is re-measured, as omittedHits' digits move.
 */
function fitHits(query: string, views: readonly SearchHitView[], moreMatches: boolean): Record<string, unknown> {
  const answer = (hits: readonly SearchHitView[], omitted: number) => ({ query, hits, truncated: moreMatches || omitted > 0, ...(omitted > 0 ? { omittedHits: omitted } : {}), indexed: true });
  const sizes = views.map((view, i) => resultBytes(view) + (i > 0 ? 1 : 0));
  let used = 0;
  let kept = 0;
  // The hits kept are a prefix: the first that does not fit ends it.
  while (kept < views.length && resultBytes(answer([], views.length - kept - 1)) + used + sizes[kept]! <= MAX_RESULT_BYTES) used += sizes[kept++]!;
  return answer(views.slice(0, kept), views.length - kept);
}

const searchSessions = defineTool({
  name: "search_sessions",
  title: "Search every chat",
  description: "Full-text search over every open chat's messages and tool activity (the command palette's ? search), best match first; the snippet marks the match «like this». Read a hit's turn with read_transcript {sessionId, beforeTurn: turn + 1, turns: 1}. truncated:true means more matches than returned: narrow the query or pass project. indexed:false means search is unavailable on this host right now.",
  input: {
    query: z.string().describe(`The words to find, 1–${THREAD_SEARCH_MAX_QUERY_CHARS} characters after trimming. Every word must appear, as a whole word; case and accents are ignored, and quotes, OR, NEAR, * and - are not operators.`),
    project: z.string().optional().describe("Only this project: absolute path or \"<workspace>/<project>\"; omit to search every project."),
    limit: z.number().int().min(1).max(THREAD_SEARCH_MAX_RESULTS).default(DEFAULT_LIMIT).describe(`The most hits to return, best first (max ${THREAD_SEARCH_MAX_RESULTS}); fewer when some would pass the result size cap (omittedHits counts them).`)
  },
  annotations: READ_ONLY,
  async run(args, { api }) {
    const query = args.query.trim();
    if (!query) throw new ToolError("INVALID_ARGUMENT", "The query is empty: pass the words to search for.");
    // Refused, never clipped: the host would cut a longer query silently and answer for words the caller did not send.
    // Counted in code points, as the host and the daemon clamp it: an emoji is one character, not two.
    // `capText` walks no further than one code point past the limit, so a query of megabytes (the schema sets no maximum,
    // and a /mcp body may reach 16 MiB) is refused without being walked or copied whole.
    if (capText(query, THREAD_SEARCH_MAX_QUERY_CHARS).truncated) throw new ToolError("INVALID_ARGUMENT", `The query is longer than the ${THREAD_SEARCH_MAX_QUERY_CHARS}-character limit.`);
    // `!== undefined`, as list_sessions tests it: an empty project is refused by resolveProject, never "every project".
    const projectPath = args.project !== undefined ? (await resolveProject(api, args.project)).path : undefined;
    const res = await api.request("GET", agentChatRoutes.search, { query: { q: query, limit: String(args.limit), ...(projectPath !== undefined ? { projectPath } : {}) } });
    const body = expectOk<ThreadSearchResponse | null>(res, "search");
    // No usable index is an answer, not an error (the host's 200 `indexed: false`); the GUI reads a missing flag so too.
    if (body?.indexed !== true) return { query, hits: [], truncated: false, indexed: false, hint: UNAVAILABLE_HINT };
    const found = Array.isArray(body.hits) ? body.hits : [];
    const chats = found.length ? await chatSessionsById(api, projectPath) : new Map<string, SessionSummary>();
    const views = found.flatMap((hit) => {
      const session = chats.get(hit.threadId);
      return session ? [hitView(hit, session)] : [];
    });
    return fitHits(query, views, body.truncated === true);
  }
});

export const searchTools: ToolDef[] = [searchSessions] as ToolDef[];
