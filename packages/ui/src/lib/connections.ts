import type { RemoteConnectionConfig } from "@orquester/config";
import type { UiConnection } from "../types";
import { asSessionToken } from "./auth";

/**
 * Converters between the persisted remote-server shape (RemoteConnectionConfig,
 * stored on the daemon in remotes.json) and the UI's UiConnection. The local
 * unix daemon connection is implicit and never stored here.
 */
export function toUiConnection(remote: RemoteConnectionConfig): UiConnection {
  return {
    id: remote.id,
    name: remote.name,
    kind: "remote",
    endpoint: remote.baseUrl,
    status: "disconnected",
    // remotes.json may carry a token for this remote (an API token, say). An
    // older build's base64("<user>:<hash>") credential is no token: it would
    // only ever 401, so it is not carried into the client.
    password: asSessionToken(remote.password)
  };
}

export function toRemoteConfig(connection: UiConnection): RemoteConnectionConfig {
  return {
    id: connection.id,
    name: connection.name,
    kind: "remote",
    baseUrl: connection.endpoint,
    password: connection.password
  };
}
