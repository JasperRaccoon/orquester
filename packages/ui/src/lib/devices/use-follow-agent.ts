/**
 * Devices — "Show the device when an agent opens one" (spec §10.2) wired to the app: the reducer in
 * `follow.logic.ts` fed by the devices store, the visible chat and the docked rail. Mounted once,
 * by the desktop rail frame (`RightRailFrame`); a phone never jumps away from the chat on its own —
 * the chat row's "Show device" brings the section up there.
 */

import { useEffect, useRef } from "react";

import { activeChatTab, subscribeActiveChatTab } from "../agent-chat-active-tab";
import { rightRailState, subscribeRightRail } from "../../components/right-rail/right-rail-state";
import { devicesStore } from "./store";
import { followLeases, followPanel, INITIAL_FOLLOW_STATE, type FollowState } from "./follow.logic";
import { showDeviceInPanel } from "./panel-focus";

export function useFollowAgentDevices(active: boolean): void {
  const state = useRef<FollowState>(INITIAL_FOLLOW_STATE);
  useEffect(() => {
    if (!active) return undefined;
    let railOpen = rightRailState().open;
    let visible = activeChatTab();
    const chatHasDevice = (threadId: string | null) =>
      threadId !== null && (devicesStore.getState().leases ?? []).some((lease) => lease.threadId === threadId);

    const onLeases = () => {
      const { leases, settings } = devicesStore.getState();
      const result = followLeases(state.current, leases, {
        visibleThreadId: activeChatTab(),
        follow: settings?.agents.followAgentDevices ?? true
      });
      state.current = result.state;
      if (result.open) showDeviceInPanel(result.open, { phone: false });
    };
    const onRail = () => {
      const open = rightRailState().open;
      if (open === railOpen) return;
      const was = railOpen;
      railOpen = open;
      if (open === "device") state.current = followPanel(state.current, activeChatTab(), true, chatHasDevice(activeChatTab()));
      else if (was === "device") state.current = followPanel(state.current, activeChatTab(), false, chatHasDevice(activeChatTab()));
    };
    const onChat = () => {
      const next = activeChatTab();
      if (next === visible) return;
      visible = next;
      // Showing a chat with the Device panel open counts as looking at its devices.
      if (rightRailState().open === "device") state.current = followPanel(state.current, next, true, chatHasDevice(next));
    };

    onLeases();
    const stops = [devicesStore.subscribe(onLeases), subscribeRightRail(onRail), subscribeActiveChatTab(onChat)];
    return () => {
      for (const stop of stops) stop();
    };
  }, [active]);
}
