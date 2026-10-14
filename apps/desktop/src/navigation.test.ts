import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiClient } from "../../../packages/ui/src/lib/api-client";
import {
  carriesCredential,
  isAppUrl,
  navigationAction,
  remoteBaseOf,
  visualTarget,
  windowOpenAction
} from "./navigation";

const APP = "file:///opt/Orquester/resources/app/dist/index.html";
/** As the main process records them: one remote at its root, one under a sub-path. */
const remoteBases = new Set(
  ["https://vps.example.com/api/sessions", "https://sub.example.com/orq/health"].map((url) => remoteBaseOf(url)!)
);
const encode = (text: string) => Buffer.from(text, "utf8").toString("base64url");

/** The DevTools frame URL exactly as the shared client builds it, password and all. */
function devtoolsUrl(endpoint: string, password: string): string {
  const client = new ApiClient({ endpoint, password } as never, { kind: "http" } as never);
  return client.buildDevtoolsUrl("browser-1")!;
}

describe("remote bases", () => {
  it("are read off the paths the client appends to its endpoint", () => {
    assert.equal(remoteBaseOf("https://vps.example.com/api/sessions?x=1"), "https://vps.example.com");
    assert.equal(remoteBaseOf("https://sub.example.com/orq/api/fs/download?path=x"), "https://sub.example.com/orq");
    assert.equal(remoteBaseOf("https://sub.example.com/orq/health"), "https://sub.example.com/orq");
    assert.equal(remoteBaseOf("https://sub.example.com/orq/other"), null);
    assert.equal(remoteBaseOf("file:///api/x"), null);
  });
});

describe("navigating the window", () => {
  it("stays on the app's own document, whatever its fragment", () => {
    assert.deepEqual(navigationAction(`${APP}#/project`, { currentUrl: APP, remoteBases }), { kind: "allow" });
    assert.equal(isAppUrl(APP, "file:///etc/passwd"), false);
    assert.equal(isAppUrl("http://127.0.0.1:5174/", "http://127.0.0.1:5174/#x"), true);
  });

  it("downloads a remote's file itself, so the token reaches only that daemon", () => {
    const url = "https://vps.example.com/api/fs/download?path=%2Fp%2Fa.txt&token=secret";
    assert.deepEqual(navigationAction(url, { currentUrl: APP, remoteBases }), { kind: "download", url });
    const underPath = "https://sub.example.com/orq/api/fs/download?path=x&token=secret";
    assert.deepEqual(navigationAction(underPath, { currentUrl: APP, remoteBases }), { kind: "download", url: underPath });
  });

  it("downloads only at a remote's configured base, never another prefix on its origin", () => {
    for (const url of [
      "https://sub.example.com/api/fs/download?path=x&token=secret",
      "https://sub.example.com/other/api/fs/download?path=x&token=secret",
      "https://vps.example.com/x/api/fs/download?path=x&token=secret"
    ]) {
      assert.deepEqual(navigationAction(url, { currentUrl: APP, remoteBases }), { kind: "deny" }, url);
    }
  });

  it("never hands a URL with a credential to the system browser, however nested", () => {
    const devtools = devtoolsUrl("https://vps.example.com", "s3cr3t pass");
    // The password rides inside the `wss=` value, not as a top-level parameter.
    assert.ok(!new URL(devtools).searchParams.has("token"));
    assert.equal(carriesCredential(devtools), true);
    for (const url of [
      devtools,
      devtoolsUrl("https://sub.example.com/orq", "pw"),
      "https://elsewhere.example.com/api/fs/download?path=x&token=secret",
      "https://example.com/?access_token=abc",
      "https://example.com/?next=%2Flogin%3Fpassword%3Dhunter2",
      `https://example.com/?u=${encodeURIComponent(encodeURIComponent("https://x/?token=a"))}`,
      "https://example.com/#token=abc",
      "https://user:pw@example.com/"
    ]) {
      assert.deepEqual(navigationAction(url, { currentUrl: APP, remoteBases }), { kind: "deny" }, url);
      assert.deepEqual(windowOpenAction(url, { remoteBases }), { kind: "deny" }, url);
    }
    assert.equal(carriesCredential("https://example.com/?q=token"), false);
    assert.equal(carriesCredential("https://example.com/search?q=a%20b&next=%2Fdocs%3Fpage%3D2"), false);
    assert.equal(carriesCredential(devtoolsUrl("https://vps.example.com", "")), false, "no password, nothing to keep");
  });

  it("refuses a value nested past the unwrapping bound", () => {
    let value = "https://x/?token=a";
    for (let depth = 0; depth < 8; depth += 1) value = encodeURIComponent(value);
    assert.equal(carriesCredential(`https://example.com/?u=${value}`), true);
  });

  it("sends an ordinary link to the system browser and refuses other schemes", () => {
    assert.deepEqual(navigationAction("https://example.com/docs", { currentUrl: APP, remoteBases }), {
      kind: "external",
      url: "https://example.com/docs"
    });
    assert.deepEqual(windowOpenAction("mailto:a@example.com", { remoteBases }), {
      kind: "external",
      url: "mailto:a@example.com"
    });
    assert.deepEqual(navigationAction("javascript:alert(1)", { currentUrl: APP, remoteBases }), { kind: "deny" });
    assert.deepEqual(navigationAction("data:text/html,<p>x", { currentUrl: APP, remoteBases }), { kind: "deny" });
    assert.deepEqual(windowOpenAction("file:///etc/passwd", { remoteBases }), { kind: "deny" });
  });

  it("a window.open of a remote download is downloaded too", () => {
    const url = "https://vps.example.com/api/fs/download?path=x&token=secret";
    assert.deepEqual(windowOpenAction(url, { remoteBases }), { kind: "download", url });
  });
});

describe("the page scheme", () => {
  const PAGE = "/api/agent-visuals/s1/page?exp=1&sig=x";

  it("names the local daemon's page by path", () => {
    assert.deepEqual(visualTarget(`orq-visual://local${PAGE}`, remoteBases), { kind: "local", path: PAGE });
    assert.equal(visualTarget("orq-visual://local/api/fs/download?path=x", remoteBases), null);
  });

  it("names a remote's page at its base, keeping a daemon's sub-path", () => {
    assert.deepEqual(visualTarget(`orq-visual://remote/${encode("https://vps.example.com")}${PAGE}`, remoteBases), {
      kind: "remote",
      url: `https://vps.example.com${PAGE}`
    });
    assert.deepEqual(visualTarget(`orq-visual://remote/${encode("https://sub.example.com/orq/")}${PAGE}`, remoteBases), {
      kind: "remote",
      url: `https://sub.example.com/orq${PAGE}`
    });
  });

  it("refuses an unknown remote, another prefix on a known origin, a non-page route, or more than a path", () => {
    for (const endpoint of [
      "https://evil.example.com",
      "https://sub.example.com",
      "https://sub.example.com/other",
      "https://vps.example.com/x",
      "https://vps.example.com/?a=1",
      "https://u:p@vps.example.com",
      "file:///etc"
    ]) {
      assert.equal(visualTarget(`orq-visual://remote/${encode(endpoint)}${PAGE}`, remoteBases), null, endpoint);
    }
    assert.equal(visualTarget(`orq-visual://remote/${encode("https://vps.example.com")}/api/fs/download?path=x`, remoteBases), null);
    assert.equal(visualTarget(`https://vps.example.com${PAGE}`, remoteBases), null);
  });
});
