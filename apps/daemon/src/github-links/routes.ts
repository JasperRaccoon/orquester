import type { FastifyInstance } from "fastify";
import {
  githubLinkRoutes,
  githubPreviewTarget,
  parseGitHubLink,
  type GitHubLinkPreviewError as GitHubLinkPreviewErrorBody,
  type GitHubLinkPreviewResponse
} from "@orquester/api";

import { GitHubLinkPreviewError, type GitHubLinkPreviewService } from "./service.ts";

export interface GitHubLinkRoutesDeps {
  service: Pick<GitHubLinkPreviewService, "preview">;
}

const URL_MAX = 4096;
const PROJECT_PATH_MAX = 4096;

/**
 * `GET /api/github/link-preview?url=&projectPath=` (contracts in `@orquester/api`
 * `forge-links.ts`). Both transports; the bearer hook gates it on HTTP like
 * every `/api` route. The URL is re-parsed here with the UI's own parser, so
 * the only GitHub reads a client can cause are the PR, issue or commit a
 * GitHub link names. Refusals are `{ code, message, retryAfterMs? }`; a 429
 * also carries `Retry-After`.
 */
export function registerGitHubLinkRoutes(app: FastifyInstance, deps: GitHubLinkRoutesDeps): void {
  app.get<{ Querystring: { url?: unknown; projectPath?: unknown } }>(
    githubLinkRoutes.preview,
    async (request, reply): Promise<GitHubLinkPreviewResponse | void> => {
      const url = typeof request.query.url === "string" && request.query.url.length <= URL_MAX ? request.query.url : "";
      const link = parseGitHubLink(url);
      const target = link ? githubPreviewTarget(link) : null;
      if (!target) {
        const body: GitHubLinkPreviewErrorBody = {
          code: "INVALID_LINK",
          message: "Only GitHub pull request, issue and commit links have a preview."
        };
        return reply.code(400).send(body);
      }
      const rawProjectPath = request.query.projectPath;
      const projectPath =
        typeof rawProjectPath === "string" && rawProjectPath.length > 0 && rawProjectPath.length <= PROJECT_PATH_MAX
          ? rawProjectPath
          : undefined;
      try {
        return { preview: await deps.service.preview(target, projectPath) };
      } catch (error) {
        const refusal =
          error instanceof GitHubLinkPreviewError ? error : new GitHubLinkPreviewError("UPSTREAM", "GitHub could not be read.");
        const body: GitHubLinkPreviewErrorBody = {
          code: refusal.code,
          message: refusal.message,
          ...(refusal.retryAfterMs !== undefined ? { retryAfterMs: refusal.retryAfterMs } : {})
        };
        if (refusal.retryAfterMs !== undefined) reply.header("retry-after", String(Math.ceil(refusal.retryAfterMs / 1000)));
        return reply.code(refusal.status).send(body);
      }
    }
  );
}
