import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { isUploadTooLarge, UploadTooLargeError } from "../upload-stream.ts";
import { AgentHostClient, HostUnavailableError } from "./host-client.ts";

// The host client reports every failed request as HOST_UNAVAILABLE. The one
// failure that is the CALLER's rather than the host's — a chat upload's body
// passing the daemon's cap (§6.3) — must still be tellable from a host that is
// gone, so it rides the wrapper as its `cause`, and `isUploadTooLarge` reads it
// there.

test("a body that fails before the host answers rejects as HOST_UNAVAILABLE, carrying the body's own error as its cause", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-host-client-"));
  const socketPath = join(dir, "host.sock");
  // Like the agent host's attachment route, this host answers only once the
  // whole body is in, so the body fails while `open()` still waits for headers.
  const host = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.end("{}"));
  });
  await new Promise<void>((resolve) => host.listen(socketPath, resolve));
  t.after(async () => {
    host.closeAllConnections();
    await new Promise<void>((resolve) => host.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  const client = new AgentHostClient({ socketPath, token: () => "token" });
  const body = new Readable({ read() {} });
  const opened = client.open("POST", "/threads/t1/attachments", { body, timeoutMs: 0 });
  body.push(Buffer.from("the first bytes"));
  const tooLarge = new UploadTooLargeError();
  body.destroy(tooLarge);

  const error = await opened.then(
    () => assert.fail("open() resolved for a body that failed"),
    (rejection: unknown) => rejection
  );
  assert.ok(error instanceof HostUnavailableError, `expected HostUnavailableError, got ${String(error)}`);
  assert.equal(error.code, "HOST_UNAVAILABLE");
  assert.equal(error.cause, tooLarge, "the body's own error, kept whole");
  assert.equal(isUploadTooLarge(error), true);
});

test("isUploadTooLarge reads the cap refusal bare or as a wrapper's cause, and nothing else", () => {
  assert.equal(isUploadTooLarge(new UploadTooLargeError()), true);
  assert.equal(isUploadTooLarge(new HostUnavailableError("wrapped", new UploadTooLargeError())), true);
  assert.equal(isUploadTooLarge(new Error("wrapped", { cause: new UploadTooLargeError() })), true);
  assert.equal(isUploadTooLarge(new HostUnavailableError("agent host request timed out")), false);
  assert.equal(
    isUploadTooLarge(new HostUnavailableError("EIO: i/o error, read", new Error("EIO: i/o error, read"))),
    false
  );
  assert.equal(isUploadTooLarge(new Error("aborted")), false);
  assert.equal(isUploadTooLarge(new UploadTooLargeError().message), false, "its message alone is not the refusal");
  assert.equal(isUploadTooLarge(null), false);
  assert.equal(isUploadTooLarge(undefined), false);
});
