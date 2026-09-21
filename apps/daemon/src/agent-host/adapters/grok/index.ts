/**
 * Agent host — the Grok adapter (spec §4.5 Grok).
 *
 * **Stub. Package W9 implements this directory.**
 *
 * Shape of the work: one `grok agent stdio` child per thread speaking ACP
 * plus the `x.ai/*` extensions in both spellings; the ACP method catalog is
 * generated under `acp/_generated/` by package X4.
 *
 */

import type { AdapterContext, AdapterFactory, AgentAdapter } from "../../adapter.ts";

export const createGrokAdapter: AdapterFactory = async (
  context: AdapterContext
): Promise<AgentAdapter> => {
  void context;
  throw new Error("agent-chat: grok adapter not implemented (package W9)");
};
