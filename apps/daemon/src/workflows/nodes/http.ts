// Automated workflows — the HTTP block (spec §4, §5.9). Global `fetch`; method, URL, query, headers
// and body are templates (secrets allowed). The response body is read as a stream and refused past
// `maxHttpBodyBytes`; JSON responses are parsed. A status outside `successStatuses` fails the block
// with `http_status` and the response still attached (the failure edge can read it). After a
// restart a GET/HEAD is re-issued; any other method fails `interrupted` (retryable by policy).

import { singleExpression, WORKFLOW_LIMITS } from "@orquester/api";

import type { NodeExecutionContext, NodeExecutor, NodeResult } from "../contracts.ts";
import { createRedactor } from "../sandbox/redact.ts";
import { describeDuration } from "./process.ts";

export interface HttpExecutorOptions {
  fetch?: typeof fetch;
  maxHttpBodyBytes?: number;
}

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  const type = value.split(";")[0]!.trim().toLowerCase();
  return type === "application/json" || type.endsWith("+json");
}

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function statusAccepted(status: number, accepted: "2xx" | number[]): boolean {
  if (accepted === "2xx") return status >= 200 && status < 300;
  return accepted.includes(status);
}

class BodyTooLargeError extends Error {}

async function readBody(response: Response, maxBytes: number, abort: () => void): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    abort();
    throw new BodyTooLargeError();
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      abort();
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks);
}

type BuiltRequest =
  | { ok: true; url: string; init: RequestInit & { headers: Headers } }
  | { ok: false; result: NodeResult };

function buildRequest(ctx: NodeExecutionContext<"http">): BuiltRequest {
  const config = ctx.node.config;
  const fail = (kind: "validation" | "expression", message: string): BuiltRequest => ({ ok: false, result: { status: "failed", error: { kind, message } } });
  const rawUrl = ctx.render(config.url).text.trim();
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // Redacted BEFORE the cut: a cut secret no longer matches the engine's whole-value redactor.
    return fail("validation", `"${createRedactor(ctx.secrets).text(rawUrl).slice(0, 200)}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return fail("validation", "Only http:// and https:// URLs are supported.");
  for (const entry of config.query) {
    if (entry.name.length === 0) continue;
    url.searchParams.append(entry.name, ctx.render(entry.value).text);
  }
  const headers = new Headers();
  for (const entry of config.headers) {
    if (entry.name.length === 0) continue;
    if (!HEADER_NAME.test(entry.name)) return fail("validation", `"${entry.name}" is not a valid header name.`);
    const value = ctx.render(entry.value).text;
    if (/[\r\n\0]/.test(value)) return fail("expression", `The value of the ${entry.name} header contains a line break.`);
    headers.append(entry.name, value);
  }
  const init: RequestInit & { headers: Headers } = {
    method: config.method,
    headers,
    redirect: config.followRedirects ? "follow" : "manual"
  };
  const body = config.body;
  if (body && config.method !== "GET" && config.method !== "HEAD") {
    if (body.kind === "json") {
      const rendered = ctx.renderValue(body.value);
      let text: string | undefined;
      if (singleExpression(body.value) !== null) {
        // One `{{ … }}`: its value is the body — a JSON text as is, anything else encoded.
        const value = rendered.value;
        if (typeof value === "string" && parsesAsJson(value)) text = value;
        else text = JSON.stringify(value ?? null);
      } else {
        text = typeof rendered.value === "string" ? rendered.value : JSON.stringify(rendered.value);
        if (text === undefined || !parsesAsJson(text)) return fail("expression", "The JSON body is not valid JSON once rendered.");
      }
      if (text === undefined) return fail("expression", "The JSON body cannot be written as JSON.");
      init.body = text;
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    } else if (body.kind === "text") {
      init.body = ctx.render(body.value).text;
      if (!headers.has("content-type")) headers.set("content-type", body.contentType ?? "text/plain; charset=utf-8");
    } else {
      const form = new URLSearchParams();
      for (const field of body.fields) if (field.name.length > 0) form.append(field.name, ctx.render(field.value).text);
      init.body = form.toString();
      if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded");
    }
  }
  return { ok: true, url: url.toString(), init };
}

export function createHttpExecutor(options: HttpExecutorOptions = {}): NodeExecutor<"http"> {
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const maxBody = options.maxHttpBodyBytes ?? WORKFLOW_LIMITS.maxHttpBodyBytes;

  return {
    type: "http",
    async execute(ctx): Promise<NodeResult> {
      const method = ctx.node.config.method;
      if (ctx.resumeFrom?.kind === "http" && method !== "GET" && method !== "HEAD") {
        await ctx.setWaitingOn(undefined);
        return {
          status: "failed",
          error: { kind: "interrupted", message: `The daemon restarted during the ${method} request; it was not sent again.` }
        };
      }
      const built = buildRequest(ctx);
      if (!built.ok) return built.result;

      const controller = new AbortController();
      let timedOut = false;
      const onAbort = (): void => controller.abort();
      if (ctx.signal.aborted) controller.abort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
      const timer = Number.isFinite(ctx.timeoutMs)
        ? ctx.services.clock.setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, ctx.timeoutMs)
        : null;
      try {
        await ctx.setWaitingOn({ kind: "http", method, startedAt: ctx.services.clock.now().toISOString() });
        const response = await doFetch(built.url, { ...built.init, signal: controller.signal });
        const headers: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          headers[name] = value;
        });
        let body: unknown = "";
        const warnings: string[] = [];
        if (method !== "HEAD") {
          const bytes = await readBody(response, maxBody, () => controller.abort());
          const text = bytes.toString("utf8");
          body = text;
          if (isJsonContentType(response.headers.get("content-type")) && text.trim().length > 0) {
            try {
              body = JSON.parse(text) as unknown;
            } catch {
              warnings.push("The response says it is JSON but does not parse; its text is kept as is.");
            }
          }
        }
        const output = { status: response.status, headers, body };
        if (!statusAccepted(response.status, ctx.node.config.successStatuses)) {
          return {
            status: "failed",
            error: { kind: "http_status", message: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}` },
            output
          };
        }
        return warnings.length > 0 ? { status: "succeeded", output, warnings } : { status: "succeeded", output };
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          return {
            status: "failed",
            error: { kind: "limit_exceeded", message: `The response body is larger than ${Math.floor(maxBody / 1024 / 1024)} MiB.` }
          };
        }
        if (timedOut) {
          return { status: "failed", error: { kind: "timeout", message: `The request did not finish within ${describeDuration(ctx.timeoutMs)}.` } };
        }
        if (ctx.signal.aborted) return { status: "cancelled" };
        const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
        const detail = typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message : undefined;
        const message = error instanceof Error ? error.message : String(error);
        return { status: "failed", error: { kind: "network", message: detail ? `${message} (${detail})` : message } };
      } finally {
        timer?.cancel();
        ctx.signal.removeEventListener("abort", onAbort);
        await ctx.setWaitingOn(undefined);
      }
    }
  };
}
