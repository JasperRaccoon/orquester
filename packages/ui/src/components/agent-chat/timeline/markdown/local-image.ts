/**
 * Where a markdown image's `src` points.
 *
 * Agents write screenshots to disk and embed them as `![shot](build/shot.png)`
 * or `![shot](/abs/path/shot.png)`. Handed to `<img>` as is, those resolve
 * against the app's own origin and load nothing; they are files on the
 * daemon's host, read through the file API like any other preview.
 *
 *  - `remote`: a URL the browser loads itself (`https:`, protocol-relative).
 *  - `local`: an absolute host path, relative ones joined onto the project.
 *  - `unresolved`: a local path with no project to anchor it, or a `~` path.
 */
export type MarkdownImageSource =
  | { kind: "remote"; src: string }
  | { kind: "local"; path: string }
  | { kind: "unresolved"; src: string };

function normalizeAbsolute(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return `/${out.join("/")}`;
}

function decodePath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

export function resolveMarkdownImageSource(src: string, root: string | undefined): MarkdownImageSource {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) return { kind: "remote", src };
  // A query or fragment means nothing to a file on disk.
  const path = decodePath(src.replace(/[?#].*$/, ""));
  if (path.length === 0 || path.startsWith("~")) return { kind: "unresolved", src };
  if (path.startsWith("/")) return { kind: "local", path: normalizeAbsolute(path) };
  if (!root) return { kind: "unresolved", src };
  return { kind: "local", path: normalizeAbsolute(`${root}/${path}`) };
}
