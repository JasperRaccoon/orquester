import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import Fastify, { type InjectOptions, type LightMyRequestResponse } from "fastify";
import { REPO_ICON_MAX_BYTES, type RepoIdentity, repoIdentityRoutes } from "@orquester/api";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";
import { createServer } from "../index.ts";
import { FaviconError, type FetchedFavicon } from "./favicon.ts";
import { registerRepoIdentityRoutes, type RepoIdentityRoutesDeps } from "./routes.ts";
import { RepoIdentitiesService } from "./service.ts";
import { testAuthSessions } from "../auth/testing.ts";

// Route-level coverage for /api/repo-identities: statuses, the `{ code, message }` envelope, the
// icon headers, the raw upload's caps. Inject only — nothing listens, nothing hits the network.

const quiet = { warn: () => {}, error: () => {} };
const KEY = "github.com/acme/site";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7]);
const ICO = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 9, 9]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

async function harness(t: TestContext, fetchFavicon?: RepoIdentityRoutesDeps["fetchFavicon"]) {
  const root = await mkdtemp(join(tmpdir(), "orquester-repo-identity-routes-"));
  const iconsDir = join(root, "repo-icons");
  const service = new RepoIdentitiesService({ file: join(root, "repo-identities.json"), iconsDir, logger: quiet });
  await service.load();
  const app = Fastify();
  registerRepoIdentityRoutes(app, { service, ...(fetchFavicon ? { fetchFavicon } : {}) });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const inject = (options: InjectOptions) => app.inject(options);
  return {
    service,
    inject,
    icons: async () => (await readdir(iconsDir).catch(() => [] as string[])).sort(),
    upload: (body: Buffer | Readable, contentType: string, repoKey = KEY) =>
      inject({
        method: "POST",
        url: `${repoIdentityRoutes.icon}?repoKey=${encodeURIComponent(repoKey)}&contentType=${encodeURIComponent(contentType)}`,
        headers: { "content-type": "application/octet-stream" },
        payload: body
      })
  };
}

function refused(response: LightMyRequestResponse, status: number, code: string): void {
  assert.equal(response.statusCode, status, response.body);
  const body = response.json() as { code: string; message: string };
  assert.equal(body.code, code);
  assert.equal(typeof body.message, "string");
  assert.ok(body.message.length > 0);
}

const identityOf = (response: LightMyRequestResponse): RepoIdentity | null => (response.json() as { identity: RepoIdentity | null }).identity;

test("label: set, list, invalid, and a null or blank label clears the record", async (t) => {
  const h = await harness(t);
  assert.deepEqual((await h.inject({ method: "GET", url: repoIdentityRoutes.list })).json(), { identities: [] });

  const set = await h.inject({ method: "PUT", url: repoIdentityRoutes.label, payload: { repoKey: KEY, label: " Acme " } });
  assert.equal(set.statusCode, 200);
  const identity = identityOf(set);
  assert.equal(identity?.label, "Acme");
  assert.deepEqual((await h.inject({ method: "GET", url: repoIdentityRoutes.list })).json(), { identities: [identity] });

  refused(await h.inject({ method: "PUT", url: repoIdentityRoutes.label, payload: { repoKey: KEY, label: "x".repeat(81) } }), 400, "INVALID_LABEL");
  refused(await h.inject({ method: "PUT", url: repoIdentityRoutes.label, payload: { repoKey: KEY, label: 3 } }), 400, "INVALID_LABEL");

  for (const label of [null, "  "]) {
    await h.inject({ method: "PUT", url: repoIdentityRoutes.label, payload: { repoKey: KEY, label: "Acme" } });
    const cleared = await h.inject({ method: "PUT", url: repoIdentityRoutes.label, payload: { repoKey: KEY, label } });
    assert.equal(cleared.statusCode, 200);
    assert.deepEqual(cleared.json(), { identity: null });
    assert.deepEqual((await h.inject({ method: "GET", url: repoIdentityRoutes.list })).json(), { identities: [] });
  }
});

test("emoji: one trimmed emoji is stored; anything else is INVALID_EMOJI", async (t) => {
  const h = await harness(t);
  const ok = await h.inject({ method: "PUT", url: repoIdentityRoutes.emoji, payload: { repoKey: KEY, emoji: " 🦷 " } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(identityOf(ok)?.icon, { kind: "emoji", value: "🦷" });
  for (const emoji of ["", "a", "🦷🦷", "🦷 x", 5, undefined]) {
    refused(await h.inject({ method: "PUT", url: repoIdentityRoutes.emoji, payload: { repoKey: KEY, emoji } }), 400, "INVALID_EMOJI");
  }
});

test("every route validates the repo key", async (t) => {
  let fetched = 0;
  const h = await harness(t, async () => {
    fetched += 1;
    throw new Error("unreachable");
  });
  for (const repoKey of ["", "/etc/passwd", "github.com/../keys", "GitHub.com/a/b", "a/b", "github.com/a b/c"]) {
    const q = `?repoKey=${encodeURIComponent(repoKey)}`;
    refused(await h.inject({ method: "PUT", url: repoIdentityRoutes.label, payload: { repoKey, label: "x" } }), 400, "INVALID_REPO_KEY");
    refused(await h.inject({ method: "PUT", url: repoIdentityRoutes.emoji, payload: { repoKey, emoji: "🦷" } }), 400, "INVALID_REPO_KEY");
    refused(await h.upload(PNG, "image/png", repoKey), 400, "INVALID_REPO_KEY");
    refused(await h.inject({ method: "GET", url: `${repoIdentityRoutes.icon}${q}` }), 400, "INVALID_REPO_KEY");
    refused(await h.inject({ method: "DELETE", url: `${repoIdentityRoutes.icon}${q}` }), 400, "INVALID_REPO_KEY");
    refused(await h.inject({ method: "POST", url: repoIdentityRoutes.favicon, payload: { repoKey, domain: "acme.com" } }), 400, "INVALID_REPO_KEY");
  }
  // Missing entirely, and repeated (an array, not a key).
  refused(await h.inject({ method: "PUT", url: repoIdentityRoutes.label, payload: { label: "x" } }), 400, "INVALID_REPO_KEY");
  refused(await h.inject({ method: "GET", url: repoIdentityRoutes.icon }), 400, "INVALID_REPO_KEY");
  refused(await h.inject({ method: "GET", url: `${repoIdentityRoutes.icon}?repoKey=${KEY}&repoKey=${KEY}` }), 400, "INVALID_REPO_KEY");
  assert.equal(fetched, 0);
  assert.deepEqual(h.service.list(), []);
});

test("upload, GET with the security headers, replace removes the old file, DELETE clears it", async (t) => {
  const h = await harness(t);
  refused(await h.inject({ method: "GET", url: `${repoIdentityRoutes.icon}?repoKey=${KEY}` }), 404, "ICON_NOT_FOUND");

  const uploaded = await h.upload(SVG, "image/svg+xml");
  assert.equal(uploaded.statusCode, 200, uploaded.body);
  const identity = identityOf(uploaded);
  assert.equal(identity?.icon?.kind, "image");
  assert.equal(uploaded.body.includes(".svg"), false, "the stored file name never leaves the daemon");
  const [first] = await h.icons();

  const version = identity?.icon?.kind === "image" ? identity.icon.version : "";
  assert.ok(version);
  const icon = await h.inject({ method: "GET", url: `${repoIdentityRoutes.icon}?repoKey=${KEY}&v=${version}` });
  assert.equal(icon.statusCode, 200);
  assert.deepEqual(icon.rawPayload, SVG);
  assert.equal(icon.headers["content-type"], "image/svg+xml");
  assert.equal(icon.headers["x-content-type-options"], "nosniff");
  assert.equal(icon.headers["content-security-policy"], "sandbox; default-src 'none'; style-src 'unsafe-inline'");
  assert.equal(icon.headers["cache-control"], "private, max-age=31536000, immutable", "the current version is immutable");

  // Any other `?v=` (a stale one, or none) still gets the current bytes, but nothing may keep them.
  for (const query of ["&v=stale0000000000", "&v=", ""]) {
    const other = await h.inject({ method: "GET", url: `${repoIdentityRoutes.icon}?repoKey=${KEY}${query}` });
    assert.equal(other.statusCode, 200);
    assert.deepEqual(other.rawPayload, SVG);
    assert.equal(other.headers["cache-control"], "no-store", `v from "${query}"`);
    assert.equal(other.headers["x-content-type-options"], "nosniff");
    assert.equal(other.headers["content-security-policy"], "sandbox; default-src 'none'; style-src 'unsafe-inline'");
  }

  const replaced = await h.upload(PNG, "image/png");
  assert.equal(replaced.statusCode, 200);
  const files = await h.icons();
  assert.equal(files.length, 1);
  assert.notEqual(files[0], first);
  const png = await h.inject({ method: "GET", url: `${repoIdentityRoutes.icon}?repoKey=${KEY}` });
  assert.equal(png.headers["content-type"], "image/png");
  assert.deepEqual(png.rawPayload, PNG);
  // The old version's URL now answers the new bytes: never cacheable under that URL.
  const stale = await h.inject({ method: "GET", url: `${repoIdentityRoutes.icon}?repoKey=${KEY}&v=${version}` });
  assert.deepEqual(stale.rawPayload, PNG);
  assert.equal(stale.headers["cache-control"], "no-store");

  // An emoji replaces the image and its file.
  await h.inject({ method: "PUT", url: repoIdentityRoutes.emoji, payload: { repoKey: KEY, emoji: "🚀" } });
  assert.deepEqual(await h.icons(), []);
  refused(await h.inject({ method: "GET", url: `${repoIdentityRoutes.icon}?repoKey=${KEY}` }), 404, "ICON_NOT_FOUND");

  await h.upload(PNG, "image/png");
  await h.inject({ method: "PUT", url: repoIdentityRoutes.label, payload: { repoKey: KEY, label: "Site" } });
  const cleared = await h.inject({ method: "DELETE", url: `${repoIdentityRoutes.icon}?repoKey=${KEY}` });
  assert.equal(cleared.statusCode, 200);
  assert.equal(identityOf(cleared)?.icon, undefined);
  assert.equal(identityOf(cleared)?.label, "Site");
  assert.deepEqual(await h.icons(), []);
  // The label went too: the record is removed.
  await h.inject({ method: "PUT", url: repoIdentityRoutes.label, payload: { repoKey: KEY, label: null } });
  assert.deepEqual((await h.inject({ method: "DELETE", url: `${repoIdentityRoutes.icon}?repoKey=${KEY}` })).json(), { identity: null });
});

test("upload refusals: content type, magic bytes, declared ≠ sniffed, ICO, broken SVG, empty", async (t) => {
  const h = await harness(t);
  refused(await h.upload(PNG, "image/gif"), 400, "INVALID_ICON");
  refused(await h.upload(PNG, ""), 400, "INVALID_ICON");
  refused(await h.upload(ICO, "image/x-icon"), 400, "INVALID_ICON");
  refused(await h.upload(ICO, "image/png"), 400, "INVALID_ICON");
  refused(await h.upload(Buffer.from("not an image"), "image/png"), 400, "INVALID_ICON");
  refused(await h.upload(PNG, "image/jpeg"), 400, "INVALID_ICON");
  refused(await h.upload(JPEG, "image/webp"), 400, "INVALID_ICON");
  refused(await h.upload(Buffer.from("<svg><g>"), "image/svg+xml"), 400, "INVALID_ICON");
  refused(await h.upload(Buffer.from("<html><svg></svg></html>"), "image/svg+xml"), 400, "INVALID_ICON");
  refused(await h.upload(Buffer.alloc(0), "image/png"), 400, "INVALID_ICON");
  assert.deepEqual(h.service.list(), []);
  assert.deepEqual(await h.icons(), []);
});

test("over the cap: a declared length and a streamed body are both 413, and nothing is stored", async (t) => {
  const h = await harness(t);
  const big = Buffer.concat([PNG, Buffer.alloc(REPO_ICON_MAX_BYTES)]);
  const declared = await h.upload(big, "image/png");
  refused(declared, 413, "ICON_TOO_LARGE");
  assert.equal(declared.headers.connection, "close");

  // A stream carries no Content-Length: the cap is found while reading.
  const chunk = Buffer.alloc(64 * 1024);
  const chunks = [PNG, ...Array.from({ length: Math.ceil(REPO_ICON_MAX_BYTES / chunk.length) + 1 }, () => chunk)];
  const streamed = await h.upload(Readable.from(chunks), "image/png");
  refused(streamed, 413, "ICON_TOO_LARGE");
  assert.equal(streamed.headers.connection, "close");

  // Exactly at the cap is fine.
  const atCap = await h.upload(Buffer.concat([PNG, Buffer.alloc(REPO_ICON_MAX_BYTES - PNG.length)]), "image/png");
  assert.equal(atCap.statusCode, 200);
  assert.equal((await h.icons()).length, 1);
});

test("favicon: a fetched icon is stored with its source; refusals map to their statuses", async (t) => {
  const calls: string[] = [];
  let next: () => Promise<FetchedFavicon> = async () => ({ domain: "acme.com", contentType: "image/x-icon", bytes: ICO });
  const h = await harness(t, async (domain, options) => {
    calls.push(domain);
    assert.ok(options.signal instanceof AbortSignal);
    return next();
  });
  await h.inject({ method: "PUT", url: repoIdentityRoutes.emoji, payload: { repoKey: KEY, emoji: "🦷" } });

  const ok = await h.inject({ method: "POST", url: repoIdentityRoutes.favicon, payload: { repoKey: KEY, domain: " https://www.acme.com/x " } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(calls, ["https://www.acme.com/x"]);
  const icon = identityOf(ok)?.icon;
  assert.equal(icon?.kind, "image");
  assert.deepEqual(icon?.kind === "image" ? [icon.contentType, icon.source] : null, ["image/x-icon", { kind: "favicon", domain: "acme.com" }]);
  const served = await h.inject({ method: "GET", url: `${repoIdentityRoutes.icon}?repoKey=${KEY}` });
  assert.equal(served.headers["content-type"], "image/x-icon");
  assert.deepEqual(served.rawPayload, ICO);

  const cases = [
    ["FAVICON_BAD_DOMAIN", 400],
    ["FAVICON_BLOCKED", 400],
    ["FAVICON_UNREACHABLE", 502],
    ["FAVICON_NOT_FOUND", 404]
  ] as const;
  for (const [code, status] of cases) {
    next = async () => {
      throw new FaviconError(code, `acme.com: ${code}`);
    };
    const response = await h.inject({ method: "POST", url: repoIdentityRoutes.favicon, payload: { repoKey: KEY, domain: "acme.com" } });
    refused(response, status, code);
    assert.equal(response.json().message, `acme.com: ${code}`);
  }
  // A fetched image the store refuses is no usable icon; anything unexpected is unreachable.
  next = async () => ({ domain: "acme.com", contentType: "image/png", bytes: Buffer.from("html") });
  refused(await h.inject({ method: "POST", url: repoIdentityRoutes.favicon, payload: { repoKey: KEY, domain: "acme.com" } }), 404, "FAVICON_NOT_FOUND");
  next = async () => {
    throw new Error("socket hang up <body>secret</body>");
  };
  const unexpected = await h.inject({ method: "POST", url: repoIdentityRoutes.favicon, payload: { repoKey: KEY, domain: "acme.com" } });
  refused(unexpected, 502, "FAVICON_UNREACHABLE");
  assert.equal(unexpected.body.includes("secret"), false);
  // Every failure kept the stored icon.
  assert.deepEqual(h.service.list()[0]?.icon, icon);

  // A domain that is not even a string, or too long, never reaches the fetcher.
  const before = calls.length;
  for (const domain of [undefined, 5, "", "  ", "a".repeat(254)]) {
    refused(await h.inject({ method: "POST", url: repoIdentityRoutes.favicon, payload: { repoKey: KEY, domain } }), 400, "FAVICON_BAD_DOMAIN");
  }
  assert.equal(calls.length, before);
});

test("favicon: one fetch per repo at a time — a second is 409 FAVICON_BUSY", async (t) => {
  let release: (value: FetchedFavicon) => void = () => {};
  let started: () => void = () => {};
  /** Resolves when the fetcher is next called for acme.com. */
  const nextFetch = () => new Promise<void>((resolve) => (started = resolve));
  const h = await harness(t, (domain) => {
    if (domain === "other.com") return Promise.resolve({ domain, contentType: "image/png", bytes: PNG });
    started();
    return new Promise<FetchedFavicon>((resolve) => (release = resolve));
  });
  let running = nextFetch();
  const first = h.inject({ method: "POST", url: repoIdentityRoutes.favicon, payload: { repoKey: KEY, domain: "acme.com" } });
  await running;
  refused(await h.inject({ method: "POST", url: repoIdentityRoutes.favicon, payload: { repoKey: KEY, domain: "acme.com" } }), 409, "FAVICON_BUSY");
  // Another repo is not held up.
  const other = await h.inject({ method: "POST", url: repoIdentityRoutes.favicon, payload: { repoKey: "github.com/acme/other", domain: "other.com" } });
  assert.equal(other.statusCode, 200);

  release({ domain: "acme.com", contentType: "image/png", bytes: PNG });
  assert.equal((await first).statusCode, 200);
  // Done: the next fetch for the repo runs.
  running = nextFetch();
  const again = h.inject({ method: "POST", url: repoIdentityRoutes.favicon, payload: { repoKey: KEY, domain: "acme.com" } });
  await running;
  release({ domain: "acme.com", contentType: "image/png", bytes: PNG });
  assert.equal((await again).statusCode, 200);
});

test("favicon: the one-fetch lock holds across every server the routes are registered on", async (t) => {
  let release: (value: FetchedFavicon) => void = () => {};
  let started: () => void = () => {};
  const running = new Promise<void>((resolve) => (started = resolve));
  const fetchFavicon: RepoIdentityRoutesDeps["fetchFavicon"] = () => {
    started();
    return new Promise<FetchedFavicon>((resolve) => (release = resolve));
  };
  // The daemon registers the routes twice over one service: the unix socket and HTTP.
  const h = await harness(t, fetchFavicon);
  const second = Fastify();
  registerRepoIdentityRoutes(second, { service: h.service, fetchFavicon });
  t.after(() => second.close());

  const first = h.inject({ method: "POST", url: repoIdentityRoutes.favicon, payload: { repoKey: KEY, domain: "acme.com" } });
  await running;
  const busy = await second.inject({ method: "POST", url: repoIdentityRoutes.favicon, payload: { repoKey: KEY, domain: "acme.com" } });
  refused(busy, 409, "FAVICON_BUSY");

  release({ domain: "acme.com", contentType: "image/png", bytes: PNG });
  assert.equal((await first).statusCode, 200);
  assert.equal(h.service.faviconFetches.size, 0, "the lock is released once the fetch is done");
});

test("the daemon serves the routes on both transports; the remote one requires the bearer, ?token= included", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orquester-repo-identity-server-"));
  const service = new RepoIdentitiesService({ file: join(root, "repo-identities.json"), iconsDir: join(root, "icons"), logger: quiet });
  await service.load();
  await service.setEmoji(KEY, "🦷");
  type Args = Parameters<typeof createServer>;
  const passwordHash = "$2a$12$0123456789012345678901uFAKEfakeFAKEfakeFAKEfa";
  const { authSessions, bearer } = await testAuthSessions();
  const config = createDefaultDaemonConfig({ env: {} });
  config.transports.http.username = "admin";
  config.transports.http.passwordHash = passwordHash;
  const build = (options: Args[5]) =>
    createServer(
      config,
      { daemonDir: root, workspacesDir: root, fsRoot: root } as unknown as Args[1],
      createDefaultClientConfig(join(root, "daemon.sock")),
      createWriteStream("/dev/null"),
      { repoIdentities: service, authSessions } as unknown as Args[4],
      options
    );
  const local = build({ authRequired: false, mode: "local" });
  const remote = build({ authRequired: true, mode: "remote" });
  t.after(async () => {
    await local.close();
    await remote.close();
    await rm(root, { recursive: true, force: true });
  });
  const listed = await local.inject({ method: "GET", url: repoIdentityRoutes.list });
  assert.equal(listed.statusCode, 200);
  assert.equal((listed.json() as { identities: RepoIdentity[] }).identities[0]?.repoKey, KEY);
  for (const url of [repoIdentityRoutes.list, `${repoIdentityRoutes.icon}?repoKey=${KEY}&token=${encodeURIComponent(bearer.slice(7))}`]) {
    assert.equal((await remote.inject({ method: "GET", url })).statusCode, 401, url);
  }
  const authed = await remote.inject({ method: "GET", url: repoIdentityRoutes.list, headers: { authorization: bearer } });
  assert.equal(authed.statusCode, 200);
  refused(await remote.inject({ method: "GET", url: `${repoIdentityRoutes.icon}?repoKey=${KEY}`, headers: { authorization: bearer } }), 404, "ICON_NOT_FOUND");
});
