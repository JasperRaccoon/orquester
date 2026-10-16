// Catalog family module `search` (Search: search_sessions) — owned by plan Task 7 (unified MCP, Wave 3; design
// 2026-10-15 §4 row 9, §5.1, §13 b): a content read. A chat caller searches its own project by default; a named other
// project follows the §5.2 matrix (a card where required); `project: "all"` is never carded — below Full access it is
// narrowed to the projects the caller may read without one (`auto`: its workspace; below: its own project).
import { z } from "zod";
import type { SessionSummary } from "@orquester/api";
import { agentChatRoutes, THREAD_SEARCH_MAX_QUERY_CHARS, THREAD_SEARCH_MAX_RESULTS, UNTRUSTED_NOTICE, type ThreadSearchHit, type ThreadSearchResponse } from "@orquester/api/agent-chat";
import { canonicalProject, resolveProject } from "../addressing.ts";
import { defineTool, READ_ONLY, type AnyOrquesterTool, type ScopeClaim, type ThreadCaller } from "../catalog/contract.ts";
import type { DaemonApi } from "../daemon-api.ts";
import { ToolError, expectOk } from "../errors.ts";
import { listSessions } from "../reads.ts";
import { capText, clipText, MAX_RESULT_BYTES, resultBytes } from "../result.ts";
import { canonicalProjects, projectCard } from "./session-access.ts";

/**
 * A hit's title, in code points: the longest title create_session and update_session accept, so a title set through
 * the MCP is never cut — only a longer one given in the GUI, which does not bound it.
 */
const SEARCH_TITLE_CHARS = 300;
/**
 * A hit's snippet, in code points. The host's is FTS5's 12-token excerpt (`agent-host/index/queries.ts`), far shorter
 * in prose or code; only a giant token or a long run of separators — whitespace, rules, box drawing — reaches the cap.
 */
const SEARCH_SNIPPET_CHARS = 300;

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
function fitHits(query: string, views: readonly SearchHitView[], moreMatches: boolean, frame: { before?: Record<string, unknown>; after?: Record<string, unknown> } = {}): Record<string, unknown> {
  const answer = (hits: readonly SearchHitView[], omitted: number) => ({ ...frame.before, query, hits, truncated: moreMatches || omitted > 0, ...(omitted > 0 ? { omittedHits: omitted } : {}), indexed: true, ...frame.after });
  const sizes = views.map((view, i) => resultBytes(view) + (i > 0 ? 1 : 0));
  let used = 0;
  let kept = 0;
  // The hits kept are a prefix: the first that does not fit ends it.
  while (kept < views.length && resultBytes(answer([], views.length - kept - 1)) + used + sizes[kept]! <= MAX_RESULT_BYTES) used += sizes[kept++]!;
  return answer(views.slice(0, kept), views.length - kept);
}

/** Which projects a chat caller's search covers, and how the result names it. */
interface ChatSearchScope {
  searched: "project" | "own-project" | "workspace" | "all";
  /** The host-side filter: one project's path as its tabs spell it, or none. */
  projectPath?: string;
  /** Whether a hit's session may be shown (always false for a tab in no project unless "all" under Full access). */
  allows(session: SessionSummary): boolean;
  excludedProjects?: number;
}

/**
 * A chat caller's search scope (§5.1, §13 b): a named project (the gate judged it), its own project by default, or
 * "all" — every project under Full access, else narrowed to its workspace (`auto`) or its own project (below), with the
 * other projects of open chats counted.
 */
async function chatSearchScope(api: DaemonApi, caller: ThreadCaller, project: string | undefined, sessions: readonly SessionSummary[]): Promise<ChatSearchScope> {
  const projects = await canonicalProjects(api, sessions);
  const projectOf = (s: SessionSummary) => projects.get(s.projectPath) ?? null;
  if (project !== undefined && project !== "all") {
    const ref = await resolveProject(api, project);
    const target = await canonicalProject(api, ref.path);
    return { searched: "project", projectPath: ref.path, allows: (s) => target !== null && projectOf(s)?.canonical === target.canonical };
  }
  const own = (s: SessionSummary) => caller.projectPath !== "" && projectOf(s)?.canonical === caller.projectPath;
  // The own project as the caller's own tab spells it (the host filters on the tab's own path).
  const ownPath = sessions.find((s) => s.id === caller.threadId)?.projectPath || caller.projectPath;
  if (project === undefined) return { searched: "own-project", projectPath: ownPath, allows: own };
  if (caller.runtimeMode === "full-access") return { searched: "all", allows: () => true };
  // Below Full access: another project of the workspace is readable without a card from `auto` (§5.2).
  const workspace = caller.projectPath !== "" && caller.workspace !== "" && caller.runtimeMode === "auto";
  const allows = workspace ? (s: SessionSummary) => own(s) || (caller.projectPath !== "" && projectOf(s)?.workspace === caller.workspace) : own;
  // Counted: the projects with chat tabs left out (search reads chats only).
  const excluded = new Set(sessions.filter((s) => s.kind === "agent-chat" && !allows(s)).flatMap((s) => (projectOf(s) ? [projectOf(s)!.canonical] : [])));
  return { searched: workspace ? "workspace" : "own-project", ...(workspace ? {} : { projectPath: ownPath }), allows, ...(excluded.size > 0 ? { excludedProjects: excluded.size } : {}) };
}

const searchSessions = defineTool({
  name: "search_sessions",
  title: "Search chats",
  description: "Full-text search over chats' messages and tool activity, best first; snippets mark «matches». A hit's turn: read_transcript {sessionId, beforeTurn: turn + 1, turns: 1}. indexed:false: unavailable now.",
  chatNote: "Default: this chat's project; \"all\": what you may read.",
  externalNote: "Default: every project.",
  input: {
    query: z.string().describe("Words; each must appear whole. No operators."),
    project: z.string().optional().describe("\"ws/project\", a path, or \"all\"."),
    limit: z.number().int().min(1).max(THREAD_SEARCH_MAX_RESULTS).default(DEFAULT_LIMIT)
  },
  audiences: ["external", "chat"],
  toolset: "core",
  tier: "read",
  async scope(args, ctx) {
    const claim: ScopeClaim = { projects: [], sessions: [], reads: "content", writes: false, causesTurnIn: [] };
    const { caller } = ctx;
    // "all" is narrowed in run, never carded (§13 b).
    if (caller.kind !== "thread" || args.project === "all") return claim;
    if (args.project === undefined) {
      if (!caller.projectPath) throw new ToolError("INVALID_ARGUMENT", "This chat belongs to no project: pass project, or \"all\".");
      return { ...claim, projects: [caller.projectPath] };
    }
    return { ...claim, projects: [(await resolveProject(ctx.api, args.project)).path] };
  },
  approval: (args, ctx) => projectCard(ctx, args.project ?? "", "search the chats of", [{ label: "Query", value: args.query }]),
  annotations: READ_ONLY,
  resultKind: "json",
  async run(args, { api, caller }) {
    const query = args.query.trim();
    if (!query) throw new ToolError("INVALID_ARGUMENT", "The query is empty: pass the words to search for.");
    // Refused, never clipped: the host would cut a longer query silently and answer for words the caller did not send.
    // Counted in code points, as the host and the daemon clamp it: an emoji is one character, not two.
    // `capText` walks no further than one code point past the limit, so a query of megabytes (the schema sets no maximum,
    // and a /mcp body may reach 16 MiB) is refused without being walked or copied whole.
    if (capText(query, THREAD_SEARCH_MAX_QUERY_CHARS).truncated) throw new ToolError("INVALID_ARGUMENT", `The query is longer than the ${THREAD_SEARCH_MAX_QUERY_CHARS}-character limit.`);
    let projectPath: string | undefined;
    let chat: ChatSearchScope | undefined;
    if (caller.kind === "thread") {
      chat = await chatSearchScope(api, caller, args.project, await listSessions(api));
      projectPath = chat.projectPath;
    } else if (args.project !== undefined && args.project !== "all") {
      // `!== undefined`, as list_sessions tests it: an empty project is refused by resolveProject, never "every project".
      projectPath = (await resolveProject(api, args.project)).path;
    }
    // A search narrowed after the host answered asks for every hit it may keep, then cuts to the caller's limit.
    const narrowedAfter = chat !== undefined && chat.searched === "workspace";
    const res = await api.request("GET", agentChatRoutes.search, { query: { q: query, limit: String(narrowedAfter ? THREAD_SEARCH_MAX_RESULTS : args.limit), ...(projectPath !== undefined ? { projectPath } : {}) } });
    const body = expectOk<ThreadSearchResponse | null>(res);
    const frame = chat ? { searched: chat.searched, ...(chat.excludedProjects !== undefined ? { excludedProjects: chat.excludedProjects } : {}) } : {};
    // No usable index is an answer, not an error (the host's 200 `indexed: false`); the GUI reads a missing flag so too.
    if (body?.indexed !== true) return { query, hits: [], truncated: false, indexed: false, hint: UNAVAILABLE_HINT, ...frame };
    const found = Array.isArray(body.hits) ? body.hits : [];
    const chats = found.length ? await chatSessionsById(api, chat ? undefined : projectPath) : new Map<string, SessionSummary>();
    const views = found.flatMap((hit) => {
      const session = chats.get(hit.threadId);
      // A chat caller sees only hits in sessions its scope allows, whatever the host returned.
      return session && (!chat || chat.allows(session)) ? [hitView(hit, session)] : [];
    });
    const kept = views.slice(0, args.limit);
    const more = body.truncated === true || views.length > kept.length;
    if (!chat || caller.kind !== "thread") return fitHits(query, kept, more);
    const notice = kept.some((view) => view.sessionId !== caller.threadId) ? { notice: UNTRUSTED_NOTICE } : {};
    return fitHits(query, kept, more, { before: notice, after: frame });
  }
});

/** This family in the catalog (`../catalog/index.ts`). */
export const searchFamily: readonly AnyOrquesterTool[] = [searchSessions];
