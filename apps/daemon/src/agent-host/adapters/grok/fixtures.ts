/**
 * Grok adapter — the recorded-capture reader shared by the replay tests
 * (spec §9).
 *
 * The fixtures under `apps/daemon/test/fixtures/grok/` are real ACP traffic
 * from `grok 1.0.34`. This module only reads them; it holds no assertions, so
 * a test can feed the same frames through the normaliser, through the peer, or
 * through the session without duplicating the parser.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const GROK_FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../test/fixtures/grok"
);

interface CaptureEntry {
  /** Milliseconds since the child was spawned. */
  readonly t: number;
  readonly dir: "send" | "recv" | "stderr" | "note";
  readonly frame: unknown;
}

export function readCapture(file: string): CaptureEntry[] {
  return readFileSync(join(GROK_FIXTURES_DIR, file), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CaptureEntry);
}

export interface JsonRpcFrame {
  readonly jsonrpc?: string;
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: unknown };
}

function isJsonRpc(frame: unknown): frame is JsonRpcFrame {
  return frame !== null && typeof frame === "object" && !Array.isArray(frame);
}

/** Every frame the AGENT sent us, in order. */
export function agentFrames(entries: readonly CaptureEntry[]): JsonRpcFrame[] {
  const out: JsonRpcFrame[] = [];
  for (const entry of entries) {
    if (entry.dir !== "recv" || !isJsonRpc(entry.frame)) {
      continue;
    }
    out.push(entry.frame);
  }
  return out;
}

/** The `session/prompt` results of a capture, in order. */
export function promptResults(entries: readonly CaptureEntry[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const frame of agentFrames(entries)) {
    const result = frame.result as { stopReason?: unknown } | undefined;
    if (result !== undefined && typeof result.stopReason === "string") {
      out.push(result as Record<string, unknown>);
    }
  }
  return out;
}
