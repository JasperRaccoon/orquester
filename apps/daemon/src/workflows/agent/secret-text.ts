// Automated workflows — keeping secret values out of the agent block's persisted state (spec §5.7,
// §5.8).
//
// An agent block's prompt may carry `{{ secrets.X }}`, and the block persists what it is about to
// send (its template, its prompt, the pending input, the command body) in its `WaitingOn` BEFORE the
// POST, so a restart re-sends the same text — and `WaitingOn` lands in `run.json` unredacted. So the
// block never keeps a secret's value in that state: every occurrence of a secret value (the engine
// redactor's own matching — ≥ 4 characters, longest value first, one pass) is replaced by a marker
// naming the secret, `<NAME>` (Unicode private-use code points, which no prompt, git
// status or `{variable}` produces), and the value is put back only in the body actually POSTed.
// A resumed `creating` / `sending` therefore re-sends the real values, read from the run's secrets
// at that moment. A marker naming a secret that no longer exists is sent as nothing.
//
// Unlike `«secret:NAME»`, the marker is reversible without ambiguity: a prompt can quote the
// redactor's placeholder text, but not a private-use pair.

import { createRedactor } from "../sandbox/redact.ts";

const OPEN = "";
const CLOSE = "";
const MARKER = /([^]+)/g;

function secretMarker(name: string): string {
  return `${OPEN}${name}${CLOSE}`;
}

/** Every secret value in `text` replaced by its marker (safe to persist). */
export function protectSecrets(text: string, secrets: Readonly<Record<string, string>>): string {
  if (!text) return text;
  const matches = createRedactor(secrets).matches(text);
  if (matches.length === 0) return text;
  let out = "";
  let at = 0;
  for (const match of matches) {
    out += text.slice(at, match.start) + secretMarker(match.name);
    at = match.end;
  }
  return out + text.slice(at);
}

/** Every marker replaced by its secret's value (only for what is sent, never for what is kept). */
export function revealSecrets(text: string, secrets: Readonly<Record<string, string>>): string {
  if (!text || !text.includes(OPEN)) return text;
  return text.replace(MARKER, (_whole, name: string) => (Object.prototype.hasOwnProperty.call(secrets, name) ? secrets[name]! : ""));
}

/** Does `text` still hold a secret's value (a value the markers would hide)? */
export function holdsSecret(text: string, secrets: Readonly<Record<string, string>>): boolean {
  return createRedactor(secrets).matches(text).length > 0;
}
