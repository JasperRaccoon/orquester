import assert from "node:assert/strict";
import test from "node:test";
import { buildCredentialFileLine } from "./types";

test("encodes reserved characters in username and token", () => {
  assert.equal(
    buildCredentialFileLine({ host: "bitbucket.org", username: "x-bitbucket-api-token-auth" }, "AT+A/T=T"),
    "https://x-bitbucket-api-token-auth:AT%2BA%2FT%3DT@bitbucket.org\n"
  );
});

test("keeps a DC port in the host", () => {
  assert.equal(
    buildCredentialFileLine({ host: "bb.corp.com:8443", username: "jdoe" }, "tok"),
    "https://jdoe:tok@bb.corp.com:8443\n"
  );
});
