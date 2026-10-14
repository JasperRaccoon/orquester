import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  carriesCredential,
  isAppUrl,
  navigationAction,
  visualTarget,
  windowOpenAction
} from "./navigation";

const APP = "file:///opt/Orquester/resources/app/dist/index.html";
const remoteOrigins = new Set(["https://vps.example.com", "https://sub.example.com"]);
const encode = (text: string) => Buffer.from(text, "utf8").toString("base64url");

describe("navigating the window", () => {
  it("stays on the app's own document, whatever its fragment", () => {
    assert.deepEqual(navigationAction(`${APP}#/project`, { currentUrl: APP, remoteOrigins }), { kind: "allow" });
    assert.equal(isAppUrl(APP, "file:///etc/passwd"), false);
    assert.equal(isAppUrl("http://127.0.0.1:5174/", "http://127.0.0.1:5174/#x"), true);
  });

  it("downloads a remote's file itself, so the token reaches only that daemon", () => {
    const url = "https://vps.example.com/api/fs/download?path=%2Fp%2Fa.txt&token=secret";
    assert.deepEqual(navigationAction(url, { currentUrl: APP, remoteOrigins }), { kind: "download", url });
    const underPath = "https://sub.example.com/orq/api/fs/download?path=x&token=secret";
    assert.deepEqual(navigationAction(underPath, { currentUrl: APP, remoteOrigins }), { kind: "download", url: underPath });
  });

  it("never hands a URL with a credential to the system browser", () => {
    for (const url of [
      "https://elsewhere.example.com/api/fs/download?path=x&token=secret",
      "https://vps.example.com/api/browser/devtools?ws=x&token=secret",
      "https://example.com/?access_token=abc"
    ]) {
      assert.deepEqual(navigationAction(url, { currentUrl: APP, remoteOrigins }), { kind: "deny" }, url);
      assert.deepEqual(windowOpenAction(url, { remoteOrigins }), { kind: "deny" }, url);
    }
    assert.equal(carriesCredential("https://example.com/?q=token"), false);
  });

  it("sends an ordinary link to the system browser and refuses other schemes", () => {
    assert.deepEqual(navigationAction("https://example.com/docs", { currentUrl: APP, remoteOrigins }), {
      kind: "external",
      url: "https://example.com/docs"
    });
    assert.deepEqual(windowOpenAction("mailto:a@example.com", { remoteOrigins }), {
      kind: "external",
      url: "mailto:a@example.com"
    });
    assert.deepEqual(navigationAction("javascript:alert(1)", { currentUrl: APP, remoteOrigins }), { kind: "deny" });
    assert.deepEqual(navigationAction("data:text/html,<p>x", { currentUrl: APP, remoteOrigins }), { kind: "deny" });
    assert.deepEqual(windowOpenAction("file:///etc/passwd", { remoteOrigins }), { kind: "deny" });
  });

  it("a window.open of a remote download is downloaded too", () => {
    const url = "https://vps.example.com/api/fs/download?path=x&token=secret";
    assert.deepEqual(windowOpenAction(url, { remoteOrigins }), { kind: "download", url });
  });
});

describe("the page scheme", () => {
  const PAGE = "/api/agent-visuals/s1/page?exp=1&sig=x";

  it("names the local daemon's page by path", () => {
    assert.deepEqual(visualTarget(`orq-visual://local${PAGE}`, remoteOrigins), { kind: "local", path: PAGE });
    assert.equal(visualTarget("orq-visual://local/api/fs/download?path=x", remoteOrigins), null);
  });

  it("names a remote's page by origin, keeping a daemon's sub-path", () => {
    assert.deepEqual(visualTarget(`orq-visual://remote/${encode("https://vps.example.com")}${PAGE}`, remoteOrigins), {
      kind: "remote",
      url: `https://vps.example.com${PAGE}`
    });
    assert.deepEqual(visualTarget(`orq-visual://remote/${encode("https://sub.example.com/orq/")}${PAGE}`, remoteOrigins), {
      kind: "remote",
      url: `https://sub.example.com/orq${PAGE}`
    });
  });

  it("refuses a remote this process never reached, a non-page route, or an endpoint with more than a path", () => {
    assert.equal(visualTarget(`orq-visual://remote/${encode("https://evil.example.com")}${PAGE}`, remoteOrigins), null);
    assert.equal(visualTarget(`orq-visual://remote/${encode("https://vps.example.com")}/api/fs/download?path=x`, remoteOrigins), null);
    assert.equal(visualTarget(`orq-visual://remote/${encode("https://vps.example.com/?a=1")}${PAGE}`, remoteOrigins), null);
    assert.equal(visualTarget(`orq-visual://remote/${encode("https://u:p@vps.example.com")}${PAGE}`, remoteOrigins), null);
    assert.equal(visualTarget(`orq-visual://remote/${encode("file:///etc")}${PAGE}`, remoteOrigins), null);
    assert.equal(visualTarget(`https://vps.example.com${PAGE}`, remoteOrigins), null);
  });
});
