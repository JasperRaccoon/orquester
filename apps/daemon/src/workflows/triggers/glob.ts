// Automated workflows — branch/tag name globs for the git triggers (spec §6.2).
//
// `@orquester/config`'s glob is a PATH matcher (an unanchored term is `**/term`, a metachar-free
// term also matches everything beneath it), which is wrong for a ref name: `feature/*` must not
// match `x/feature/y`, and `main` must not match `main/old`. This one is anchored at both ends:
//
//   `*`   any run of characters except `/`
//   `**`  any run of characters, `/` included
//   `?`   one character except `/`
//
// No character classes, no braces, no escapes. Matching is a bounded dynamic programme over the
// pattern's tokens (O(pattern × name), both capped) — never a RegExp built from user text, so a
// hostile pattern cannot cost more than the caps allow.

const MAX_PATTERN_CHARS = 256;
const MAX_NAME_CHARS = 1024;

type Token = { kind: "star" } | { kind: "dstar" } | { kind: "any" } | { kind: "char"; ch: string };

function tokenize(pattern: string): Token[] {
  const chars = [...pattern];
  const tokens: Token[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    if (ch === "*") {
      if (chars[i + 1] === "*") {
        while (chars[i + 1] === "*") i += 1;
        if (tokens[tokens.length - 1]?.kind !== "dstar") tokens.push({ kind: "dstar" });
      } else if (tokens[tokens.length - 1]?.kind !== "star" && tokens[tokens.length - 1]?.kind !== "dstar") {
        tokens.push({ kind: "star" });
      }
    } else if (ch === "?") {
      tokens.push({ kind: "any" });
    } else {
      tokens.push({ kind: "char", ch });
    }
  }
  return tokens;
}

/** True when `name` matches the anchored glob `pattern` (a blank pattern matches nothing). */
export function matchesGlob(pattern: string, name: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PATTERN_CHARS || name.length > MAX_NAME_CHARS) return false;
  if (!trimmed.includes("*") && !trimmed.includes("?")) return trimmed === name;
  const tokens = tokenize(trimmed);
  const str = [...name];
  // prev[j]: tokens[0..i) match str[0..j).
  let prev = new Array<boolean>(str.length + 1).fill(false);
  prev[0] = true;
  for (const token of tokens) {
    const next = new Array<boolean>(str.length + 1).fill(false);
    switch (token.kind) {
      case "dstar":
        for (let j = 0; j <= str.length; j += 1) next[j] = prev[j]! || (j > 0 && next[j - 1]!);
        break;
      case "star":
        for (let j = 0; j <= str.length; j += 1) next[j] = prev[j]! || (j > 0 && str[j - 1] !== "/" && next[j - 1]!);
        break;
      case "any":
        for (let j = 1; j <= str.length; j += 1) next[j] = prev[j - 1]! && str[j - 1] !== "/";
        break;
      case "char":
        for (let j = 1; j <= str.length; j += 1) next[j] = prev[j - 1]! && str[j - 1] === token.ch;
        break;
    }
    prev = next;
  }
  return prev[str.length]!;
}

/** True when any of `patterns` matches `name`. */
export function matchesAnyGlob(patterns: readonly string[], name: string): boolean {
  return patterns.some((pattern) => matchesGlob(pattern, name));
}
