import assert from "node:assert/strict";
import type { LookupAddress } from "node:dns";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { REPO_ICON_MAX_BYTES } from "@orquester/api";
import {
  decodeDataUrl,
  FaviconError,
  fetchFavicon,
  normalizeFaviconDomain,
  rankIconCandidates,
  scanIconLinks,
  type FaviconErrorCode,
  type FetchFaviconOptions
} from "./favicon.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const ICO = new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16, 0, 0]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';

// ---------------------------------------------------------------------------
// normalizeFaviconDomain
// ---------------------------------------------------------------------------

test("normalizeFaviconDomain reduces accepted forms to the hostname", () => {
  const accepted: Array<[string, string]> = [
    ["matssmile.com", "matssmile.com"],
    ["  www.matssmile.com  ", "www.matssmile.com"],
    ["https://matssmile.com/any/path?q=1#x", "matssmile.com"],
    ["http://x.com", "x.com"],
    ["HTTPS://MatsSmile.COM", "matssmile.com"],
    ["matssmile.com.", "matssmile.com"],
    ["bücher.example", "xn--bcher-kva.example"],
    ["sub.domain.co.uk/path", "sub.domain.co.uk"]
  ];
  for (const [input, expected] of accepted) assert.equal(normalizeFaviconDomain(input), expected, input);
});

test("normalizeFaviconDomain refuses everything that is not a public domain", () => {
  const refused = [
    "",
    "   ",
    `${"a".repeat(250)}.com`,
    "127.0.0.1",
    "https://127.0.0.1/",
    "0x7f.1",
    "2130706433",
    "10.0.0.1",
    "[::1]",
    "https://[::1]/",
    "matssmile.com:8080",
    "https://matssmile.com:443/",
    "user@matssmile.com",
    "https://user:pw@matssmile.com/",
    "localhost",
    "app.localhost",
    "printer.local",
    "db.internal",
    "metadata.google.internal",
    "metadata",
    "intranet",
    "ftp://matssmile.com",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "mailto:a@b.com",
    "a..b.com",
    "exa mple.com"
  ];
  for (const input of refused) {
    assert.throws(
      () => normalizeFaviconDomain(input),
      (error) => error instanceof FaviconError && error.code === "FAVICON_BAD_DOMAIN",
      JSON.stringify(input)
    );
  }
});

// ---------------------------------------------------------------------------
// The <link> scan and ranking
// ---------------------------------------------------------------------------

test("scanIconLinks reads icon links tolerantly and resolves them against the page", () => {
  const html = `<!doctype html><html><head>
    <link rel="stylesheet" href="/site.css">
    <LINK REL='shortcut icon' HREF='/favicon-16.png?a=1&amp;b=2' sizes=16x16 type="image/png">
    <link rel=apple-touch-icon href=touch.png sizes="120x120 180x180">
    <link rel="apple-touch-icon-precomposed" href="//cdn.example.net/pre.png">
    <link rel="mask-icon" href="/mask.svg" color="#000">
    <link rel="icon" href="/anim.gif" type="image/gif">
    <link rel="icon" href="/vector.svg">
    <link rel="icon" href="javascript:alert(1)">
    <link rel="icon" href="">
    <link rel="fluid-icon" href="/fluid.png">
    <!-- <link rel="icon" href="/commented.png"> -->
    <script>document.write('<link rel="icon" href="/scripted.png">')</script>
    <link href="/any.png" sizes="any" rel="icon" title="a > b">
  </head><body></body></html>`;
  const links = scanIconLinks(html, "https://www.example.com/blog/post");
  assert.deepEqual(links, [
    { url: "https://www.example.com/favicon-16.png?a=1&b=2", apple: false, size: 16, type: "image/png" },
    { url: "https://www.example.com/blog/touch.png", apple: true, size: 180, type: null },
    { url: "https://cdn.example.net/pre.png", apple: true, size: null, type: null },
    { url: "https://www.example.com/vector.svg", apple: false, size: null, type: null },
    { url: "https://www.example.com/any.png", apple: false, size: Infinity, type: null }
  ]);
});

test("scanIconLinks honours <base href>", () => {
  const links = scanIconLinks('<base href="/static/"><link rel=icon href="i.png">', "https://example.com/a/b");
  assert.equal(links[0].url, "https://example.com/static/i.png");
});

test("scanIconLinks skips <linkfoo>/<basement>, and an unclosed tag ends the scan", () => {
  const page = "https://example.com/";
  assert.deepEqual(
    scanIconLinks('<basement href="/x/"><linkage rel=icon href=/no.png><link rel=icon href=/yes.png>', page).map((l) => l.url),
    ["https://example.com/yes.png"]
  );
  assert.deepEqual(
    scanIconLinks('<link rel=icon href=/a.png><link rel=icon title="x> <link rel=icon href=/b.png>', page).map((l) => l.url),
    ["https://example.com/a.png"],
    "an unclosed quoted value swallows the rest, as in a browser"
  );
  assert.deepEqual(scanIconLinks('<base href="/s/"', page), []);
});

test("scanIconLinks scans a hostile 1 MB page in linear time", () => {
  const page = "https://example.com/";
  const MB = 1024 * 1024;
  // Each of the first three took seconds at 128 KB with the old `<link\b(...)>` / `<base\b(...)>` regexes.
  const pages = [
    "<link".repeat(MB / 5),
    "<base".repeat(MB / 5),
    "<link href='".repeat(Math.floor(MB / 12)),
    "<!--".repeat(MB / 4),
    "<script".repeat(Math.floor(MB / 7)),
    `<script>${"</script ".repeat(Math.floor(MB / 9))}`,
    `<link ${'a="'.repeat(Math.floor(MB / 3))}>`,
    `<link rel=icon href='${"&#x1".repeat(MB / 4)}'>`
  ];
  // A same-size page of ordinary links is the parser's CPU baseline; other
  // workers and scheduler pauses cannot consume this process's CPU budget.
  const ordinary = '<link rel=stylesheet href="/site.css">';
  const baselinePage = ordinary.repeat(Math.ceil(MB / ordinary.length));
  const baselineStarted = process.cpuUsage();
  assert.equal(scanIconLinks(baselinePage, page).length, 0);
  const baseline = process.cpuUsage(baselineStarted);
  for (const html of pages) {
    const started = process.cpuUsage();
    scanIconLinks(html, page);
    const used = process.cpuUsage(started);
    assert.ok(used.user + used.system < 16 * (baseline.user + baseline.system), `${html.slice(0, 16)}... exceeds the same-size parser CPU baseline`);
  }
});

test("rankIconCandidates orders SVG, large sizes, apple, icon, then /favicon.ico, de-duplicated", () => {
  const html = `
    <link rel="icon" href="/small.png" sizes="16x16">
    <link rel="apple-touch-icon" href="/apple-plain.png">
    <link rel="icon" href="/big.png" sizes="96x96">
    <link rel="apple-touch-icon" href="/apple-180.png" sizes="180x180">
    <link rel="icon" href="/logo.svg" type="image/svg+xml">
    <link rel="icon" href="/any.png" sizes="any">
    <link rel="icon" href="/plain.ico">
    <link rel="icon" href="/favicon.ico">
    <link rel="icon" href="/small.png">`;
  const page = "https://example.com/home";
  assert.deepEqual(rankIconCandidates(scanIconLinks(html, page), page), [
    "https://example.com/logo.svg",
    "https://example.com/any.png",
    "https://example.com/apple-180.png",
    "https://example.com/big.png",
    "https://example.com/apple-plain.png",
    "https://example.com/small.png",
    "https://example.com/plain.ico",
    "https://example.com/favicon.ico"
  ]);
  assert.deepEqual(rankIconCandidates([], "https://example.com/x/y"), ["https://example.com/favicon.ico"]);
});

test("data: icon URLs are candidates and decode locally", () => {
  const b64 = Buffer.from(SVG).toString("base64");
  const html = `<link rel="icon" href="/a.png"><link rel="icon" href="data:image/svg+xml;base64,${b64}">`;
  const ranked = rankIconCandidates(scanIconLinks(html, "https://example.com/"), "https://example.com/");
  assert.ok(ranked[0].startsWith("data:image/svg+xml;base64,"), "an SVG data: URL ranks first");
  assert.equal(new TextDecoder().decode(decodeDataUrl(ranked[0])!), SVG);

  const percent = `data:image/svg+xml,${encodeURIComponent(SVG)}`;
  assert.equal(new TextDecoder().decode(decodeDataUrl(percent)!), SVG);
  assert.deepEqual(decodeDataUrl(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`), PNG);
  assert.equal(decodeDataUrl("data:text/html;base64,PGh0bWw+"), null, "not an image type");
  assert.equal(decodeDataUrl("data:image/png;base64,!!!"), null, "not base64");
  const huge = Buffer.alloc(REPO_ICON_MAX_BYTES + 10).toString("base64");
  assert.equal(decodeDataUrl(`data:image/png;base64,${huge}`), null, "over the icon cap");
});

// ---------------------------------------------------------------------------
// End to end against a local server
// ---------------------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let port = 0;
let sites: Record<string, Record<string, Handler>> = {};
let requests: string[] = [];
let lookups: string[] = [];
let dns: Record<string, LookupAddress[]> = {};

before(async () => {
  server = createServer((req, res) => {
    res.on("error", () => undefined);
    const host = (req.headers.host ?? "").toLowerCase();
    const path = req.url ?? "/";
    requests.push(`${host}${path}`);
    const handler = sites[host]?.[path];
    if (handler) handler(req, res);
    else res.writeHead(404, { "content-type": "text/plain" }).end("nope");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  sites = {};
  requests = [];
  lookups = [];
  dns = {};
});

const options = (extra: FetchFaviconOptions = {}): FetchFaviconOptions => ({
  unsafeTestServer: { port },
  lookup: async (hostname) => {
    lookups.push(hostname);
    const answer = dns[hostname] ?? [{ address: "93.184.216.34", family: 4 }];
    if (answer.length === 0) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return answer;
  },
  ...extra
});

const html = (body: string): Handler => (_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(body);
const bytes = (data: Uint8Array | string, type = "application/octet-stream"): Handler => (_req, res) =>
  res.writeHead(200, { "content-type": type }).end(data);
const redirect = (location: string, status = 302): Handler => (_req, res) => res.writeHead(status, { location }).end();

async function rejectsWith(promise: Promise<unknown>, code: FaviconErrorCode, message?: RegExp) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof FaviconError, String(error));
    assert.equal(error.code, code, error.message);
    if (message) assert.match(error.message, message);
    return true;
  });
}

test("fetchFavicon picks the best icon and reports its sniffed type", async () => {
  sites["site.test"] = {
    "/": html(`<head>
      <link rel="icon" href="/fav-16.png" sizes="16x16">
      <link rel="apple-touch-icon" href="/touch.png" sizes="180x180">
      <link rel="icon" type="image/svg+xml" href="/logo.svg">
    </head>`),
    // Declared as PNG; the sniff decides.
    "/logo.svg": bytes(SVG, "image/png"),
    "/touch.png": bytes(PNG, "image/png")
  };
  const icon = await fetchFavicon("https://site.test/some/page", options());
  assert.equal(icon.domain, "site.test");
  assert.equal(icon.contentType, "image/svg+xml");
  assert.equal(new TextDecoder().decode(icon.bytes), SVG);
  assert.deepEqual(requests, ["site.test/", "site.test/logo.svg"]);
});

test("fetchFavicon falls back to /favicon.ico", async () => {
  sites["site.test"] = { "/": html("<html><head><title>no icons</title></head></html>"), "/favicon.ico": bytes(ICO) };
  const icon = await fetchFavicon("site.test", options());
  assert.equal(icon.contentType, "image/x-icon");
  assert.deepEqual(requests, ["site.test/", "site.test/favicon.ico"]);
});

test("fetchFavicon uses a data: icon without fetching it", async () => {
  sites["site.test"] = { "/": html(`<link rel="icon" href="data:image/png;base64,${Buffer.from(PNG).toString("base64")}">`) };
  const icon = await fetchFavicon("site.test", options());
  assert.equal(icon.contentType, "image/png");
  assert.deepEqual(icon.bytes, PNG);
  assert.deepEqual(requests, ["site.test/"]);
});

test("fetchFavicon still tries /favicon.ico when the homepage answers non-2xx", async () => {
  sites["site.test"] = { "/": (_req, res) => res.writeHead(403).end("<html>blocked bot</html>"), "/favicon.ico": bytes(ICO) };
  assert.equal((await fetchFavicon("site.test", options())).contentType, "image/x-icon");

  sites["site.test"] = { "/": (_req, res) => res.writeHead(503).end("secret body") };
  await assert.rejects(fetchFavicon("site.test", options()), (error: FaviconError) => {
    assert.equal(error.code, "FAVICON_UNREACHABLE");
    assert.equal(error.message, "Couldn't reach site.test: it answered HTTP 503.");
    return true;
  });
});

test("fetchFavicon follows a redirect to another host, re-guarding it", async () => {
  sites["site.test"] = { "/": redirect("http://www.other.test/landing", 301) };
  sites["www.other.test"] = { "/landing": html('<link rel="icon" href="img/icon.png">'), "/img/icon.png": bytes(PNG) };
  const icon = await fetchFavicon("site.test", options());
  assert.equal(icon.domain, "site.test");
  assert.equal(icon.contentType, "image/png");
  assert.deepEqual(requests, ["site.test/", "www.other.test/landing", "www.other.test/img/icon.png"]);
  assert.deepEqual(lookups, ["site.test", "www.other.test", "www.other.test"], "every hop and fetch resolves once");
});

test("fetchFavicon refuses a redirect to a private or local address", async () => {
  sites["site.test"] = { "/": redirect("http://internal.test/") };
  dns["internal.test"] = [{ address: "10.0.0.7", family: 4 }];
  await rejectsWith(fetchFavicon("site.test", options()), "FAVICON_BLOCKED", /^site\.test points to a private or local address\.$/);
  assert.deepEqual(requests, ["site.test/"], "the private host is never contacted");

  for (const location of ["http://127.0.0.1/", "http://[::ffff:7f00:1]/", "http://localhost/", "http://metadata.google.internal/"]) {
    sites["site.test"] = { "/": redirect(location) };
    await rejectsWith(fetchFavicon("site.test", options()), "FAVICON_BLOCKED");
  }
});

test("fetchFavicon refuses a host when any DNS answer is private", async () => {
  dns["site.test"] = [
    { address: "93.184.216.34", family: 4 },
    { address: "::ffff:192.168.1.10", family: 6 }
  ];
  sites["site.test"] = { "/": html("<p>hi</p>"), "/favicon.ico": bytes(ICO) };
  await rejectsWith(fetchFavicon("site.test", options()), "FAVICON_BLOCKED");
  assert.deepEqual(requests, []);
});

test("fetchFavicon skips icon candidates on blocked hosts and says so when nothing else works", async () => {
  dns["evil.test"] = [{ address: "169.254.169.254", family: 4 }];
  sites["site.test"] = { "/": html('<link rel="icon" href="http://evil.test/i.png"><link rel="icon" href="http://10.0.0.1/i.png">') };
  await rejectsWith(fetchFavicon("site.test", options()), "FAVICON_BLOCKED");
  assert.deepEqual(requests, ["site.test/", "site.test/favicon.ico"]);

  sites["site.test"]["/favicon.ico"] = bytes(ICO);
  assert.equal((await fetchFavicon("site.test", options())).contentType, "image/x-icon");
});

test("fetchFavicon skips an oversized icon for the next candidate", async () => {
  const huge = new Uint8Array(REPO_ICON_MAX_BYTES + 1);
  huge.set(PNG);
  sites["site.test"] = {
    "/": html('<link rel="icon" href="/huge.svg"><link rel="apple-touch-icon" href="/declared.png"><link rel="icon" href="/ok.png">'),
    // Streamed without a content-length: the cap cuts it off mid-body.
    "/huge.svg": (_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.write(huge.subarray(0, REPO_ICON_MAX_BYTES / 2));
      res.end(huge.subarray(REPO_ICON_MAX_BYTES / 2));
    },
    // Declares its size: refused before reading.
    "/declared.png": (_req, res) => res.writeHead(200, { "content-length": String(huge.length) }).end(huge),
    "/ok.png": bytes(PNG)
  };
  const icon = await fetchFavicon("site.test", options());
  assert.equal(icon.bytes.length, PNG.length, "the accepted icon stays within the expected byte length");
  assert.deepEqual(icon.bytes, PNG);
  assert.deepEqual(requests, ["site.test/", "site.test/huge.svg", "site.test/declared.png", "site.test/ok.png"]);
});

test("fetchFavicon reads at most 1 MB of HTML", async () => {
  sites["site.test"] = {
    "/": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.write('<head><link rel="icon" href="/early.png">');
      res.write(`<!-- ${"x".repeat(1024 * 1024)} -->`);
      res.end('<link rel="icon" type="image/svg+xml" href="/late.svg"></head>');
    },
    "/early.png": bytes(PNG),
    "/late.svg": bytes(SVG)
  };
  const icon = await fetchFavicon("site.test", options());
  assert.equal(icon.contentType, "image/png");
  assert.ok(!requests.includes("site.test/late.svg"), "a link past the cap is never seen");
});

test("fetchFavicon rejects bytes that are not an image", async () => {
  sites["site.test"] = {
    "/": html('<link rel="icon" href="/fake.png" type="image/png">'),
    "/fake.png": bytes("<html>not an image</html>", "image/png")
  };
  await rejectsWith(fetchFavicon("site.test", options()), "FAVICON_NOT_FOUND", /^No icon found on site\.test\.$/);
  assert.deepEqual(requests, ["site.test/", "site.test/fake.png", "site.test/favicon.ico"]);
});

test("fetchFavicon makes at most 4 candidate fetches", async () => {
  const links = [1, 2, 3, 4, 5].map((n) => `<link rel="icon" href="/i${n}.png">`).join("");
  sites["site.test"] = { "/": html(links), "/favicon.ico": bytes(ICO) };
  await rejectsWith(fetchFavicon("site.test", options()), "FAVICON_NOT_FOUND");
  assert.deepEqual(requests, ["site.test/", "site.test/i1.png", "site.test/i2.png", "site.test/i3.png", "site.test/i4.png"]);
});

test("fetchFavicon follows at most 3 redirects", async () => {
  sites["site.test"] = {
    "/": redirect("/1"),
    "/1": redirect("/2"),
    "/2": redirect("/3"),
    "/3": html('<link rel="icon" href="/i.png">'),
    "/i.png": bytes(PNG)
  };
  assert.equal((await fetchFavicon("site.test", options())).contentType, "image/png");

  sites["site.test"]["/3"] = redirect("/4");
  sites["site.test"]["/4"] = html("<p>too far</p>");
  await rejectsWith(fetchFavicon("site.test", options()), "FAVICON_UNREACHABLE", /too many redirects/);
  assert.ok(!requests.includes("site.test/4"));
});

test("fetchFavicon reports an unresolvable host as unreachable", async () => {
  dns["gone.test"] = [];
  await rejectsWith(fetchFavicon("gone.test", options()), "FAVICON_UNREACHABLE", /^Couldn't reach gone\.test\.$/);
});

test("fetchFavicon's deadline spans the whole operation", async () => {
  const deadline = new AbortController();
  sites["site.test"] = {
    "/": html('<link rel="icon" href="/slow.png">'),
    // The deadline passes while the icon is still being served.
    "/slow.png": (_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.write(PNG, () => deadline.abort());
    },
    "/favicon.ico": bytes(ICO)
  };
  await rejectsWith(fetchFavicon("site.test", options({ deadline: deadline.signal })), "FAVICON_UNREACHABLE", /took too long/);
  assert.ok(!requests.includes("site.test/favicon.ico"), "nothing more is tried after the deadline");

  const caller = new AbortController();
  sites["site.test"] = { "/": () => caller.abort() };
  await rejectsWith(fetchFavicon("site.test", options({ signal: caller.signal })), "FAVICON_UNREACHABLE");
});
