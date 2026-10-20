/**
 * The GitHub side of the Blacksmith macOS setup (spec §11.2): the {@link BlacksmithSetupDriver}
 * the box settings run step by step, over the control repo client. The token is the Git hosting
 * account's and is only ever sent to the GitHub API.
 *
 * Refusals carry the fix and the page to make it on. Two cases pass with a note instead of
 * blocking, because the token cannot see the answer and the setup's test run will:
 * - the org does not say whether members may create private repos;
 * - the token may not list the org's app installations (not an owner, or no `admin:org`).
 */

import type { ProviderCredentials } from "../contracts.ts";
import { BLACKSMITH_CREDENTIAL_KEYS } from "../providers/blacksmith.ts";
import { ProviderHttpError } from "../providers/http.ts";
import type { BlacksmithCheck, BlacksmithSetupDriver } from "../service/settings.ts";
import {
  checkGithubAccount,
  checkGithubToken,
  detectBlacksmithApp,
  ensureControlRepo,
  ensureWorkflowFile,
  waitWorkflowReady,
  type GithubCallOptions
} from "./control-repo.ts";
import { githubOidcAudience } from "./oidc.ts";
import { BLACKSMITH_CONTROL_REPO_NAME, BLACKSMITH_WORKFLOW_FILE, BLACKSMITH_WORKFLOW_PATH, blacksmithWorkflowTemplate } from "./workflow-template.ts";

const TOKENS_URL = "https://github.com/settings/tokens";

export interface BlacksmithSetupDriverOptions {
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Default https://api.github.com. */
  apiUrl?: string;
}

function orgPath(org: string): string {
  return encodeURIComponent(org);
}

function actionNeeded(message: string, actionUrl: string | null): BlacksmithCheck {
  return { ok: false, message, actionUrl };
}

export function createBlacksmithSetupDriver(options: BlacksmithSetupDriverOptions = {}): BlacksmithSetupDriver {
  const call = (token: string, signal: AbortSignal): GithubCallOptions => ({
    token,
    signal,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.apiUrl ? { apiUrl: options.apiUrl } : {})
  });

  return {
    async checkAccount(token, signal) {
      let result;
      try {
        result = await checkGithubToken(call(token, signal));
      } catch (error) {
        if (error instanceof ProviderHttpError && error.status === 401) {
          return actionNeeded("GitHub rejected this account's token; create a new classic token with the repo and workflow scopes.", TOKENS_URL);
        }
        throw error;
      }
      if (result.problem !== null) return actionNeeded(result.problem, TOKENS_URL);
      return { ok: true, message: `Signed in as ${result.login}.` };
    },

    async checkOrg(token, org, signal) {
      const result = await checkGithubAccount(org, call(token, signal));
      if (result.problem !== null) {
        let actionUrl: string;
        if (result.scopes === null || result.missingScopes.length > 0) actionUrl = TOKENS_URL;
        else if (result.orgRole === null) actionUrl = `https://github.com/orgs/${orgPath(org)}/people`;
        else if (result.membershipState === "pending") actionUrl = `https://github.com/orgs/${orgPath(org)}/invitation`;
        else actionUrl = `https://github.com/organizations/${orgPath(org)}/settings/member_privileges`;
        return actionNeeded(result.problem, actionUrl);
      }
      if (result.canCreateRepo === null) {
        return {
          ok: true,
          message: `${result.login} is a member of ${org}; GitHub does not say whether members may create private repositories there, so creating the control repo may fail.`
        };
      }
      return { ok: true, message: `${result.login} is ${result.orgRole === "admin" ? "an owner" : "a member"} of ${org}.` };
    },

    async checkApp(token, org, signal) {
      const app = await detectBlacksmithApp(org, call(token, signal));
      if (app.installed === false) {
        return actionNeeded(`Install the Blacksmith GitHub App on ${org} (an org owner must approve it), then run the checks again.`, app.installUrl);
      }
      if (app.installed === null) {
        // Listing installations needs an org owner token with admin:org; members cannot see them.
        // Pass with a note: the test run shows whether Blacksmith picks up the job.
        return {
          ok: true,
          message: `Could not verify the Blacksmith GitHub App on ${org} (only an org owner's token with admin:org can list installed apps). Make sure it is installed: ${app.installUrl}`
        };
      }
      if (app.suspended) {
        return actionNeeded(
          `The Blacksmith GitHub App is suspended on ${org}; unsuspend it in the org's GitHub Apps settings.`,
          `https://github.com/organizations/${orgPath(org)}/settings/installations`
        );
      }
      if (app.repositorySelection === "selected") {
        return {
          ok: true,
          message: `The Blacksmith GitHub App is installed on ${org} for selected repositories; include ${org}/${BLACKSMITH_CONTROL_REPO_NAME} in them.`
        };
      }
      return { ok: true, message: `The Blacksmith GitHub App is installed on ${org}.` };
    },

    async ensureControlRepo(token, org, { daemonUrl, signal }) {
      // The workflow takes the daemon URL as a dispatch input and requests its OIDC token with
      // the URL's origin as audience; its input check accepts https URLs only.
      const audience = githubOidcAudience(daemonUrl);
      if (!audience.startsWith("https://")) {
        throw new Error(`macOS boxes need the daemon reachable over https; ${audience} is not.`);
      }
      const github = call(token, signal);
      const repo = await ensureControlRepo(org, github);
      await ensureWorkflowFile(repo, BLACKSMITH_WORKFLOW_PATH, blacksmithWorkflowTemplate(), github);
      await waitWorkflowReady(repo.repository, BLACKSMITH_WORKFLOW_FILE, github);
      return { repo: repo.repository, workflowFile: BLACKSMITH_WORKFLOW_FILE };
    },

    adapterCredentials({ token, org, repo }): ProviderCredentials {
      return {
        [BLACKSMITH_CREDENTIAL_KEYS.githubToken]: token,
        [BLACKSMITH_CREDENTIAL_KEYS.org]: org,
        [BLACKSMITH_CREDENTIAL_KEYS.repo]: repo
      };
    }
  };
}
