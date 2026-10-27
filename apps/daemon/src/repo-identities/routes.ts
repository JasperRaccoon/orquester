import type { IncomingMessage } from "node:http";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  type FetchRepoFaviconRequest,
  type RepoIdentitiesResponse,
  type RepoIdentityResponse,
  type SetRepoEmojiRequest,
  type SetRepoLabelRequest,
  REPO_FAVICON_DOMAIN_MAX,
  REPO_ICON_MAX_BYTES,
  isRepoIconUploadType,
  repoIdentityRoutes,
  repoKeyProblem
} from "@orquester/api";
import { acceptRawBody, refuseUpload } from "../upload-stream.ts";
import { FaviconError, fetchFavicon, type FetchedFavicon } from "./favicon.ts";
import { RepoIdentitiesService, RepoIdentityError, iconTooLarge } from "./service.ts";

interface RepoIdentityRoutesDeps {
  service: RepoIdentitiesService;
}

/** Served with every icon: the stored type, never sniffed, and an SVG that can run nothing. */
const ICON_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'"
} as const;
/** When `?v=` names the current version, the bytes behind that URL never change. */
const ICON_CACHE_IMMUTABLE = "private, max-age=31536000, immutable";
/** Any other `?v=` (or none) gets the current bytes, which a later version may replace. */
const ICON_CACHE_NONE = "no-store";

/**
 * `/api/repo-identities` (spec 2026-10-18 §2, contracts in `@orquester/api` `repo-identities.ts`).
 * Both transports, like saved prompts: the bearer hook gates every `/api` route on HTTP — no
 * `?token=` exemption, the client fetches icons with auth and shows them from a blob URL.
 * Refusals are `{ code, message }` with the contract's statuses; every mutation answers
 * `{ identity }` (null once the repo has neither label nor icon).
 */
export function registerRepoIdentityRoutes(app: FastifyInstance, deps: RepoIdentityRoutesDeps): void {
  const { service } = deps;

  app.get(repoIdentityRoutes.list, async (): Promise<RepoIdentitiesResponse> => ({ identities: service.list() }));

  app.put<{ Body: SetRepoLabelRequest }>(repoIdentityRoutes.label, async (request, reply): Promise<RepoIdentityResponse | void> => {
    try {
      const body = bodyOf(request.body);
      return { identity: await service.setLabel(body.repoKey, body.label) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.put<{ Body: SetRepoEmojiRequest }>(repoIdentityRoutes.emoji, async (request, reply): Promise<RepoIdentityResponse | void> => {
    try {
      const body = bodyOf(request.body);
      return { identity: await service.setEmoji(body.repoKey, body.emoji) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Querystring: { repoKey?: unknown; v?: unknown } }>(repoIdentityRoutes.icon, async (request, reply) => {
    try {
      // Whatever `?v=` says, the current icon is served; only a matching one may be cached for good.
      const icon = await service.readIcon(request.query.repoKey);
      if (!icon) throw new RepoIdentityError("ICON_NOT_FOUND", "This repo has no image icon.");
      return reply
        .code(200)
        .headers(ICON_HEADERS)
        .header("cache-control", request.query.v === icon.version ? ICON_CACHE_IMMUTABLE : ICON_CACHE_NONE)
        .header("content-type", icon.contentType)
        .send(icon.bytes);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete<{ Querystring: { repoKey?: unknown } }>(repoIdentityRoutes.icon, async (request, reply): Promise<RepoIdentityResponse | void> => {
    try {
      return { identity: await service.clearIcon(request.query.repoKey) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // The upload: a raw application/octet-stream body (AGENTS.md: binary streams, not JSON), the
  // repo key and declared type in the query. The icon cap is far below the shared upload cap, so
  // the body is counted here, into memory, and refused the moment it passes the icon cap.
  app.register(async (scope) => {
    acceptRawBody(scope);
    scope.post<{ Querystring: { repoKey?: unknown; contentType?: unknown } }>(
      repoIdentityRoutes.icon,
      async (request, reply): Promise<RepoIdentityResponse | void> => {
        const { repoKey, contentType } = request.query;
        const keyProblem = repoKeyProblem(repoKey);
        if (keyProblem) return refuseUpload(reply, 400, "INVALID_REPO_KEY", keyProblem);
        if (!isRepoIconUploadType(contentType)) {
          return refuseUpload(reply, 400, "INVALID_ICON", "The icon must be a PNG, JPEG, WebP or SVG image.");
        }
        const declared = Number(request.headers["content-length"]);
        if (Number.isFinite(declared) && declared > REPO_ICON_MAX_BYTES) {
          const error = iconTooLarge();
          return refuseUpload(reply, error.status, error.code, error.message);
        }
        let bytes: Buffer | null;
        try {
          bytes = await readCappedBody(request.raw, REPO_ICON_MAX_BYTES);
        } catch {
          return refuseUpload(reply, 400, "INVALID_ICON", "The upload did not complete.");
        }
        if (bytes === null) {
          const error = iconTooLarge();
          return refuseUpload(reply, error.status, error.code, error.message);
        }
        try {
          return { identity: await service.setImage(repoKey, bytes, contentType) };
        } catch (error) {
          return sendError(reply, error);
        }
      }
    );
  });

  app.post<{ Body: FetchRepoFaviconRequest }>(repoIdentityRoutes.favicon, async (request, reply): Promise<RepoIdentityResponse | void> => {
    let repoKey: string;
    let domain: string;
    try {
      const body = bodyOf(request.body);
      const problem = repoKeyProblem(body.repoKey);
      if (problem) throw new RepoIdentityError("INVALID_REPO_KEY", problem);
      repoKey = body.repoKey as string;
      if (typeof body.domain !== "string" || body.domain.trim().length === 0 || body.domain.length > REPO_FAVICON_DOMAIN_MAX) {
        throw new RepoIdentityError("FAVICON_BAD_DOMAIN", "Enter a website domain, like example.com.");
      }
      domain = body.domain.trim();
      // One fetch per repo (spec §3b "Rate"), held on the service so the socket and HTTP share it.
      if (service.faviconFetches.has(repoKey)) {
        throw new RepoIdentityError("FAVICON_BUSY", "This repo's website icon is already being fetched.");
      }
    } catch (error) {
      return sendError(reply, error);
    }

    service.faviconFetches.add(repoKey);
    // A client that goes away stops the fetch; a reply that went out normally aborts nothing.
    const abort = new AbortController();
    const onClose = (): void => {
      if (!reply.raw.writableFinished) abort.abort();
    };
    reply.raw.once("close", onClose);
    try {
      let fetched: FetchedFavicon;
      try {
        fetched = await fetchFavicon(domain, { signal: abort.signal });
      } catch (error) {
        if (error instanceof FaviconError) throw new RepoIdentityError(error.code, error.message);
        throw new RepoIdentityError("FAVICON_UNREACHABLE", `Could not fetch the website icon of ${domain}.`);
      }
      try {
        return { identity: await service.setImage(repoKey, fetched.bytes, fetched.contentType, { kind: "favicon", domain: fetched.domain }) };
      } catch (error) {
        // An image the store refuses is no usable icon; the current one stays.
        if (error instanceof RepoIdentityError && (error.code === "INVALID_ICON" || error.code === "ICON_TOO_LARGE")) {
          throw new RepoIdentityError("FAVICON_NOT_FOUND", `${fetched.domain} has no usable icon.`);
        }
        throw error;
      }
    } catch (error) {
      return sendError(reply, error);
    } finally {
      service.faviconFetches.delete(repoKey);
      reply.raw.off("close", onClose);
    }
  });
}

/**
 * The raw body, or null the moment it passes `cap` (the rest is left unread: the caller answers
 * with `refuseUpload`'s `Connection: close`, so Node does not drain it). Never destroys `source`.
 */
async function readCappedBody(source: IncomingMessage, cap: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > cap) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

/** The JSON body as a field bag; a missing or non-object body reads as no fields (each is checked). */
function bodyOf(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function sendError(reply: FastifyReply, error: unknown): void {
  if (error instanceof RepoIdentityError) {
    void reply.code(error.status).send({ code: error.code, message: error.message });
    return;
  }
  void reply.code(500).send({ code: "REPO_IDENTITIES_ERROR", message: error instanceof Error ? error.message : "Repo identity operation failed." });
}
