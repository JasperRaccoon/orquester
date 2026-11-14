# Agent host update after boot — design (short)

**Intent.** A restart that changes the agent host's code made the daemon wait for the replacement
host (6–9 s on both VPSes: `[boot] … agent host 6.0s / 9.3s`) before its transports listened, so
browsers saw "Reconnecting…" that much longer. The user chose to stop the daemon waiting for it.

**Approaches.**
1. *Update after boot* — chosen: the boot adopts the old host as today; a stale one is updated as
   the supervisor's next queued step (the same `restartIfDrained` the health tick runs), so
   `init()` returns with the old host serving and the transports listen at once.
2. *Gap-free idle swap* — not chosen: start the replacement before stopping an idle old host
   (the busy-chat retire-and-switch path, always). Two hosts on every update and an ownership
   handover for every idle chat, for a gap of a few seconds.

**Design.** `AgentHostSupervisor.init({ updateAfterBoot: true })` (passed by
`AgentChatService.init`): both boot paths (`bootPrimary` case 3, `bootFromRegistry`) queue the
update instead of awaiting it. Busy chats keep working throughout (retire-and-switch); in the
all-idle case a chat request in the stop→start gap is answered `HOST_UNAVAILABLE`, which the UI
already retries with the same command id. `init()` without the option is unchanged.

**Tests.** `supervisor.test.ts` (case 3) and `supervisor.generations.test.ts` (busy stale primary):
with the option, `init()` returns before any replacement is spawned or any host retired/stopped,
and the update completes on the next queued step.
