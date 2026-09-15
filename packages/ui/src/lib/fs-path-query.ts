/**
 * The `/api/fs/*` GET routes address their target as `?p=<base64url(path)>`
 * rather than `?path=<path>`. Browser ad blockers (uBlock, ABP, Brave
 * Shields…) filter on the raw request URL, query included: a file under a
 * `banners/` directory or named `*_300x250.jpg` matches EasyList's generic
 * rules and the fetch dies in the browser with ERR_BLOCKED_BY_CLIENT — the
 * preview just says "failed to load". base64url hides the file name from
 * those filters. It is not a security measure: the daemon decodes it and runs
 * the same sandbox check it runs on the plain form, which it still accepts.
 *
 * Mirror of `apps/daemon/src/fs-path-query.ts` (the decoder).
 */

/** Query parameter name carrying the base64url-encoded path. */
export const FS_PATH_PARAM = "p";

/** base64url (RFC 4648 §5, unpadded) of the path's UTF-8 bytes. */
export function encodeFsPathParam(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The query object every fs GET call spreads: `{ p: <encoded path> }`. */
export function fsPathQuery(path: string): { [FS_PATH_PARAM]: string } {
  return { [FS_PATH_PARAM]: encodeFsPathParam(path) };
}
