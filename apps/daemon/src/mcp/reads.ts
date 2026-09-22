import { randomUUID } from "node:crypto";
import type { SessionSummary } from "@orquester/api";
import type { AgentChatCommandName, ThreadReadResponse, ThreadSnapshotPayload } from "@orquester/api/agent-chat";
import { agentChatCommandPath, agentChatRoutes } from "@orquester/api/agent-chat";
import type { DaemonApi } from "./daemon-api.ts";
import { ToolError, daemonError, expectOk } from "./errors.ts";

export async function listSessions(api: DaemonApi, projectPath?: string): Promise<SessionSummary[]> {
  const res = await api.request("GET", "/api/sessions", projectPath ? { query: { projectPath } } : undefined);
  return expectOk<SessionSummary[]>(res, "sessions");
}

export async function findSession(api: DaemonApi, sessionId: string): Promise<SessionSummary> {
  const found = (await listSessions(api)).find((s) => s.id === sessionId);
  if (!found) throw new ToolError("SESSION_NOT_FOUND", `No session with id "${sessionId}". Use list_sessions.`);
  return found;
}

export async function requireChatSession(api: DaemonApi, sessionId: string): Promise<SessionSummary> {
  const session = await findSession(api, sessionId);
  if (session.kind !== "agent-chat") {
    throw new ToolError("NOT_A_CHAT_SESSION", `Session "${sessionId}" is a ${session.kind === "shell" ? "terminal" : "legacy terminal agent"} tab; this tool needs a chat session.`);
  }
  return session;
}

export async function readThread(api: DaemonApi, sessionId: string): Promise<ThreadSnapshotPayload> {
  const res = await api.request("GET", agentChatRoutes.thread(sessionId));
  const body = expectOk<ThreadReadResponse>(res, "thread");
  if (body.kind !== "snapshot") throw new ToolError("INTERNAL", "Expected a thread snapshot.");
  return body.thread;
}

export function mintCommandId(): string {
  return randomUUID();
}

const defaultRetryDelay = (attempt: number): number => Math.min(4_000, 250 * 2 ** attempt);
const RETRIES = 3;

/**
 * POST a chat command with a fresh commandId; retry 503 HOST_UNAVAILABLE (and
 * a thrown transport error) with the SAME id up to 3 times — the GUI's rule.
 */
export async function sendCommand(api: DaemonApi, sessionId: string, name: AgentChatCommandName | "account", body: Record<string, unknown>, opts?: { retryDelayMs?: (attempt: number) => number }): Promise<{ seq: number }> {
  const path = name === "account" ? agentChatRoutes.account(sessionId) : agentChatCommandPath(sessionId, name);
  const delay = opts?.retryDelayMs ?? defaultRetryDelay;
  const payload = { commandId: mintCommandId(), ...body };
  let last: ToolError | null = null;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    // Wait only between attempts: never before the first, never after the last.
    if (attempt > 0) await new Promise((r) => setTimeout(r, delay(attempt - 1)));
    let res;
    try {
      res = await api.request("POST", path, { body: payload });
    } catch (error) {
      // The exception text can carry a host path: log it here, never hand it to the caller.
      console.error("[mcp] daemon call failed", error);
      last = new ToolError("HOST_UNAVAILABLE", "The daemon call failed.");
      continue;
    }
    if (res.status < 400) return expectOk<{ seq: number }>(res, name);
    const err = daemonError(res);
    if (err.code !== "HOST_UNAVAILABLE") throw err;
    last = err;
  }
  throw last ?? new ToolError("HOST_UNAVAILABLE", "The agent host is restarting.");
}
