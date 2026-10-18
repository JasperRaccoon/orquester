/**
 * Agent Profiles — OpenCode's preparer (spec §6). OWNED BY THE OPENCODE PREPARER TASK: replace `null`
 * with an implementation of {@link SessionProfilePreparer} for `"opencode"` and extend
 * `../manifest/opencode.ts` with what it writes. Until then preparation for OpenCode fails with
 * "not supported yet" — a profile chat never launches unprepared.
 */

import type { SessionProfilePreparer } from "../preparer.ts";

export const opencodePreparer: SessionProfilePreparer<"opencode"> | null = null;
