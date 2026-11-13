import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiClient, ApiError, WorkflowApiError } from "./api-client.ts";
import type { TransportRequest } from "./transporter.ts";

test("WorkflowApiError reads an INVALID_INPUT refusal's input errors, entry by entry", () => {
  const body = {
    error: {
      code: "INVALID_INPUT",
      message: "The input does not fit",
      inputErrors: [{ input: "env", message: "input `env` is required" }, { message: "whole input" }, { input: 3, message: "kept without input" }, { input: "x" }, "junk", null]
    }
  };
  const error = new WorkflowApiError(400, "POST", "/api/workflows/w/run", {}, body);
  assert.equal(error.code, "INVALID_INPUT");
  assert.deepEqual(error.inputErrors, [{ input: "env", message: "input `env` is required" }, { message: "whole input" }, { message: "kept without input" }]);
  assert.deepEqual(new WorkflowApiError(400, "POST", "/x", {}, { error: { code: "INVALID_WORKFLOW", message: "x" } }).inputErrors, []);
});

test("storage downloads hide the path from URL filters and keep the daemon's refusal", async () => {
  const path = "/srv/ads/banner_300x250.jpg";
  const sent: TransportRequest[] = [];
  const refusal = { code: "STORAGE_FORBIDDEN", message: "It is a secret." };
  const transporter = (kind: string) => ({
    kind,
    request: async () => {
      throw new Error("not under test");
    },
    requestBytes: async (req: TransportRequest) => {
      sent.push(req);
      return { status: 403, ok: false, data: new TextEncoder().encode(JSON.stringify(refusal)).buffer as ArrayBuffer };
    },
    openStream: () => ({ close() {} })
  });

  const web = new ApiClient({ id: "c", endpoint: "http://daemon", password: "" } as never, transporter("http") as never);
  const url = web.buildStorageDownloadUrl(path)!;
  assert.ok(!decodeURIComponent(url).includes("banner"), url);

  const desktop = new ApiClient({ id: "c", endpoint: "", password: "" } as never, transporter("unix") as never);
  await assert.rejects(desktop.downloadStorageBytes(path), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.deepEqual(error.body, refusal);
    return true;
  });
  assert.ok(!JSON.stringify(sent[0]!.query).includes("banner"));
});
