// Builds meta.ts for the committed Codex protocol bindings out of the generator's own output.
// Run:  node build-meta.mjs <ts-exp-dir> <ts-stable-dir> <out-file> <cliVersion>
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const [, , EXP, STABLE, OUT, CLI_VERSION] = process.argv;

const read = (p) => readFileSync(p, "utf8");

/** Parse a `ts-rs` union of `{ "method": "x", id: RequestId, params: T, }` arms. */
function parseRequestUnion(src, exportName) {
  const i = src.indexOf(`export type ${exportName} =`);
  if (i < 0) throw new Error(`${exportName} not found`);
  const body = src.slice(i);
  const out = [];
  const re = /\{\s*"method":\s*"([^"]+)",\s*id:\s*RequestId,\s*params\??:\s*([A-Za-z0-9_]+)(?:\s*\|\s*undefined)?\s*,?\s*\}/g;
  let m;
  while ((m = re.exec(body))) out.push({ method: m[1], params: m[2] === "undefined" ? null : m[2] });
  return out;
}

/** Parse the `ServerNotificationEnvelope` union of `{ "method": "x", "params": T }` arms. */
function parseNotificationUnion(src) {
  const i = src.indexOf("export type ServerNotificationEnvelope =");
  if (i < 0) throw new Error("ServerNotificationEnvelope not found");
  const body = src.slice(i);
  const out = [];
  const re = /\{\s*"method":\s*"([^"]+)",\s*"params":\s*([A-Za-z0-9_]+)\s*\}/g;
  let m;
  while ((m = re.exec(body))) out.push({ method: m[1], params: m[2] });
  return out;
}

function parseClientNotifications(src) {
  const i = src.indexOf("export type ClientNotification =");
  const body = src.slice(i);
  const out = [];
  const re = /\{\s*"method":\s*"([^"]+)"(?:,\s*params\??:\s*([A-Za-z0-9_]+))?\s*\}/g;
  let m;
  while ((m = re.exec(body))) out.push({ method: m[1], params: m[2] ?? null });
  return out;
}

/** Map every exported type name -> its module path relative to ./protocol. */
function typeIndex(dir) {
  const index = new Map();
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".ts") && f !== "index.ts") index.set(f.slice(0, -3), f.slice(0, -3));
  }
  if (existsSync(path.join(dir, "v2"))) {
    for (const f of readdirSync(path.join(dir, "v2"))) {
      if (f.endsWith(".ts") && f !== "index.ts") {
        const name = f.slice(0, -3);
        // v2 wins only when the root does not already define the name; both are recorded.
        index.set(`v2:${name}`, `v2/${name}`);
      }
    }
  }
  return index;
}

const idx = typeIndex(EXP);
const resolveType = (name) => {
  if (idx.has(name)) return { name, module: idx.get(name), ns: "root" };
  if (idx.has(`v2:${name}`)) return { name, module: idx.get(`v2:${name}`), ns: "v2" };
  return null;
};

const expClientRequests = parseRequestUnion(read(path.join(EXP, "ClientRequest.ts")), "ClientRequest");
const expServerRequests = parseRequestUnion(read(path.join(EXP, "ServerRequest.ts")), "ServerRequest");
const expServerNotifications = parseNotificationUnion(read(path.join(EXP, "ServerNotificationEnvelope.ts")));
const expClientNotifications = parseClientNotifications(read(path.join(EXP, "ClientNotification.ts")));

const stableClientRequests = new Set(
  parseRequestUnion(read(path.join(STABLE, "ClientRequest.ts")), "ClientRequest").map((e) => e.method),
);
const stableServerRequests = new Set(
  parseRequestUnion(read(path.join(STABLE, "ServerRequest.ts")), "ServerRequest").map((e) => e.method),
);
const stableServerNotifications = new Set(
  parseNotificationUnion(read(path.join(STABLE, "ServerNotificationEnvelope.ts"))).map((e) => e.method),
);

/**
 * Six methods whose result type the `Params`->`Response` rule cannot reach, resolved by hand
 * against the generated file list (and cross-checked against T3's meta.gen.ts).
 */
const RESULT_OVERRIDES = {
  "config/mcpServer/reload": "McpServerRefreshResponse",
  "account/logout": "LogoutAccountResponse",
  "account/workspaceMessages/read": "GetWorkspaceMessagesResponse",
  "externalAgentConfig/import/readHistories": "ExternalAgentConfigImportHistoriesReadResponse",
  "config/value/write": "ConfigWriteResponse",
  "config/batchWrite": "ConfigWriteResponse",
};

/** `FooParams` -> `FooResponse`; else derive from the method path. */
function responseFor(method, paramsType) {
  const candidates = [];
  if (RESULT_OVERRIDES[method]) candidates.push(RESULT_OVERRIDES[method]);
  if (paramsType?.endsWith("Params")) candidates.push(paramsType.slice(0, -"Params".length) + "Response");
  const camel = method
    .split(/[/_]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  candidates.push(camel + "Response", camel);
  for (const c of candidates) {
    const hit = resolveType(c);
    if (hit) return hit;
  }
  return null;
}

const unresolved = [];
function entry(method, paramsType, { withResponse }) {
  const params = paramsType ? resolveType(paramsType) : null;
  if (paramsType && !params) unresolved.push(`params ${paramsType} (${method})`);
  const response = withResponse ? responseFor(method, paramsType) : null;
  if (withResponse && !response) unresolved.push(`response for ${method}`);
  return { method, params, response };
}

const clientRequests = expClientRequests.map((e) => entry(e.method, e.params, { withResponse: true }));
const serverRequests = expServerRequests.map((e) => entry(e.method, e.params, { withResponse: true }));
const serverNotifications = expServerNotifications.map((e) => entry(e.method, e.params, { withResponse: false }));
const clientNotifications = expClientNotifications.map((e) => entry(e.method, e.params, { withResponse: false }));

if (unresolved.length) {
  console.error("UNRESOLVED:\n  " + unresolved.join("\n  "));
}

const imports = new Map(); // alias -> module
function alias(ref) {
  if (!ref) return "undefined";
  const a = ref.ns === "v2" ? `V2${ref.name}` : ref.name;
  imports.set(a, ref.module);
  return a;
}

// Pre-resolve aliases so the import block is complete before rendering.
for (const list of [clientRequests, serverRequests, serverNotifications, clientNotifications]) {
  for (const e of list) {
    e.paramsAlias = alias(e.params);
    e.responseAlias = alias(e.response);
  }
}

const key = (m) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(m) ? m : JSON.stringify(m));

const methodConst = (name, entries, doc) =>
  `/** ${doc} */\nexport const ${name} = {\n` +
  entries.map((e) => `  ${key(e.method)}: ${JSON.stringify(e.method)},`).join("\n") +
  `\n} as const;\n`;

const nameConst = (name, entries, field, doc) =>
  `/** ${doc} */\nexport const ${name} = {\n` +
  entries
    .map((e) => `  ${key(e.method)}: ${JSON.stringify(e[field] ? (e[field].ns === "v2" ? "v2/" : "") + e[field].name : null)},`)
    .join("\n") +
  `\n} as const;\n`;

const ifaceMap = (name, entries, field, doc) =>
  `/** ${doc} */\nexport interface ${name} {\n` +
  entries.map((e) => `  readonly ${key(e.method)}: ${e[field] ?? "undefined"};`).join("\n") +
  `\n}\n`;

const experimentalOnly = (entries, stableSet) => entries.filter((e) => !stableSet.has(e.method)).map((e) => e.method);

const expOnlyClient = experimentalOnly(clientRequests, stableClientRequests);
const expOnlyServerReq = experimentalOnly(serverRequests, stableServerRequests);
const expOnlyNotif = experimentalOnly(serverNotifications, stableServerNotifications);

const importBlock = [...imports.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([a, mod]) => {
    const base = mod.split("/").pop();
    return a === base
      ? `import type { ${base} } from "./protocol/${mod}";`
      : `import type { ${base} as ${a} } from "./protocol/${mod}";`;
  })
  .join("\n");

const out = `// GENERATED — do not edit by hand. See ./README.md for the regeneration commands.
// Source: \`codex app-server generate-ts --experimental\` from codex-cli ${CLI_VERSION}.
//
// The equivalent of T3 Code's \`packages/effect-codex-app-server/src/_generated/meta.gen.ts\`:
// the full method catalogue of the app-server protocol, with the params/result type of every
// client->server request, server->client request and server notification.
//
// Every value here is derived mechanically from ./protocol, so the "every method in a capture
// routes somewhere" assertion of spec §9 can be written against it.

${importBlock}

${methodConst("CLIENT_REQUEST_METHODS", clientRequests, "Every client->server request method.")}
${methodConst("CLIENT_NOTIFICATION_METHODS", clientNotifications, "Every client->server notification method.")}
${methodConst("SERVER_REQUEST_METHODS", serverRequests, "Every server->client request method. Each one MUST be answered or the turn wedges.")}
${methodConst("SERVER_NOTIFICATION_METHODS", serverNotifications, "Every server->client notification method.")}
${nameConst("CLIENT_REQUEST_PARAM_TYPES", clientRequests, "params", "method -> params type name (as it is spelled in ./protocol).")}
${nameConst("CLIENT_REQUEST_RESULT_TYPES", clientRequests, "response", "method -> result type name.")}
${nameConst("SERVER_REQUEST_PARAM_TYPES", serverRequests, "params", "method -> params type name.")}
${nameConst("SERVER_REQUEST_RESULT_TYPES", serverRequests, "response", "method -> result type name; this is the shape WE must send back.")}
${nameConst("SERVER_NOTIFICATION_PARAM_TYPES", serverNotifications, "params", "method -> params type name.")}
${ifaceMap("ClientRequestParamsByMethod", clientRequests, "paramsAlias", "Typed params map for client->server requests.")}
${ifaceMap("ClientRequestResultsByMethod", clientRequests, "responseAlias", "Typed result map for client->server requests.")}
${ifaceMap("ServerRequestParamsByMethod", serverRequests, "paramsAlias", "Typed params map for server->client requests.")}
${ifaceMap("ServerRequestResultsByMethod", serverRequests, "responseAlias", "Typed result map for server->client requests.")}
${ifaceMap("ServerNotificationParamsByMethod", serverNotifications, "paramsAlias", "Typed params map for server notifications.")}
export type ClientRequestMethod = keyof typeof CLIENT_REQUEST_METHODS;
export type ClientNotificationMethod = keyof typeof CLIENT_NOTIFICATION_METHODS;
export type ServerRequestMethod = keyof typeof SERVER_REQUEST_METHODS;
export type ServerNotificationMethod = keyof typeof SERVER_NOTIFICATION_METHODS;

/**
 * Methods and notifications that \`generate-ts\` emits ONLY with \`--experimental\`.
 * The stable generator output omits them, but the shipped server answers several of them
 * (see ./README.md, "Stable vs --experimental"), so the bindings are generated with
 * \`--experimental\` and the gap is recorded here instead of being silently lost.
 */
export const EXPERIMENTAL_ONLY_CLIENT_REQUEST_METHODS = ${JSON.stringify(expOnlyClient, null, 2).replace(/\n/g, "\n")} as const;
export const EXPERIMENTAL_ONLY_SERVER_REQUEST_METHODS = ${JSON.stringify(expOnlyServerReq, null, 2)} as const;
export const EXPERIMENTAL_ONLY_SERVER_NOTIFICATION_METHODS = ${JSON.stringify(expOnlyNotif, null, 2)} as const;

/** The codex-cli release these bindings were generated from. */
export const CODEX_PROTOCOL_CLI_VERSION = ${JSON.stringify(CLI_VERSION)};
`;

const { writeFileSync } = await import("node:fs");
writeFileSync(OUT, out);
console.log(
  `wrote ${OUT}: ${clientRequests.length} client requests, ${serverRequests.length} server requests, ` +
    `${serverNotifications.length} notifications, ${clientNotifications.length} client notifications`,
);
console.log("experimental-only client requests:", expOnlyClient.length);
console.log("experimental-only server requests:", expOnlyServerReq.length);
console.log("experimental-only notifications:", expOnlyNotif.length);
