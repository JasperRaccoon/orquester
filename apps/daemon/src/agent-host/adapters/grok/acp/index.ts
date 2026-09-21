/**
 * The generic ACP client: a JSON-RPC 2.0 NDJSON duplex peer, its error
 * taxonomy, raw-frame redaction, and the child-process binding.
 *
 * Nothing under this directory knows what Grok is. The vendor surface is the
 * `_generated/xai.ts` catalog plus the adapter one level up.
 */

export * from "./_generated/index.ts";
export * from "./errors.ts";
export * from "./peer.ts";
export * from "./redact.ts";
export * from "./connection.ts";
