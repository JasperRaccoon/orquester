// Barrel for the generated `codex app-server` protocol bindings.
// Everything under ./protocol is verbatim generator output; ./meta.ts is derived from it.
// See ./README.md for the exact regeneration commands.
//
// Usage:
//   import { type CodexProtocol, SERVER_REQUEST_METHODS } from "…/_generated";
//   type StartParams = CodexProtocol.v2.ThreadStartParams;

export type * as CodexProtocol from "./protocol";
export * from "./meta";
