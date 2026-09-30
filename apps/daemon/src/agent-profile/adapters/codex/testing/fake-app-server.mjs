// A fake `codex app-server` for the Codex profile adapter's tests: the subset
// of the v2 config API the adapter calls, over the real framing (NDJSON, no
// `jsonrpc` field, `initialize` first), backed by a real `config.toml` under
// `$CODEX_HOME` edited with a comment-preserving TOML library, the way
// codex-cli 0.155.1 behaves on a temp home (shapes observed 2026-09-28).
//
// Env: CODEX_HOME, HOME (as the client sets them); FAKE_CODEX_LOG — append
// every request as one JSON line; FAKE_CODEX_HANG — comma-separated methods
// never answered.
//
// Run as `node fake-app-server.mjs app-server`.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { parse, patch, stringify } from "@decimalturn/toml-patch";

// Codex canonicalizes a CODEX_HOME it is given: hook state keys spell the realpath.
const CODEX_HOME = (() => {
  try {
    return realpathSync(process.env.CODEX_HOME);
  } catch {
    return process.env.CODEX_HOME;
  }
})();
const HOME = process.env.HOME;
const CONFIG = join(CODEX_HOME, "config.toml");
const HANG = new Set((process.env.FAKE_CODEX_HANG ?? "").split(",").filter(Boolean));

class RpcError extends Error {
  constructor(message, data, code = -32600) {
    super(message);
    this.data = data;
    this.code = code;
  }
}

// --- config.toml ----------------------------------------------------------

function readConfigText() {
  try {
    return readFileSync(CONFIG, "utf8");
  } catch {
    return "";
  }
}

const version = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

function readConfig() {
  const text = readConfigText();
  try {
    return { text, config: text.trim() === "" ? {} : parse(text) };
  } catch (error) {
    throw new RpcError(`failed to read configuration layers: ${CONFIG}: ${error.message}`, undefined, -32603);
  }
}

function writeConfig(before, config) {
  validate(config);
  const text = before.trim() === "" ? stringify(config) : patch(before, config);
  // writeFileSync follows a symlinked config.toml to its target and keeps the mode.
  writeFileSync(CONFIG, text, existsSync(CONFIG) ? undefined : { mode: 0o600 });
  return version(text);
}

function validate(config) {
  for (const [name, server] of Object.entries(config.mcp_servers ?? {})) {
    const stdio = ["command", "args", "env", "env_vars", "cwd"].filter((k) => k in server);
    const http = ["url", "bearer_token_env_var", "http_headers", "env_http_headers"].filter((k) => k in server);
    if (http.includes("url") && stdio.length > 0) {
      throw new RpcError(`Invalid configuration: ${stdio[0]} is not supported for streamable_http\nin \`mcp_servers.${name}\`\n`, {
        config_write_error_code: "configValidationError"
      });
    }
    if (!http.includes("url") && http.length > 0) {
      throw new RpcError(`Invalid configuration: ${http[0]} is not supported for stdio\nin \`mcp_servers.${name}\`\n`, {
        config_write_error_code: "configValidationError"
      });
    }
  }
}

function parseKeyPath(path) {
  const segments = [];
  let i = 0;
  while (i < path.length) {
    if (path[i] === '"') {
      let out = "";
      i += 1;
      while (path[i] !== '"') {
        if (path[i] === "\\") i += 1;
        out += path[i];
        i += 1;
      }
      i += 1;
      segments.push(out);
    } else {
      const end = path.indexOf(".", i);
      segments.push(path.slice(i, end === -1 ? path.length : end));
      i = end === -1 ? path.length : end;
    }
    if (path[i] === ".") i += 1;
  }
  return segments;
}

function applyEdit(config, { keyPath, value, mergeStrategy }) {
  const segments = parseKeyPath(keyPath);
  let node = config;
  for (const segment of segments.slice(0, -1)) {
    if (typeof node[segment] !== "object" || node[segment] === null) {
      if (value === null) return;
      node[segment] = {};
    }
    node = node[segment];
  }
  const last = segments.at(-1);
  if (value === null) {
    delete node[last];
  } else if (mergeStrategy === "upsert" && typeof node[last] === "object" && typeof value === "object") {
    node[last] = { ...node[last], ...value };
  } else {
    node[last] = structuredClone(value);
  }
}

// --- skills -----------------------------------------------------------------

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  const out = {};
  for (const line of match?.[1].split("\n") ?? []) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

function scanSkillDir(root, scope, extra = {}) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root).sort()) {
    if (name.startsWith(".")) continue;
    const file = join(root, name, "SKILL.md");
    if (!existsSync(file)) continue;
    const fm = frontmatter(readFileSync(file, "utf8"));
    out.push({
      name: extra.prefix ? `${extra.prefix}:${fm.name ?? name}` : (fm.name ?? name),
      description: fm.description ?? "",
      path: realpathSync(file),
      scope,
      pluginId: extra.pluginId ?? null
    });
  }
  return out;
}

function skillEnabled(config, skill) {
  let enabled = true;
  for (const entry of config.skills?.config ?? []) {
    if (entry.path === skill.path || entry.name === skill.name) enabled = entry.enabled;
  }
  return enabled;
}

function listSkills() {
  const { config } = readConfig();
  const skills = [
    ...scanSkillDir(join(CODEX_HOME, "skills"), "user"),
    ...scanSkillDir(join(HOME, ".agents", "skills"), "user"),
    ...scanSkillDir(join(CODEX_HOME, "skills", ".system"), "system")
  ];
  for (const plugin of installedPlugins(config)) {
    if (!plugin.enabled) continue;
    skills.push(...scanSkillDir(join(plugin.cacheDir, "skills"), "user", { prefix: plugin.name, pluginId: plugin.id }));
  }
  return skills.map((skill) => ({ ...skill, enabled: skillEnabled(config, skill) }));
}

// --- hooks --------------------------------------------------------------

const snake = (event) => event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}

function hookHash(eventSnake, handler, matcher) {
  const short = eventSnake === "session_end" || eventSnake === "interrupt";
  let timeout = typeof handler.timeout === "number" ? handler.timeout : short ? 1 : 600;
  timeout = Math.max(1, timeout);
  if (short) timeout = Math.min(3, timeout);
  const normalized = { type: "command", command: handler.command, timeout, async: handler.async === true };
  if (typeof handler.statusMessage === "string") normalized.statusMessage = handler.statusMessage;
  const identity = { event_name: eventSnake, hooks: [normalized] };
  if (matcher !== undefined && !["user_prompt_submit", "stop", "interrupt"].includes(eventSnake)) identity.matcher = matcher;
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(identity))).digest("hex")}`;
}

function listHooks() {
  const path = join(CODEX_HOME, "hooks.json");
  if (!existsSync(path)) return [];
  const { config } = readConfig();
  const state = config.hooks?.state ?? {};
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const out = [];
  for (const [event, groups] of Object.entries(doc.hooks ?? {})) {
    groups.forEach((group, g) => {
      (group.hooks ?? []).forEach((handler, h) => {
        if (handler.type !== "command") return;
        const key = `${path}:${snake(event)}:${g}:${h}`;
        const currentHash = hookHash(snake(event), handler, group.matcher);
        const entry = state[key] ?? {};
        out.push({
          key,
          eventName: snake(event).replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
          handlerType: "command",
          command: handler.command,
          async: handler.async === true,
          matcher: group.matcher ?? null,
          timeoutSec: handler.timeout ?? 600,
          statusMessage: handler.statusMessage ?? null,
          sourcePath: path,
          source: "user",
          pluginId: null,
          enabled: entry.enabled !== false,
          isManaged: false,
          currentHash,
          trustStatus: entry.trusted_hash === undefined ? "untrusted" : entry.trusted_hash === currentHash ? "trusted" : "modified"
        });
      });
    });
  }
  return out;
}

// --- plugins and marketplaces ---------------------------------------------

function marketplaces(config) {
  const out = [];
  for (const [name, entry] of Object.entries(config.marketplaces ?? {})) {
    const path = join(entry.source, ".agents", "plugins", "marketplace.json");
    if (!existsSync(path)) continue;
    out.push({ name, path, root: entry.source, manifest: JSON.parse(readFileSync(path, "utf8")) });
  }
  return out;
}

function pluginSummary(config, marketplace, plugin) {
  const id = `${plugin.name}@${marketplace.name}`;
  const sourceDir = join(marketplace.root, plugin.source.path);
  const manifest = JSON.parse(readFileSync(join(sourceDir, ".codex-plugin", "plugin.json"), "utf8"));
  const cacheDir = join(CODEX_HOME, "plugins", "cache", marketplace.name, plugin.name, manifest.version ?? "local");
  const installed = existsSync(cacheDir);
  const configured = config.plugins?.[id];
  return {
    id,
    remotePluginId: null,
    version: null,
    localVersion: manifest.version ?? null,
    name: plugin.name,
    source: { type: "local", path: sourceDir },
    installed,
    enabled: installed && configured?.enabled !== false,
    interface: { displayName: manifest.interface?.displayName ?? null, shortDescription: manifest.interface?.shortDescription ?? null },
    // Not part of the protocol: the fake's own bookkeeping.
    _sourceDir: sourceDir,
    _cacheDir: cacheDir,
    _manifest: manifest
  };
}

function strip(summary) {
  const { _sourceDir, _cacheDir, _manifest, ...rest } = summary;
  return rest;
}

function installedPlugins(config) {
  return marketplaces(config)
    .flatMap((m) => m.manifest.plugins.map((p) => pluginSummary(config, m, p)))
    .filter((p) => p.installed)
    .map((p) => ({ ...p, cacheDir: p._cacheDir }));
}

function pluginList(onlyInstalled) {
  const { config } = readConfig();
  return {
    marketplaces: marketplaces(config)
      .map((m) => ({
        name: m.name,
        path: m.path,
        interface: { displayName: m.manifest.interface?.displayName ?? null },
        plugins: m.manifest.plugins.map((p) => pluginSummary(config, m, p)).filter((p) => !onlyInstalled || p.installed).map(strip)
      }))
      .filter((m) => !onlyInstalled || m.plugins.length > 0),
    marketplaceLoadErrors: [],
    featuredPluginIds: []
  };
}

function findPlugin(config, pluginName, marketplacePath) {
  for (const m of marketplaces(config)) {
    if (marketplacePath && m.path !== marketplacePath) continue;
    const plugin = m.manifest.plugins.find((p) => p.name === pluginName);
    if (plugin) return { marketplace: m, summary: pluginSummary(config, m, plugin) };
  }
  throw new RpcError(`plugin \`${pluginName}\` was not found`);
}

// --- dispatch ------------------------------------------------------------

const handlers = {
  initialize: () => ({ userAgent: "fake/0.155.1", codexHome: CODEX_HOME, platformFamily: "unix", platformOs: "linux" }),
  "config/read": () => {
    const { text, config } = readConfig();
    return {
      config,
      origins: {},
      layers: [{ name: { type: "user", file: CONFIG, profile: null }, version: version(text), config }]
    };
  },
  "config/batchWrite": ({ edits, expectedVersion }) => {
    const { text, config } = readConfig();
    if (expectedVersion != null && expectedVersion !== version(text)) {
      throw new RpcError("Configuration was modified since last read. Fetch latest version and retry.", {
        config_write_error_code: "configVersionConflict"
      });
    }
    for (const edit of edits) applyEdit(config, edit);
    return { status: "ok", version: writeConfig(text, config), filePath: CONFIG, overriddenMetadata: null };
  },
  "skills/list": ({ cwds }) => ({ data: [{ cwd: cwds?.[0] ?? HOME, skills: listSkills(), errors: [] }] }),
  "skills/config/write": ({ path, name, enabled }) => {
    const { text, config } = readConfig();
    const selector = path ? { path: realpathSync(path) } : { name };
    const entries = (config.skills?.config ?? []).filter((e) => (selector.path ? e.path !== selector.path : e.name !== selector.name));
    if (!enabled) entries.push({ ...selector, enabled: false });
    config.skills = { ...(config.skills ?? {}), config: entries };
    if (entries.length === 0) delete config.skills.config;
    if (Object.keys(config.skills).length === 0) delete config.skills;
    writeConfig(text, config);
    return { effectiveEnabled: enabled };
  },
  "hooks/list": ({ cwds }) => ({ data: [{ cwd: cwds?.[0] ?? HOME, hooks: listHooks(), warnings: [], errors: [] }] }),
  "plugin/list": () => pluginList(false),
  "plugin/installed": () => pluginList(true),
  "plugin/read": ({ pluginName, marketplacePath }) => {
    const { config } = readConfig();
    const { marketplace, summary } = findPlugin(config, pluginName, marketplacePath);
    const mcpFile = join(summary._sourceDir, ".mcp.json");
    return {
      plugin: {
        marketplaceName: marketplace.name,
        marketplacePath: marketplace.path,
        summary: strip(summary),
        description: summary._manifest.description ?? null,
        skills: scanSkillDir(join(summary._sourceDir, "skills"), "user").map((s) => ({ name: `${pluginName}:${s.name}`, path: s.path })),
        hooks: [],
        mcpServers: existsSync(mcpFile) ? Object.keys(JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers ?? {}) : []
      }
    };
  },
  "plugin/install": ({ pluginName, marketplacePath }) => {
    const { text, config } = readConfig();
    const { summary } = findPlugin(config, pluginName, marketplacePath);
    cpSync(summary._sourceDir, summary._cacheDir, { recursive: true });
    config.plugins = { ...(config.plugins ?? {}), [summary.id]: { enabled: true } };
    writeConfig(text, config);
    return { authPolicy: "ON_INSTALL", appsNeedingAuth: [] };
  },
  "plugin/uninstall": ({ pluginId }) => {
    const { text, config } = readConfig();
    const [name, marketplace] = pluginId.split("@");
    rmSync(join(CODEX_HOME, "plugins", "cache", marketplace, name), { recursive: true, force: true });
    if (config.plugins) delete config.plugins[pluginId];
    writeConfig(text, config);
    return {};
  },
  "marketplace/add": ({ source }) => {
    const manifest = join(source, ".agents", "plugins", "marketplace.json");
    if (!source.startsWith("/") || !existsSync(manifest)) {
      throw new RpcError("invalid marketplace source format; expected owner/repo, a git URL, or a local marketplace path");
    }
    const name = JSON.parse(readFileSync(manifest, "utf8")).name;
    const { text, config } = readConfig();
    const alreadyAdded = Boolean(config.marketplaces?.[name]);
    config.marketplaces = { ...(config.marketplaces ?? {}), [name]: { source_type: "local", source } };
    writeConfig(text, config);
    return { marketplaceName: name, installedRoot: source, alreadyAdded };
  },
  "marketplace/remove": ({ marketplaceName }) => {
    const { text, config } = readConfig();
    if (!config.marketplaces?.[marketplaceName]) {
      throw new RpcError(`marketplace \`${marketplaceName}\` is not configured or installed`);
    }
    delete config.marketplaces[marketplaceName];
    writeConfig(text, config);
    return { marketplaceName, installedRoot: null };
  }
};

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

let buffer = "";
let initialized = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim() === "") continue;
    const frame = JSON.parse(line);
    if (frame.id === undefined) continue; // notifications (`initialized`)
    if (process.env.FAKE_CODEX_LOG) {
      appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ pid: process.pid, method: frame.method, params: frame.params })}\n`);
    }
    if (HANG.has(frame.method)) continue;
    if (!initialized && frame.method !== "initialize") {
      send({ id: frame.id, error: { code: -32600, message: "Not initialized" } });
      continue;
    }
    const handler = handlers[frame.method];
    if (!handler) {
      send({ id: frame.id, error: { code: -32600, message: `Invalid request: unknown variant \`${frame.method}\`` } });
      continue;
    }
    try {
      const result = handler(frame.params ?? {});
      if (frame.method === "initialize") initialized = true;
      send({ id: frame.id, result });
    } catch (error) {
      send({
        id: frame.id,
        error: { code: error.code ?? -32603, message: error.message, ...(error.data ? { data: error.data } : {}) }
      });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
