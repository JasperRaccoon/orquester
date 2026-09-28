/**
 * Agent host — the test kit every host package may use (spec §9).
 *
 * `ScriptedAdapter` plus in-memory `ThreadStore` / `Ingestion` /
 * `CheckpointService` fakes and a manual event clock. Elapsed-time tests use
 * Node's native mock timers; none of this support is reachable from `main.ts`.
 */

export {
  createScriptedAdapter,
  type ScriptedAdapter,
  type ScriptedAdapterOptions,
  type ScriptedCall
} from "./scripted-adapter.ts";
export {
  createFakeCheckpointService,
  createMemoryLaunchConfigStore,
  createFakeIngestion,
  createFakeThreadStore,
  createRecordingLogger,
  createTestClock,
  createTestIdGen,
  type FakeCheckpointService,
  type FakeIngestion,
  type FakeThreadStore,
  type RecordingLogger,
  type TestClock
} from "./fakes.ts";
export { createTestHost, type TestHost, type TestHostOptions } from "./harness.ts";
export {
  type LaunchConfigStore,
  type ThreadLaunchConfig
} from "../launch-config.ts";
