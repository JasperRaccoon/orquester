import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { HttpTransporter } from "./http-transporter.ts";
import { UnexpectedResponseError } from "../connection/failure.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("HttpTransporter.openStream", () => {
  it("a non-2xx answer is one error and one end — its JSON body is never stream data", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: "RUN_NOT_FOUND" } }), { status: 404 })) as typeof fetch;
    const transporter = new HttpTransporter({ baseUrl: "http://daemon.test", httpClient: {} as never });
    const data: string[] = [];
    let errors = 0;
    let ends = 0;
    await new Promise<void>((resolve) => {
      transporter.openStream("/x", {
        onData: (chunk) => data.push(chunk),
        onEnd: () => { ends += 1; resolve(); },
        onError: () => { errors += 1; }
      });
    });
    assert.deepEqual(data, []);
    assert.equal(errors, 1);
    assert.equal(ends, 1);
  });

  it("a 2xx body streams, then ends once", async () => {
    globalThis.fetch = (async () => new Response("hello", { status: 200 })) as typeof fetch;
    const transporter = new HttpTransporter({ baseUrl: "http://daemon.test", httpClient: {} as never });
    const data: string[] = [];
    let ends = 0;
    await new Promise<void>((resolve, reject) => {
      transporter.openStream("/x", {
        onData: (chunk) => data.push(chunk),
        onEnd: () => { ends += 1; resolve(); },
        onError: reject
      });
    });
    assert.equal(data.join(""), "hello");
    assert.equal(ends, 1);
  });
});

describe("HttpTransporter.request", () => {
  const answering = (status: number, body: string, headers: Record<string, string> = {}) =>
    new HttpTransporter({
      baseUrl: "http://daemon.test",
      httpClient: {
        send: async () => ({ status, ok: status < 400, headers, text: async () => body })
      }
    });

  it("an answer that is not JSON is an UnexpectedResponseError carrying the status", async () => {
    await assert.rejects(answering(200, "<html>portal</html>", { "Content-Type": "text/html" }).request({ method: "GET", path: "/health" }), (error: unknown) => {
      assert.ok(error instanceof UnexpectedResponseError);
      assert.equal(error.status, 200);
      assert.equal(error.contentType, "text/html");
      return true;
    });
    await assert.rejects(answering(502, "Bad Gateway").request({ method: "GET", path: "/health" }), (error: unknown) =>
      error instanceof UnexpectedResponseError && error.status === 502 && error.contentType === null
    );
  });

  it("JSON and empty bodies still parse", async () => {
    assert.deepEqual((await answering(200, '{"ok":true}').request({ method: "GET", path: "/health" })).data, { ok: true });
    assert.equal((await answering(204, "").request({ method: "GET", path: "/x" })).data, undefined);
  });
});
