/**
 * Test doubles for the GPU adapter tests: a routed `fetch` stub that answers from
 * recorded fixtures (`fixtures/<provider>/`) and records every request it saw,
 * plus a sample `ProviderCreateRequest`. Nothing here reaches a provider.
 */

import { readFileSync } from "node:fs";
import type { Mock, TestContext } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { BoxBootstrap, ProviderCallOptions, ProviderCreateRequest } from "../contracts.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** A fixture file's text (`fixture("runpod", "pod-get-running.json")`). */
export function fixture(provider: string, name: string): string {
  return readFileSync(join(FIXTURES, provider, name), "utf8");
}

export interface SeenRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Parsed JSON when the body was JSON, else the raw string / FormData. */
  body: unknown;
}

export interface Reply {
  status?: number;
  body?: string | null;
  headers?: Record<string, string>;
}

export interface Route {
  method?: string;
  /** Matched against `pathname + search` (string = exact prefix of it). */
  path: string | RegExp;
  /** Replies in order; the last one repeats. */
  replies: Reply[];
}

/** A `fetch` that answers each request from the first matching route. Unmatched requests fail the test. */
export function routedFetch(routes: Route[]): { fetch: typeof fetch; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const counters = new Map<Route, number>();
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value])
    );
    let body: unknown = init?.body ?? null;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // keep the raw string
      }
    }
    seen.push({ method, url: url.toString(), headers, body });
    const target = url.pathname + url.search;
    const route = routes.find(
      (candidate) =>
        (candidate.method ?? "GET").toUpperCase() === method &&
        (typeof candidate.path === "string" ? target.startsWith(candidate.path) : candidate.path.test(target))
    );
    if (!route) throw new Error(`unexpected request ${method} ${url.toString()}`);
    const index = counters.get(route) ?? 0;
    counters.set(route, index + 1);
    const reply = route.replies[Math.min(index, route.replies.length - 1)]!;
    const status = reply.status ?? 200;
    return new Response(status === 204 ? null : (reply.body ?? null), {
      status,
      headers: { "content-type": "application/json", ...reply.headers }
    });
  }) as typeof fetch;
  return { fetch: stub, seen };
}

const fetchMocks = new WeakMap<TestContext, Mock<typeof fetch>>();

export function callOptions(t: TestContext, fetchStub: typeof fetch): ProviderCallOptions {
  const mocked = fetchMocks.get(t);
  if (mocked) mocked.mock.mockImplementation(fetchStub);
  else fetchMocks.set(t, t.mock.method(globalThis, "fetch", fetchStub));
  return { signal: AbortSignal.timeout(10_000) };
}

export const SAMPLE_BOOTSTRAP: BoxBootstrap = {
  posixScript: "#!/bin/sh\nset -eu\ncurl -fsSL \"$ORQ_DAEMON_URL/api/boxes/agent/linux-x64\" -o /tmp/orq-agent && exec /tmp/orq-agent\n",
  powershellScript: "Invoke-WebRequest $env:ORQ_DAEMON_URL -OutFile C:\\orq\\orq-agent.exe; & C:\\orq\\orq-agent.exe",
  containerCommand: ["/bin/sh", "-c", "curl -fsSL \"$ORQ_DAEMON_URL/api/boxes/agent/linux-x64\" -o /tmp/orq-agent && exec /tmp/orq-agent"],
  env: { ORQ_DAEMON_URL: "https://daemon.example.invalid", ORQ_BOOTSTRAP_TOKEN: "bootstrap-token-redacted" },
  cloudInit: "#cloud-config\nruncmd:\n  - [sh, -c, 'curl -fsSL https://daemon.example.invalid/x | sh']\n"
};

export function sampleCreateRequest(overrides: Partial<ProviderCreateRequest> = {}): ProviderCreateRequest {
  const boxId = overrides.boxId ?? "box-0123abcd";
  return {
    boxId,
    name: `orq-${boxId}`,
    kind: "linux-gpu",
    size: "",
    region: "",
    image: null,
    tags: { "orquester-box": boxId },
    bootstrap: SAMPLE_BOOTSTRAP,
    sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyOnlyForTests orq",
    windowsPassword: null,
    lifetimeMinutes: null,
    ...overrides
  };
}
