import assert from "node:assert/strict";
import test from "node:test";

import { pickCloneUrl } from "./accounts";

const urls = { ssh: "ssh://git@bb.corp.com:7999/PRJ/repo.git", https: "https://bb.corp.com/scm/PRJ/repo.git" };

test("prefers SSH when the account's key is installed on the provider", () => {
  assert.equal(pickCloneUrl({}, urls), urls.ssh);
});

test("falls back to HTTPS while a DC key upload is still pending", () => {
  assert.equal(pickCloneUrl({ keyUploadPending: true }, urls), urls.https);
});

test("uses whichever transport exists when only one is offered", () => {
  assert.equal(pickCloneUrl({}, { https: urls.https }), urls.https);
  assert.equal(pickCloneUrl({ keyUploadPending: true }, { ssh: urls.ssh }), urls.ssh);
  assert.equal(pickCloneUrl({}, {}), undefined);
});
