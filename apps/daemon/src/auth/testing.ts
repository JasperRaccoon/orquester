/**
 * Route tests: an in-memory session store holding one live device session, and its bearer. Hand
 * `authSessions` to `createServer`'s services and send `bearer` as the `Authorization` header (or
 * `token` as `?token=`).
 */

import { AuthSessionStore } from "./sessions.ts";

export async function testAuthSessions(): Promise<{ authSessions: AuthSessionStore; token: string; bearer: string }> {
  const authSessions = new AuthSessionStore();
  const { token } = await authSessions.create("device", "route test");
  return { authSessions, token, bearer: `Bearer ${token}` };
}
