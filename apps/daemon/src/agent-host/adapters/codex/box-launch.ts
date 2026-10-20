/**
 * Codex adapter — `codex app-server` in a box (spec 2026-10-19 §7, §8.4,
 * §8.5).
 *
 * - The launch (`boxes/index.ts`): the System account refused, the config
 *   (the account home, or a profile's prepared home) synced, the thread's
 *   rollout pushed for a resume, and the box's `codex` resolved — installed
 *   with `npm i -g @openai/codex` when the box has none — and version-gated.
 * - The child runs with the box env and `CODEX_HOME` mapped; it holds no
 *   `auth.json`: the session logs it in with `chatgptAuthTokens`
 *   (`session.ts` `loginBox`) and answers its refresh requests through the
 *   broker.
 * - Orquester's session tools reach it through `orq-agent mcp-bridge`: the
 *   endpoint and its credential stay here, so the box gets no bearer env
 *   variable at all.
 */

import type { AdapterContext, StartSessionInput } from "../../adapter.ts";
import { requireBoxes, type BoxLaunch } from "../../boxes/index.ts";
import { BoxLaunchError } from "../../boxes/errors.ts";
import { MINIMUM_CODEX_VERSION, meetsMinimumVersion } from "./probe.ts";
import type { CodexProfileLaunch } from "./profile.ts";
import { CODEX_SESSION_TOOLS_TOKEN_ENV } from "./session-tools.ts";

/** The thread's Codex session id a cursor names, for the transcript push (`{threadId}`). */
function codexSessionRef(cursor: unknown): string | null {
  if (typeof cursor !== "object" || cursor === null) return null;
  const threadId = (cursor as { threadId?: unknown }).threadId;
  return typeof threadId === "string" && threadId.length > 0 ? threadId : null;
}

/** `codex --version` (`codex-cli 0.159.0`) → `0.159.0`; null when it does not read. */
export function parseCodexVersion(output: string): string | null {
  return /(\d+\.\d+\.\d+[^\s]*)/.exec(output)?.[1] ?? null;
}

/** Prepare the box start and gate the box's `codex` version. */
export async function launchCodexInBox(
  context: AdapterContext,
  input: StartSessionInput & { box: NonNullable<StartSessionInput["box"]> },
  codexHome: string | null
): Promise<BoxLaunch> {
  const launch = await requireBoxes(context).launch({
    threadId: input.threadId,
    agent: "codex",
    box: input.box,
    home: input.home,
    cwd: input.cwd,
    ...(input.profile !== undefined ? { profile: input.profile } : {}),
    ...(codexHome !== null ? { configRoot: codexHome } : {}),
    resumeSessionRef: codexSessionRef(input.resumeCursor),
    signal: context.signal,
    onProgress: (message) => context.logger.info(`codex: ${message}`, { threadId: input.threadId })
  });
  const version = parseCodexVersion((await launch.version()) ?? "");
  if (!meetsMinimumVersion(version, MINIMUM_CODEX_VERSION)) {
    await launch.close();
    throw new BoxLaunchError(
      "BOX_CLI_VERSION",
      `In the box: codex ${version ?? "(version unreadable)"} is below the required ${MINIMUM_CODEX_VERSION}. Update it in the box's terminal (npm update -g @openai/codex), then send the message again.`
    );
  }
  return launch;
}

/** What `CodexSession` gets for a box start: the box env, cwd, home, profile and session-tool bridge. */
export async function codexBoxSessionPieces(input: {
  launch: BoxLaunch;
  hostEnv: Record<string, string>;
  cwd: string;
  codexHome: string | null;
  profile: CodexProfileLaunch | undefined;
  grant: { url: string; token: string } | undefined;
}): Promise<{
  env: Record<string, string>;
  envUnset: string[];
  cwd: string;
  codexHome: string | undefined;
  profile: CodexProfileLaunch | undefined;
  bridge: { command: string; args: string[] } | undefined;
}> {
  const { launch } = input;
  const hostEnv = { ...input.hostEnv };
  // The bearer never enters the box: the bridge holds it on this side.
  delete hostEnv[CODEX_SESSION_TOOLS_TOKEN_ENV];
  const { env, unset } = launch.env(hostEnv);
  const codexHome = input.codexHome !== null ? launch.toBox(input.codexHome) : undefined;
  if (codexHome !== undefined) env.CODEX_HOME = codexHome;
  let profile: CodexProfileLaunch | undefined;
  if (input.profile !== undefined) {
    // The home Codex reports on `initialize` is the BOX's path, perhaps canonicalised there.
    const boxHome = launch.toBox(input.profile.codexHome);
    const boxReal = await launch.connection.request("fs.realpath", { path: boxHome }).catch(() => null);
    profile = {
      codexHome: boxHome,
      ...(typeof boxReal === "string" && boxReal !== boxHome ? { codexHomeReal: boxReal } : {}),
      userSkillRoots: input.profile.userSkillRoots.map((root) => launch.toBox(root))
    };
  }
  const bridge =
    input.grant !== undefined
      ? await launch.bridgeHttp("orquester", input.grant.url, { Authorization: `Bearer ${input.grant.token}` })
      : undefined;
  return { env, envUnset: unset, cwd: launch.toBox(input.cwd), codexHome, profile, bridge };
}
