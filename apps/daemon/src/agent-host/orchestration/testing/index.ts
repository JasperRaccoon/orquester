/**
 * Agent host — the test kit every host package may use (spec §9).
 *
 * `ScriptedAdapter` plus in-memory `ThreadStore` / `Ingestion` /
 * `CheckpointService` fakes, a manual clock, a manual timer wheel and a small
 * fold double. Nothing here waits on a timer, and none of it is reachable from
 * `main.ts`.
 */

export {
  createScriptedAdapter,
  type ScriptedAdapter,
  type ScriptedAdapterOptions,
  type ScriptedCall
} from "./scripted-adapter.ts";
export {
  createFakeCheckpointService,
  createFakeIngestion,
  createFakeThreadStore,
  createRecordingLogger,
  createTestClock,
  createTestIdGen,
  createTestTimers,
  type FakeCheckpointService,
  type FakeIngestion,
  type FakeThreadStore,
  type RecordingLogger,
  type TestClock,
  type TestTimers
} from "./fakes.ts";
export { createTestHost, type TestHost, type TestHostOptions } from "./harness.ts";
export {
  createMemoryLaunchConfigStore,
  type LaunchConfigStore,
  type ThreadLaunchConfig
} from "../launch-config.ts";
