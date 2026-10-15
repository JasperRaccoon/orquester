/**
 * The agent-profile panel's list of MCP servers that reach this Orquester's own `/mcp`
 * (`GET /api/agent-profile/daemon-mcp-servers`, both transports): read when the panel opens and
 * again whenever the shown agent's profile moves (`revision`). A daemon without the route (older)
 * or a failed read shows no flags — the chip is information, the denial is the daemon's.
 */

import { useEffect, useState } from "react";

import type { DaemonPointingServer } from "@orquester/api";

import type { ApiClient } from "../../../lib/api-client";
import { parseDaemonMcpServers } from "./daemon-pointing.logic";

export function useDaemonPointingServers(api: Pick<ApiClient, "getDaemonMcpServers">, revision: string | null): DaemonPointingServer[] | null {
  const [servers, setServers] = useState<DaemonPointingServer[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api.getDaemonMcpServers(controller.signal).then(
      (body) => {
        if (!controller.signal.aborted) setServers(parseDaemonMcpServers(body));
      },
      () => {
        if (!controller.signal.aborted) setServers(null);
      }
    );
    return () => controller.abort();
  }, [api, revision]);
  return servers;
}
