/**
 * Agent Profiles — a profile's portable `.zip` (spec §5.2 "⋯ → Export") and a new profile made
 * from one (the library's "Import profile from file").
 *
 * ## The format (`SESSION_PROFILE_EXPORT_FORMAT`, version 1)
 *
 *   orquester-export.json   {format, version, exportedAt, secrets}: the marker an import requires
 *   profile.json            the profile's manifest as stored — fields, settings, items with their
 *                           scopes; an MCP server's env / header KEYS only (`envKeys`, `headerKeys`)
 *   instructions.md         when the profile has instructions
 *   skills/<itemId>/…       each skill's directory
 *   commands/<itemId>.md    each command
 *   plugins/<itemId>/…      each plugin's cached files
 *
 * **Secrets are never exported**: `secrets.json` is not in the zip and the manifest never holds a
 * value. A profile made from an export keeps its MCP servers' keys without values: each is skipped
 * at launch ("The value of KEY is missing") until its values are entered again, and the import's
 * notes name them. Items the daemon cannot read are left out of an export.
 *
 * **Credential-looking values are redacted** ({@link redactExportManifest}) — fields the profile
 * keeps verbatim, where users put tokens anyway: an MCP server's `url`, `command`, `args` and
 * `advanced` settings, and a hook's `command`. Heuristics (each value becomes `REDACTED`):
 *   - a URL's userinfo (`https://user:pw@host` → `https://REDACTED@host`) and the value of every
 *     query parameter with a credential name (`?api_key=…&team=eng` keeps `team`);
 *   - a credential-named flag's value: `--token=…`, `--token …` (the next argument / word);
 *   - a credential-named variable assignment: `GITHUB_TOKEN=…`;
 *   - `Bearer …` / `Basic …` / `Token …`, and a credential-named header `X-Api-Key: …`;
 *   - in `advanced`, the string value of every credential-named key.
 * A credential name contains token, secret, password/passwd/pwd, api-key/apikey, access-key,
 * private-key, auth (not "author"), credential or signature, or is `key`/`sig` or ends in `-key`/
 * `_key`/`.key`. The marker lists what was redacted (`redacted`), and an import says so in its
 * notes: those values must be entered again.
 *
 * ## Reading one back — strictly
 * The upload is extracted with the importer's zip rules (`agent-profile/import/zip.ts`: no
 * absolute paths, `..`, symlinks or encrypted entries; ≤ 5 000 entries, ≤ 100 MB). Then anything
 * unexpected refuses the WHOLE file (400 `IMPORT_FAILED`): another top-level entry (a
 * `secrets.json` included), a missing or foreign marker, a manifest that is not version 1 or has
 * an item that does not read, an invalid scope or name, two items clashing, a skill without a
 * readable `SKILL.md`, a command file that does not parse, an empty plugin, or a file under
 * `skills/`, `commands/` or `plugins/` that belongs to no item.
 */

import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  PROFILE_HOOK_EVENTS,
  SESSION_PROFILE_DESCRIPTION_MAX,
  SESSION_PROFILE_EXPORT_FORMAT,
  SESSION_PROFILE_EXPORT_VERSION,
  SESSION_PROFILE_ICON_MAX,
  SESSION_PROFILE_NAME_MAX,
  isValidCommandName,
  isValidMcpServerName,
  isValidSkillName,
  sessionProfileScopeProblem
} from "@orquester/api";
import {
  parseSessionProfileManifest,
  serializeSessionProfileManifest,
  type SessionProfileItemEntry,
  type SessionProfileItemRecord,
  type SessionProfileManifestFile
} from "@orquester/config";
import { profileErrors } from "../agent-profile/errors.ts";
import { parseMarkdownDocument } from "../agent-profile/infra/frontmatter.ts";
import { extractZip } from "../agent-profile/import/zip.ts";
import { buildZip, type ZipEntry } from "./files.ts";
import { profileLayout, PROFILE_INSTRUCTIONS_FILE, PROFILE_MANIFEST_FILE, PROFILE_SKILL_FILE } from "./layout.ts";
import { wireScope } from "./resolve.ts";
import type { SessionProfileExportContent } from "./store.ts";

export const EXPORT_MARKER_FILE = "orquester-export.json";

const ZIP_LIMITS = { maxEntries: 5000, maxBytes: 100 * 1024 * 1024 };
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const TOP_LEVEL = new Set([EXPORT_MARKER_FILE, PROFILE_MANIFEST_FILE, PROFILE_INSTRUCTIONS_FILE, "skills", "commands", "plugins"]);

function refuse(message: string): never {
  throw profileErrors.importFailed(`The profile file was refused: ${message}`);
}

/** `Agent Profile name` → `agent-profile-name.agent-profile.zip`. */
export function exportFileName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "profile"}.agent-profile.zip`;
}

// ---------------------------------------------------------------------------
// Redaction of credential-looking values (see the module header)
// ---------------------------------------------------------------------------

/** What replaces a redacted value. */
export const EXPORT_REDACTED = "REDACTED";

const CREDENTIAL_NAME =
  /token|secret|passw(?:or)?d|pwd|api[-_]?key|access[-_]?key|private[-_]?key|auth(?!or(?:s|ed)?$)|credential|signature|^key$|^sig$|[-_.]key$/i;

function credentialName(name: string): boolean {
  return CREDENTIAL_NAME.test(name.replace(/^-+/, ""));
}

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
/** A quoted or bare shell word. */
const WORD = String.raw`(?:"[^"]*"|'[^']*'|[^\s"']+)`;

function redactUrl(url: string): string {
  return url
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]+@/i, `$1${EXPORT_REDACTED}@`)
    .replace(/([?&;])([^=&#;\s]+)=([^&#;\s]*)/g, (whole, sep: string, name: string) =>
      credentialName(decodeURIComponentSafe(name)) ? `${sep}${name}=${EXPORT_REDACTED}` : whole
    );
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The text rules of the module header, over one argument or one shell command line. */
function redactText(text: string): string {
  return text
    .replace(URL_IN_TEXT, (url) => redactUrl(url))
    .replace(/\b(Bearer|Basic|Token)[ \t]+(?!REDACTED\b)[^\s"']+/g, `$1 ${EXPORT_REDACTED}`)
    .replace(/(^|[\s"'])([\w-]+):[ \t]*(?!(?:Bearer|Basic|Token|REDACTED)\b)(?!\/)([^\s"']+)/g, (whole, lead: string, name: string) =>
      credentialName(name) ? `${lead}${name}: ${EXPORT_REDACTED}` : whole
    )
    .replace(new RegExp(String.raw`(^|\s)(--?[\w.-]+)=${WORD}`, "g"), (whole, lead: string, flag: string) =>
      credentialName(flag) ? `${lead}${flag}=${EXPORT_REDACTED}` : whole
    )
    .replace(new RegExp(String.raw`(^|\s)(--?[\w.-]+)([ \t]+)(?!-)${WORD}`, "g"), (whole, lead: string, flag: string, gap: string) =>
      credentialName(flag) ? `${lead}${flag}${gap}${EXPORT_REDACTED}` : whole
    )
    .replace(new RegExp(String.raw`(^|\s)([A-Za-z_][A-Za-z0-9_]*)=${WORD}`, "g"), (whole, lead: string, name: string) =>
      credentialName(name) ? `${lead}${name}=${EXPORT_REDACTED}` : whole
    );
}

/** An argument list: each argument's text rules, and the argument after a credential-named flag. */
function redactArgs(args: readonly unknown[]): unknown[] {
  return args.map((arg, index) => {
    if (typeof arg !== "string") return arg;
    const previous = index > 0 ? args[index - 1] : undefined;
    if (typeof previous === "string" && /^--?[\w.-]+$/.test(previous) && credentialName(previous) && !arg.startsWith("-")) {
      return EXPORT_REDACTED;
    }
    return redactText(arg);
  });
}

/** `advanced` settings: credential-named keys' strings, and the text rules on every string. */
function redactValue(value: unknown, key: string | null): unknown {
  if (typeof value === "string") return key !== null && credentialName(key) ? EXPORT_REDACTED : redactText(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, null));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, entry]) => [name, redactValue(entry, name)]));
  }
  return value;
}

/**
 * The manifest an export carries: every readable item with its credential-looking values
 * replaced (see the module header), and one line per redacted field (`MCP server "x": its URL`).
 * The stored profile is not touched.
 */
export function redactExportManifest(file: SessionProfileManifestFile): { manifest: SessionProfileManifestFile; redacted: string[] } {
  const redacted: string[] = [];
  const items = file.items.map((entry): SessionProfileItemEntry => {
    if (!entry.ok) return entry;
    const record = entry.record;
    if (record.kind === "mcp") {
      const mcp: Record<string, unknown> = { ...record.mcp };
      const fields: [string, string][] = [];
      if (typeof mcp.url === "string") {
        const next = redactText(mcp.url);
        if (next !== mcp.url) fields.push(["url", "its URL"]);
        mcp.url = next;
      }
      if (typeof mcp.command === "string") {
        const next = redactText(mcp.command);
        if (next !== mcp.command) fields.push(["command", "its command"]);
        mcp.command = next;
      }
      if (Array.isArray(mcp.args)) {
        const next = redactArgs(mcp.args);
        if (JSON.stringify(next) !== JSON.stringify(mcp.args)) fields.push(["args", "its arguments"]);
        mcp.args = next;
      }
      if (mcp.advanced !== undefined) {
        const next = redactValue(mcp.advanced, null);
        if (JSON.stringify(next) !== JSON.stringify(mcp.advanced)) fields.push(["advanced", "its advanced settings"]);
        mcp.advanced = next;
      }
      for (const [, label] of fields) redacted.push(`MCP server "${record.name}": ${label}`);
      return fields.length === 0 ? entry : { ok: true, record: { ...record, mcp: mcp as typeof record.mcp } };
    }
    if (record.kind === "hook" && typeof record.hook.command === "string") {
      const command = redactText(record.hook.command);
      if (command === record.hook.command) return entry;
      redacted.push(`hook "${record.name}": its command`);
      return { ok: true, record: { ...record, hook: { ...record.hook, command } } };
    }
    return entry;
  });
  return { manifest: { manifest: file.manifest, items }, redacted };
}

/** The export `.zip` of `content` (see the module header). */
export function buildProfileExport(content: SessionProfileExportContent, now: Date): Buffer {
  const { manifest, redacted } = redactExportManifest(content.manifest);
  const marker = {
    format: SESSION_PROFILE_EXPORT_FORMAT,
    version: SESSION_PROFILE_EXPORT_VERSION,
    exportedAt: now.toISOString(),
    secrets: "MCP env and header values are not exported: enter them again after importing.",
    ...(redacted.length > 0 ? { redacted } : {})
  };
  const entries: ZipEntry[] = [
    { path: EXPORT_MARKER_FILE, data: Buffer.from(`${JSON.stringify(marker, null, 2)}\n`, "utf8"), mode: 0o644 },
    { path: PROFILE_MANIFEST_FILE, data: Buffer.from(serializeSessionProfileManifest(manifest), "utf8"), mode: 0o644 },
    ...content.files
  ];
  if (entries.length > 65_535) throw profileErrors.importFailed("The profile holds too many files to export.");
  return buildZip(entries, now);
}

/** What {@link readProfileExport} answers; `dispose()` removes the extracted tree (idempotent). */
export interface ReadProfileExport {
  dir: string;
  manifest: SessionProfileManifestFile;
  notes: string[];
  dispose(): Promise<void>;
}

/** Extracts and validates an export `.zip` (see the module header) under `workDir`. */
export async function readProfileExport(zipPath: string, workDir: string): Promise<ReadProfileExport> {
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(workDir, "profile-import-"));
  const dispose = () => rm(root, { recursive: true, force: true }).catch(() => undefined);
  try {
    const dir = join(root, "tree");
    await mkdir(dir, { mode: 0o700 });
    await extractZip(zipPath, dir, ZIP_LIMITS);
    const { manifest, redacted } = await validateExport(dir);
    const notes: string[] = [];
    if (redacted.length > 0) {
      notes.push(`Credential-looking values were replaced with ${EXPORT_REDACTED} in this export: ${redacted.join("; ")}. Enter the real values again.`);
    }
    const needSecrets = manifest.items
      .flatMap((entry) => (entry.ok && entry.record.kind === "mcp" ? [entry.record] : []))
      .filter((record) => record.kind === "mcp" && ((record.mcp.envKeys?.length ?? 0) > 0 || (record.mcp.headerKeys?.length ?? 0) > 0))
      .map((record) => record.name);
    if (needSecrets.length > 0) {
      notes.push(
        `Secret values are never exported: enter them again for ${needSecrets.map((name) => `"${name}"`).join(", ")} (until then ${
          needSecrets.length === 1 ? "it is" : "they are"
        } skipped).`
      );
    }
    return { dir, manifest, notes, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function kindAt(path: string): Promise<"file" | "dir" | null> {
  const st = await lstat(path).catch(() => null);
  if (st === null) return null;
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "file";
  return refuse("it holds something that is not a file or folder.");
}

async function readText(path: string, shown: string): Promise<string> {
  if ((await kindAt(path)) !== "file") refuse(`${shown} is missing.`);
  const st = await lstat(path);
  if (st.size > MAX_TEXT_BYTES) refuse(`${shown} is too large.`);
  return readFile(path, "utf8");
}

async function validateExport(dir: string): Promise<{ manifest: SessionProfileManifestFile; redacted: string[] }> {
  for (const name of await readdir(dir)) {
    if (!TOP_LEVEL.has(name)) refuse(`"${name.slice(0, 80)}" is not part of an Agent Profile export.`);
  }
  let marker: unknown;
  try {
    marker = JSON.parse(await readText(join(dir, EXPORT_MARKER_FILE), EXPORT_MARKER_FILE));
  } catch (error) {
    if (error instanceof SyntaxError) refuse(`${EXPORT_MARKER_FILE} is not JSON.`);
    throw error;
  }
  const record = marker !== null && typeof marker === "object" ? (marker as Record<string, unknown>) : {};
  if (record.format !== SESSION_PROFILE_EXPORT_FORMAT) refuse("it is not an Agent Profile export.");
  if (record.version !== SESSION_PROFILE_EXPORT_VERSION) refuse(`it is a version ${String(record.version).slice(0, 20)} export; this build reads version ${SESSION_PROFILE_EXPORT_VERSION}.`);
  const redacted = Array.isArray(record.redacted)
    ? record.redacted.filter((line): line is string => typeof line === "string").slice(0, 200).map((line) => line.slice(0, 200))
    : [];

  let manifest: SessionProfileManifestFile;
  try {
    manifest = parseSessionProfileManifest(JSON.parse(await readText(join(dir, PROFILE_MANIFEST_FILE), PROFILE_MANIFEST_FILE)));
  } catch (error) {
    if (error instanceof Error && !(error instanceof SyntaxError) && "code" in error) throw error;
    refuse(`${PROFILE_MANIFEST_FILE} does not read (${error instanceof Error ? error.message.slice(0, 200) : "unknown"}).`);
  }
  const { name, description, icon } = manifest.manifest;
  if (name.trim() === "" || name.length > SESSION_PROFILE_NAME_MAX) refuse("its profile name is empty or too long.");
  if (description.length > SESSION_PROFILE_DESCRIPTION_MAX) refuse("its description is too long.");
  if (icon !== undefined && icon.length > SESSION_PROFILE_ICON_MAX) refuse("its icon is too long.");
  const layout = profileLayout(dir);
  const records: SessionProfileItemRecord[] = [];
  for (const [index, entry] of manifest.items.entries()) {
    if (!entry.ok) refuse(`item ${index + 1} does not read (${entry.error.slice(0, 200)}).`);
    records.push(entry.record);
  }
  for (const record of records) {
    const scope = wireScope(record.agents);
    const problem = sessionProfileScopeProblem(record.kind, scope);
    if (scope === null || problem !== null) refuse(`the ${record.kind} "${record.name}" has an invalid agent scope${problem ? `: ${problem}` : "."}`);
    const clash = records.find(
      (other) =>
        other !== record &&
        other.kind === record.kind &&
        record.kind !== "hook" &&
        other.name === record.name &&
        (other.agents === "all" || record.agents === "all" || other.agents.some((agent) => (record.agents as string[]).includes(agent)))
    );
    if (clash) refuse(`two ${record.kind} items are named "${record.name}".`);
    switch (record.kind) {
      case "skill": {
        if (!isValidSkillName(record.name)) refuse(`"${record.name}" is not a valid skill name.`);
        const text = await readText(layout.skillFile(record.id), `skills/${record.id}/${PROFILE_SKILL_FILE}`);
        parseDocument(text, `the skill "${record.name}"`);
        break;
      }
      case "command":
        if (!isValidCommandName(record.name)) refuse(`"${record.name}" is not a valid command name.`);
        parseDocument(await readText(layout.commandFile(record.id), `commands/${record.id}.md`), `the command "${record.name}"`);
        break;
      case "mcp":
        if (!isValidMcpServerName(record.name)) refuse(`"${record.name}" is not a valid MCP server name.`);
        break;
      case "hook": {
        const agent = (scope as string[])[0] as keyof typeof PROFILE_HOOK_EVENTS;
        if (!(PROFILE_HOOK_EVENTS[agent] ?? []).includes(record.hook.event)) refuse(`"${record.hook.event}" is not a hook event of ${agent}.`);
        break;
      }
      case "plugin": {
        const cache = layout.pluginCacheDir(record.id);
        if ((await kindAt(cache)) !== "dir" || (await readdir(cache)).length === 0) refuse(`the plugin "${record.name}" has no files.`);
        break;
      }
    }
  }
  const owned = (kind: SessionProfileItemRecord["kind"], name: string) =>
    records.some((record) => record.kind === kind && (kind === "command" ? `${record.id}.md` === name : record.id === name));
  for (const [folder, kind] of [
    ["skills", "skill"],
    ["commands", "command"],
    ["plugins", "plugin"]
  ] as const) {
    const where = join(dir, folder);
    const found = await kindAt(where);
    if (found === null) continue;
    if (found !== "dir") refuse(`${folder} is not a folder.`);
    for (const name of await readdir(where)) {
      if (!owned(kind, name)) refuse(`${folder}/${name.slice(0, 80)} belongs to no ${kind} of the profile.`);
      const expected = kind === "command" ? "file" : "dir";
      if ((await kindAt(join(where, name))) !== expected) refuse(`${folder}/${name.slice(0, 80)} is not a ${expected === "dir" ? "folder" : "file"}.`);
    }
  }
  if ((await kindAt(join(dir, PROFILE_INSTRUCTIONS_FILE))) !== null) await readText(join(dir, PROFILE_INSTRUCTIONS_FILE), PROFILE_INSTRUCTIONS_FILE);
  return { manifest, redacted };
}

function parseDocument(text: string, shown: string): void {
  try {
    parseMarkdownDocument(text);
  } catch (error) {
    refuse(`${shown} does not parse (${error instanceof Error ? error.message.slice(0, 200) : "unknown"}).`);
  }
}
