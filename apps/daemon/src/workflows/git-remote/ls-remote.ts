// `git ls-remote --symref` output, parsed (spec §6.2: branches and tags are polled with
// ls-remote — any provider, no REST quota).

/** A remote's branches and tags as `git ls-remote` reports them. */
export interface LsRemoteResult {
  /** Branch name (without `refs/heads/`) → the commit it points at. */
  heads: Record<string, string>;
  /**
   * Tag name (without `refs/tags/`) → `sha` (the tag's own object: for an annotated tag the tag
   * object, else the commit) and `commit` (the commit it resolves to: the peeled `^{}` sha for an
   * annotated tag, else `sha`).
   */
  tags: Record<string, { sha: string; commit: string }>;
  /** The branch the remote's HEAD names (`ref: refs/heads/<b>\tHEAD`), when it was asked for. */
  defaultBranch?: string;
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * Parse `git ls-remote [--symref]` stdout. Lines are `<sha>\t<ref>` plus, with `--symref`,
 * `ref: <target>\t<name>`. Only `HEAD`, `refs/heads/*` and `refs/tags/*` are read (a GitHub
 * remote also advertises `refs/pull/*`); a malformed line is skipped, never an error. An
 * annotated tag's `^{}` line may come before or after its own line.
 */
export function parseLsRemote(stdout: string): LsRemoteResult {
  // Maps, then `Object.fromEntries`: a branch named `__proto__` must stay an own property.
  const heads = new Map<string, string>();
  const tagObjects = new Map<string, string>();
  const peeled = new Map<string, string>();
  let defaultBranch: string | undefined;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line) {
      continue;
    }
    const tab = line.indexOf("\t");
    if (tab < 0) {
      continue;
    }
    const left = line.slice(0, tab).trim();
    const ref = line.slice(tab + 1).trim();
    if (left.startsWith("ref: ")) {
      const target = left.slice("ref: ".length).trim();
      if (ref === "HEAD" && target.startsWith("refs/heads/") && target.length > "refs/heads/".length) {
        defaultBranch = target.slice("refs/heads/".length);
      }
      continue;
    }
    if (!SHA.test(left)) {
      continue;
    }
    const sha = left.toLowerCase();
    if (ref.startsWith("refs/heads/")) {
      const name = ref.slice("refs/heads/".length);
      if (name) heads.set(name, sha);
    } else if (ref.startsWith("refs/tags/")) {
      const rest = ref.slice("refs/tags/".length);
      if (rest.endsWith("^{}")) {
        const name = rest.slice(0, -3);
        if (name) peeled.set(name, sha);
      } else if (rest) {
        tagObjects.set(rest, sha);
      }
    }
  }

  const tags: Array<[string, { sha: string; commit: string }]> = [];
  for (const [name, sha] of tagObjects) {
    tags.push([name, { sha, commit: peeled.get(name) ?? sha }]);
  }
  return {
    heads: Object.fromEntries(heads),
    tags: Object.fromEntries(tags),
    ...(defaultBranch !== undefined ? { defaultBranch } : {})
  };
}
