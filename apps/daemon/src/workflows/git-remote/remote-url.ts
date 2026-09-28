// Pure helpers over git remote URLs: the repo key one git-trigger poller is shared under, the
// display name a trigger card shows, and the shape check every URL passes before it reaches
// `git ls-remote` / `git clone` (spec 2026-09-28-automated-workflows-design.md §6.2, §5.10).

/** A remote URL split into its host (lowercased, no port, no userinfo) and its path segments. */
export interface ParsedRemote {
  host: string;
  /** Path segments with `.git` and any browse suffix removed, original case. */
  segments: string[];
}

/** Hosts that are aliases of one forge's canonical host. */
const HOST_ALIASES: Record<string, string> = {
  "ssh.github.com": "github.com",
  "www.github.com": "github.com",
  "ssh.bitbucket.org": "bitbucket.org",
  "www.bitbucket.org": "bitbucket.org",
  "altssh.bitbucket.org": "bitbucket.org"
};

/** Forges whose repo path is always exactly `owner/repo` (anything after is a browse suffix). */
const TWO_SEGMENT_HOSTS = new Set(["github.com", "bitbucket.org"]);

/** Any whitespace or control character — never legitimate in a remote URL. */
const UNSAFE_CHARS = /[\s\u0000-\u001f\u007f]/;

/**
 * Why `url` may not be handed to git, or null when it may. Accepted: `https://`, `http://`,
 * `ssh://`, `git://` and the scp-like `[user@]host:path`. Refused: anything starting with `-`
 * (an option to git), whitespace/control characters, `file://`, local paths and `ext::`-style
 * transports (`ext::` runs a command).
 */
export function remoteUrlProblem(url: string): string | null {
  if (url.length === 0) {
    return "The repository URL is empty.";
  }
  if (url.length > 2048) {
    return "The repository URL is too long.";
  }
  if (url.startsWith("-")) {
    return "The repository URL may not start with '-'.";
  }
  if (UNSAFE_CHARS.test(url)) {
    return "The repository URL may not contain whitespace or control characters.";
  }
  if (/^(https?|ssh|git):\/\/[^/]/i.test(url)) {
    return null;
  }
  // scp-like `[user@]host:path` — the host has no slash, the path does not start with `/`
  // followed by another `/` (that would be `scheme://`), and `::` is a remote-helper transport.
  if (/^([^@/:]+@)?[A-Za-z0-9][A-Za-z0-9.-]*:(?!:)(?!\/\/)[^\s]+$/.test(url)) {
    return null;
  }
  return "Only https://, ssh://, git:// and git@host:owner/repo URLs are supported.";
}

/** Split a remote URL (any supported form) into host + path segments; null when unparseable. */
export function parseRemoteUrl(input: string): ParsedRemote | null {
  const url = input.trim();
  if (remoteUrlProblem(url) !== null) {
    return null;
  }
  let host: string;
  let path: string;
  const scheme = /^([a-z]+):\/\/([^/?#]+)([^?#]*)/i.exec(url);
  if (scheme) {
    // Drop userinfo (`user[:pass]@`) and any port; hosts are case-insensitive.
    const authority = scheme[2].replace(/^.*@/, "");
    host = authority.replace(/:\d*$/, "").replace(/^\[|\]$/g, "");
    path = scheme[3];
  } else {
    const scp = /^(?:[^@/:]+@)?([^:/]+):(.*)$/.exec(url);
    if (!scp) {
      return null;
    }
    host = scp[1];
    path = scp[2];
  }
  host = host.toLowerCase();
  host = HOST_ALIASES[host] ?? host;
  let segments = path
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length > 0) {
    segments[segments.length - 1] = segments[segments.length - 1].replace(/\.git$/i, "");
  }
  segments = dcSegments(segments) ?? segments;
  if (TWO_SEGMENT_HOSTS.has(host)) {
    segments = segments.slice(0, 2).map((segment) => segment.replace(/\.git$/i, ""));
  }
  segments = segments.filter((segment) => segment.length > 0);
  if (!host || segments.length < 2) {
    return null;
  }
  return { host, segments };
}

/**
 * Bitbucket Server/DC paths carry a context path and a transport marker before the repo:
 * `…/scm/KEY/slug`, `…/projects/KEY/repos/slug[/browse…]` and `…/users/name/repos/slug` (the
 * personal project `~name`). Reduce each to `[KEY, slug]`; null when the path is none of them.
 */
function dcSegments(segments: string[]): string[] | null {
  const scm = segments.lastIndexOf("scm");
  if (scm >= 0 && segments.length === scm + 3) {
    return [segments[scm + 1], segments[scm + 2]];
  }
  for (let i = 0; i + 3 < segments.length; i += 1) {
    const kind = segments[i];
    if ((kind === "projects" || kind === "users") && segments[i + 2] === "repos") {
      const owner = kind === "users" ? `~${segments[i + 1]}` : segments[i + 1];
      return [owner, segments[i + 3].replace(/\.git$/i, "")];
    }
  }
  return null;
}

/**
 * The key one repository is known by, whatever URL form names it: `host/owner/repo` (DC:
 * `host/PROJECT/repo`), lowercased — the forges treat both host and path case-insensitively,
 * and `ssh.bitbucket.org`/`bitbucket.org` are one host. Ports, userinfo, `.git`, a trailing
 * slash and browse suffixes never change it. Null for a URL git would not be handed.
 */
export function repoKeyOf(url: string): string | null {
  const parsed = parseRemoteUrl(url);
  return parsed ? `${parsed.host}/${parsed.segments.join("/")}`.toLowerCase() : null;
}

/**
 * "owner/repo" as the trigger card shows it (original case; DC `PROJECT/repo`, a GitLab
 * subgroup `group/sub/repo`). Falls back to the trimmed input when it cannot be parsed.
 */
export function repoDisplayName(url: string): string {
  const parsed = parseRemoteUrl(url);
  return parsed ? parsed.segments.join("/") : url.trim();
}

/**
 * The URL with its credentials removed, so a remote read off a checkout (or typed into a trigger)
 * never carries a token into a persisted payload, a broadcast or a prompt. For `http(s)://` and
 * `git://` the WHOLE userinfo goes (`https://ghp_xxx@github.com/…` → `https://github.com/…`):
 * GitHub accepts a token as the username alone, so keeping "the user" can keep the secret, and the
 * account's own transport authenticates reads of the URL. For `ssh://` the user is the login
 * (`git`) and stays; only a password goes. Non-URL (scp-like) forms are returned unchanged.
 */
export function stripUrlCredentials(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^@/?#]*)@/i, (_match, scheme: string, userinfo: string) => {
    if (!/^ssh(\+git)?:\/\/$|^git\+ssh:\/\/$/i.test(scheme)) return scheme;
    const user = userinfo.split(":")[0];
    return user ? `${scheme}${user}@` : scheme;
  });
}

/**
 * Redacts URL userinfo inside free text (git's stderr, an error message): any `//user:secret@`,
 * and for `http(s)://` / `git://` any `//anything@` (a bare token as the user) → `//***@`.
 */
export function redactUrlUserinfo(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:)?\/\/([^/@\s]*)@/gi, (match, scheme: string | undefined, info: string) => {
    const tokenScheme = scheme !== undefined && /^(https?|git):$/i.test(scheme);
    return info.includes(":") || tokenScheme ? `${scheme ?? ""}//***@` : match;
  });
}
