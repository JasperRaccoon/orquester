// The §9 structural assertion: every method present in a recorded capture must map to a
// defined disposition, and an unrecognised one must be visible rather than swallowed.
//
// This guards the catalog, not the adapter: when the fixtures are re-captured against a newer
// Grok CLI, a method that appears with no home here fails the build instead of degrading to
// silent loss.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { ACP_PROTOCOL_VERSION, AGENT_METHODS, CLIENT_METHODS, PROTOCOL_METHODS } from "./meta";
import { ACP_METHOD_CATALOG, AGENT_CALLABLE_METHODS, CLIENT_HANDLED_METHODS } from "./methods";
import { XAI_EXTENSION_CATALOG, xaiMethodSpellings } from "./xai";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../test/fixtures/grok",
);

interface CaptureEntry {
  readonly t: number;
  readonly dir: string;
  readonly frame: unknown;
}

function readCapture(file: string): CaptureEntry[] {
  return readFileSync(join(FIXTURES, file), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CaptureEntry);
}

function captureFiles(): string[] {
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".ndjson"))
    .sort();
}

/** Every legal spelling of every x.ai extension method. */
const XAI_METHOD_NAMES = new Set(
  XAI_EXTENSION_CATALOG.flatMap((entry) => xaiMethodSpellings(entry.method)),
);

const ACP_METHOD_NAMES = new Set<string>(Object.keys(ACP_METHOD_CATALOG));

/**
 * Methods the AGENT sent us. Frames we sent are excluded on purpose:
 * `13-errors-and-rpcs.ndjson` deliberately calls methods that do not exist, to record the
 * error shape, and those must not be expected in the catalog.
 */
function methodsIn(entries: CaptureEntry[]): Set<string> {
  const out = new Set<string>();
  for (const entry of entries) {
    if (entry.dir !== "recv") continue;
    const frame = entry.frame;
    if (typeof frame !== "object" || frame === null) continue;
    const method = (frame as { method?: unknown }).method;
    if (typeof method === "string") out.add(method);
  }
  return out;
}

test("the fixture set is present", () => {
  const files = captureFiles();
  assert.ok(files.length >= 16, `expected the recorded captures, found ${files.length}`);
});

test("every method in every capture maps to a defined disposition", () => {
  const unmapped = new Map<string, string[]>();
  for (const file of captureFiles()) {
    for (const method of methodsIn(readCapture(file))) {
      if (ACP_METHOD_NAMES.has(method)) continue;
      if (XAI_METHOD_NAMES.has(method)) continue;
      const where = unmapped.get(method) ?? [];
      where.push(file);
      unmapped.set(method, where);
    }
  }
  assert.deepEqual(
    [...unmapped.entries()].map(([m, files]) => `${m} (${files.join(", ")})`),
    [],
    "a captured method has no entry in ACP_METHOD_CATALOG or XAI_EXTENSION_CATALOG",
  );
});

test("the captures negotiated the protocol version this catalog describes", () => {
  const entries = readCapture("01-initialize.ndjson");
  const response = entries.find((e) => {
    const f = e.frame as { result?: { protocolVersion?: unknown } } | null;
    return e.dir === "recv" && typeof f?.result?.protocolVersion === "number";
  });
  assert.ok(response, "01-initialize.ndjson has no initialize response");
  const result = (response.frame as { result: { protocolVersion: number } }).result;
  assert.equal(result.protocolVersion, ACP_PROTOCOL_VERSION);
});

test("the method tables agree with the catalog", () => {
  for (const method of Object.values(AGENT_METHODS)) {
    assert.ok(ACP_METHOD_NAMES.has(method), `${method} missing from ACP_METHOD_CATALOG`);
    assert.equal(ACP_METHOD_CATALOG[method].side, "agent");
  }
  for (const method of Object.values(CLIENT_METHODS)) {
    assert.ok(ACP_METHOD_NAMES.has(method), `${method} missing from ACP_METHOD_CATALOG`);
    assert.equal(ACP_METHOD_CATALOG[method].side, "client");
  }
  for (const method of Object.values(PROTOCOL_METHODS)) {
    assert.equal(ACP_METHOD_CATALOG[method].side, "protocol");
  }
  assert.equal(CLIENT_HANDLED_METHODS.length, Object.values(CLIENT_METHODS).length);
  assert.equal(AGENT_CALLABLE_METHODS.length, Object.values(AGENT_METHODS).length);
});

test("session/cancel and session/update are notifications, session/prompt is a request", () => {
  assert.equal(ACP_METHOD_CATALOG["session/cancel"].kind, "notification");
  assert.equal(ACP_METHOD_CATALOG["session/update"].kind, "notification");
  assert.equal(ACP_METHOD_CATALOG["session/prompt"].kind, "request");
  assert.equal(ACP_METHOD_CATALOG["session/prompt"].result, "PromptResponse");
});

test("every x.ai entry marked observed really appears in a capture", () => {
  const seen = new Set<string>();
  for (const file of captureFiles()) {
    for (const method of methodsIn(readCapture(file))) seen.add(method);
  }
  for (const entry of XAI_EXTENSION_CATALOG) {
    const spellings = xaiMethodSpellings(entry.method);
    const found = spellings.some((s) => seen.has(s));
    assert.equal(
      found,
      entry.observed,
      `XAI_EXTENSION_CATALOG says observed=${entry.observed} for ${entry.method}, captures say ${found}`,
    );
    if (entry.observed && entry.observedSpelling !== null) {
      const expected = entry.observedSpelling === "bare" ? spellings[0] : spellings[1];
      assert.ok(seen.has(expected), `${entry.method} was not seen in its recorded spelling`);
    }
  }
});

test("no capture leaks a credential-shaped value", () => {
  // The MCP roster notification echoes the host's real environment; the export redacts it.
  const forbidden = [
    /ATATT3[A-Za-z0-9]/,
    /\/var\/lib\/orquester/,
    /\bBearer\s+[A-Za-z0-9._-]{8,}/,
    /\b(?:sk|ghp|gho)-[A-Za-z0-9_-]{12,}/,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  ];
  for (const file of captureFiles()) {
    const text = readFileSync(join(FIXTURES, file), "utf8");
    for (const pattern of forbidden) {
      assert.equal(pattern.test(text), false, `${file} matches ${pattern}`);
    }
  }
});

test("the MCP roster notification carries no environment values", () => {
  for (const file of captureFiles()) {
    for (const entry of readCapture(file)) {
      const frame = entry.frame as { method?: string; params?: { mcpServers?: unknown } } | null;
      if (frame?.method !== "_x.ai/mcp/servers_updated") continue;
      const servers = frame.params?.mcpServers;
      assert.ok(Array.isArray(servers));
      for (const server of servers as Array<{ env?: Array<{ value?: unknown }> }>) {
        for (const kv of server.env ?? []) {
          assert.equal(kv.value, "<redacted>", `${file} kept an MCP env value`);
        }
      }
    }
  }
});

test("every method the adapter registers exists in a catalog", async () => {
  // R4 #19: the catalog is checked against the fixtures both ways, but nothing
  // tied the ADAPTER's registrations to it — a typo'd name would register a
  // handler that can never fire.
  const { GROK_REGISTERED_METHODS } = await import("../../session.ts");
  const known = new Set<string>([
    ...Object.keys(ACP_METHOD_CATALOG),
    ...XAI_EXTENSION_CATALOG.flatMap((entry) => xaiMethodSpellings(entry.method))
  ]);
  const unknown = GROK_REGISTERED_METHODS.filter((method) => !known.has(method));
  assert.deepEqual(unknown, [], "a registered handler names a method no catalog knows");
});

test("every extension the captures observed has a handler", async () => {
  const { GROK_REGISTERED_METHODS } = await import("../../session.ts");
  const registered = new Set(GROK_REGISTERED_METHODS);
  // Product payloads are registered precisely so they do NOT warn; the ones
  // below are the entries that carry state the adapter must act on.
  const mustHandle = ["x.ai/session_notification", "x.ai/session/update", "x.ai/session/prompt_complete"];
  for (const entry of XAI_EXTENSION_CATALOG) {
    if (!entry.observed || !mustHandle.includes(entry.method)) {
      continue;
    }
    const spellings = xaiMethodSpellings(entry.method);
    assert.ok(
      spellings.some((spelling) => registered.has(spelling)),
      `${entry.method} is observed but has no handler`
    );
  }
});
