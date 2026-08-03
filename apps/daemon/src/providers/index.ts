import type { GitProviderId } from "@orquester/api";

import { AccountError } from "../account-error";
import { bitbucketCloudProvider } from "./bitbucket-cloud";
import { bitbucketServerProvider } from "./bitbucket-server";
import { githubProvider } from "./github";
import type { GitProvider } from "./types";

/** Registry of implemented providers (partial while providers land task by task). */
const REGISTRY: Partial<Record<GitProviderId, GitProvider>> = {
  github: githubProvider,
  "bitbucket-cloud": bitbucketCloudProvider,
  "bitbucket-server": bitbucketServerProvider
};

/** Resolve a provider by id; throws a route-mapped 500 for unknown ids. */
export function providerFor(id: GitProviderId): GitProvider {
  const provider = REGISTRY[id];
  if (!provider) {
    throw new AccountError(500, `Unknown git provider: ${id}`);
  }
  return provider;
}
