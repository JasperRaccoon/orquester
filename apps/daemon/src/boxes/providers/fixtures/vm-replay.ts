/**
 * Test support for the VM provider adapters: a `fetch` that answers from
 * recorded, redacted provider responses (`fixtures/<provider>/*.json`) and
 * records every request so tests can assert what the adapter sent.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { BoxBootstrap, ProviderCallOptions, ProviderCreateRequest } from "../../contracts.ts";

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));

/** A recorded response body: `fixtures/<provider>/<name>.json`. */
export function fixture<T = unknown>(provider: string, name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, provider, `${name}.json`), "utf8")) as T;
}

export interface ReplayRoute {
  method: string;
  /** Exact URL (query included), or a pattern tested against the full URL. */
  url: string | RegExp;
  status?: number;
  /** JSON body (serialized) or text body (sent as is). Omitted = empty body. */
  body?: unknown;
  headers?: Record<string, string>;
  /** How many requests this route answers; default 1. `Infinity` for repeated reads. */
  times?: number;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Parsed JSON when the body was JSON, else the raw text; null when there was none. */
  body: unknown;
  rawBody: string | null;
}

export interface Replay {
  fetch: typeof fetch;
  requests: RecordedRequest[];
  /** Routes that still expect requests (`times` not used up, `Infinity` excluded). */
  pending(): ReplayRoute[];
}

/**
 * A fetch that answers each request with the first route that matches its
 * method and URL and still has uses left. Unmatched requests reject, which
 * fails the test with the request line in the message.
 */
export function replayFetch(routes: ReplayRoute[]): Replay {
  const remaining = routes.map((route) => ({ route, left: route.times ?? 1 }));
  const requests: RecordedRequest[] = [];
  const replay: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const rawBody = typeof init?.body === "string" ? init.body : null;
    let body: unknown = rawBody;
    if (rawBody !== null) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    requests.push({ method, url, headers, body, rawBody });
    const entry = remaining.find(
      (candidate) =>
        candidate.left > 0 &&
        candidate.route.method.toUpperCase() === method &&
        (typeof candidate.route.url === "string" ? candidate.route.url === url : candidate.route.url.test(url))
    );
    if (!entry) throw new Error(`replayFetch: no route for ${method} ${url}`);
    entry.left -= 1;
    const { route } = entry;
    const text = route.body === undefined ? "" : typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    const status = route.status ?? 200;
    return new Response(status === 204 || status === 304 ? null : text, {
      status,
      headers: { "content-type": "application/json", ...route.headers }
    });
  };
  return {
    fetch: replay,
    requests,
    pending: () => remaining.filter((entry) => entry.left > 0 && entry.left !== Infinity).map((entry) => entry.route)
  };
}

/** Call options for a replayed adapter call. */
export function replayOptions(replay: Replay): ProviderCallOptions {
  return { signal: AbortSignal.timeout(10_000), fetch: replay.fetch };
}

/** A bootstrap with recognizable bodies, so tests can find it in request payloads. */
export function testBootstrap(): BoxBootstrap {
  return {
    posixScript: "#!/bin/sh\necho orq-bootstrap-posix\n",
    powershellScript: "Write-Output 'orq-bootstrap-ps1'\n",
    containerCommand: ["/bin/sh", "-c", "echo orq-bootstrap-posix"],
    env: { ORQ_BOOTSTRAP: "1" },
    cloudInit: "#cloud-config\nruncmd:\n  - [sh, -c, 'echo orq-bootstrap-posix']\n"
  };
}

export const TEST_BOX_ID = "0a1b2c3d4e5f";

/** The standard create request tests use; pass the provider-specific fields. */
export function testCreateRequest(
  fields: Pick<ProviderCreateRequest, "size" | "region"> & Partial<ProviderCreateRequest>
): ProviderCreateRequest {
  return {
    boxId: TEST_BOX_ID,
    name: `orq-${TEST_BOX_ID}`,
    kind: "linux",
    image: null,
    tags: { "orquester-box": TEST_BOX_ID },
    bootstrap: testBootstrap(),
    sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOrqTestKeyOnlyForFixtures orq-box",
    windowsPassword: null,
    lifetimeMinutes: null,
    ...fields
  };
}
