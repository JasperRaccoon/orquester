/**
 * Config and transcript sync for boxes (spec §8.3, §8.5). Module map:
 *
 * | File | Role |
 * |---|---|
 * | `rules.ts` | Per-agent include/exclude lists, root kinds, the hard deny list, "executable" rules. |
 * | `codecs.ts` | Host file ↔ box copy: raw, MCP-secret-blanking JSON(C)/TOML, Claude's `.claude.json` subset. |
 * | `host-fs.ts` | Host walks (links followed), cached view hashes, writes through links. |
 * | `box-fs.ts` | Box walks over `fs.*`, hashing with one `exec` per batch, file transfer. |
 * | `store.ts` | `config-changes.json` (change sets) and the per-box sync baselines. |
 * | `config-sync.ts` | `BoxConfigSyncService` (`BoxConfigSync`): passes, watches, change sets, decisions. |
 * | `transcripts.ts` | `BoxTranscriptSyncService` (`BoxTranscriptSync`): pull after a turn, push before a resume. |
 * | `routes.ts` | `boxRoutes.configChanges` / `configChange(id)` and the `BOX_CONFIG_CHANGES_EVENT` publisher. |
 * | `testing.ts` | `mappedBoxConnection` (a box file system under its own dir), `fakeBoxHub`. |
 */

export { BoxConfigSyncService, BoxSyncError, wireChangeSet, type BoxConfigSyncOptions, type BoxSyncLogger } from "./config-sync.ts";
export { BoxTranscriptSyncService, claudeProjectDirName, type BoxTranscriptSyncOptions, type HostRunner, type TranscriptRequest } from "./transcripts.ts";
export { boxConfigChangesPublisher, registerBoxConfigChangeRoutes, type BoxConfigChangeRoutesDeps } from "./routes.ts";
export { execBoxHasher, type BoxHasher } from "./box-fs.ts";
