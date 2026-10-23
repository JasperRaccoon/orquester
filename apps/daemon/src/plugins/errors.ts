export type PluginsErrorCode =
  | "INVALID_REQUEST"
  | "PLUGINS_UNREADABLE"
  | "PLUGIN_UNSUPPORTED"
  | "PLUGIN_BUSY"
  | "PLUGIN_ENABLED"
  | "NO_PREVIOUS_VERSION"
  | "PLUGIN_BUNDLED";

/** A refusal the routes answer verbatim: `status` with `{ code, message }`. */
export class PluginsError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 500,
    readonly code: PluginsErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PluginsError";
  }
}
