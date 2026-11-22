/**
 * Agent SSH Phase 1 (spec 2026-11-22 §4.3): the lines Orquester adds to a box work user's
 * `~/.ssh/authorized_keys`, found again by their tag comment (`agentSshKeyComment`). Pure text
 * functions: every line that is not ours, comments and blank lines included, is kept byte for byte.
 */

import { parseAgentSshKeyComment, type AgentSshKeyTag } from "@orquester/api";

/** Key types an `authorized_keys` line may start with (OpenSSH `sshkey.c`), options absent. */
const KEY_TYPE = /^(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp(?:256|384|521)|sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com|(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp(?:256|384|521))-cert-v01@openssh\.com)$/;

/**
 * Hours added to the deadline in `expiry-time`: sshd before 9.x reads its timespec in the box's
 * local time zone (a trailing `Z` it does not know makes the whole line invalid), and no zone is
 * more than 14 hours ahead of UTC, so the key never lapses before its deadline wherever the box is.
 * Revocation removes the line at the deadline itself; this is only the backstop.
 */
export const EXPIRY_ZONE_MARGIN_HOURS = 14;

/** One `authorized_keys` line split up; null for blank lines, comments and lines it cannot read. */
export interface AuthorizedKeyLine {
  options: string | null;
  keyType: string;
  key: string;
  comment: string;
}

/** Skip one options field (`a,b="x y",c`) honouring double quotes; the index after it, or -1. */
function endOfOptions(line: string): number {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\" && quoted) {
      index += 1;
      continue;
    }
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === " " || char === "\t")) return index;
  }
  return -1;
}

export function parseAuthorizedKeyLine(line: string): AuthorizedKeyLine | null {
  const text = line.replace(/\r$/, "").trim();
  if (text === "" || text.startsWith("#")) return null;
  let options: string | null = null;
  let rest = text;
  const first = text.split(/[ \t]+/, 1)[0]!;
  if (!KEY_TYPE.test(first)) {
    const end = endOfOptions(text);
    if (end < 0) return null;
    options = text.slice(0, end);
    rest = text.slice(end).trimStart();
  }
  const match = /^(\S+)[ \t]+(\S+)(?:[ \t]+(.*))?$/.exec(rest);
  if (!match || !KEY_TYPE.test(match[1]!)) return null;
  return { options, keyType: match[1]!, key: match[2]!, comment: (match[3] ?? "").trim() };
}

/** The tag of a line Orquester added; null for every other line. */
export function agentKeyTagOfLine(line: string): AgentSshKeyTag | null {
  const parsed = parseAuthorizedKeyLine(line);
  return parsed ? parseAgentSshKeyComment(parsed.comment) : null;
}

/** `expiry-time`'s timespec for a deadline (epoch ms): `YYYYMMDDHHMM` in UTC, {@link EXPIRY_ZONE_MARGIN_HOURS} after it. */
export function authorizedKeyExpiry(deadlineMs: number): string {
  const at = new Date(deadlineMs + EXPIRY_ZONE_MARGIN_HOURS * 3_600_000);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${at.getUTCFullYear()}${two(at.getUTCMonth() + 1)}${two(at.getUTCDate())}${two(at.getUTCHours())}${two(at.getUTCMinutes())}`;
}

/** The line for one key: `[expiry-time="…" ]<type> <base64> <tag comment>`. `publicKey` is `<type> <base64>`. */
export function authorizedKeyLine(publicKey: string, comment: string, deadlineMs: number | null): string {
  const [type, key] = publicKey.trim().split(/\s+/);
  if (!type || !key || !KEY_TYPE.test(type)) throw new Error("Not an OpenSSH public key.");
  return `${deadlineMs === null ? "" : `expiry-time="${authorizedKeyExpiry(deadlineMs)}" `}${type} ${key} ${comment}`;
}

/**
 * `content` with every Orquester line for which `drop(tag)` holds removed, and `add` appended
 * (lines whose tag equals an added line's are removed first, so a key is never there twice). Lines
 * that are not ours stay as they are; the file keeps a final newline when it has any line.
 */
export function rewriteAuthorizedKeys(content: string, drop: (tag: AgentSshKeyTag) => boolean, add: readonly string[] = []): string {
  const addedTags = add.map((line) => agentKeyTagOfLine(line)).filter((tag): tag is AgentSshKeyTag => tag !== null);
  const sameTag = (a: AgentSshKeyTag, b: AgentSshKeyTag) => a.boxId === b.boxId && a.threadId === b.threadId;
  const lines = content === "" ? [] : content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const kept = lines.filter((line) => {
    const tag = agentKeyTagOfLine(line);
    return tag === null || (!drop(tag) && !addedTags.some((added) => sameTag(added, tag)));
  });
  if (kept.length === lines.length && add.length === 0) return content;
  const out = [...kept, ...add];
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}
