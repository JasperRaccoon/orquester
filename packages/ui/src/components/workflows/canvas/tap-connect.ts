/**
 * Tap-to-connect (workflows spec §7.4): on a touch screen, dragging from a
 * 28 px handle to another card is fiddly, so an output can be connected in
 * two taps — its chip ("+ Connect", or an output picked from a block's menu),
 * then the block it should feed. A pure reducer: the canvas feeds it taps and
 * performs the `connect` it answers with.
 */

import type { Workflow } from "@orquester/api";

import { connectionRefusal } from "./connection";

export interface TapConnectFrom {
  nodeId: string;
  handle: string;
}

export type TapConnectState =
  | { mode: "idle" }
  | {
      mode: "picking";
      from: TapConnectFrom;
      /** Why the last tapped block could not be connected. */
      refusal: string | null;
    };

export type TapConnectEvent =
  | { type: "start"; from: TapConnectFrom }
  | { type: "tap-node"; nodeId: string }
  /** A tap on empty canvas, Escape, the banner's Cancel. */
  | { type: "cancel" };

export interface TapConnectResult {
  state: TapConnectState;
  /** The edge to add, when a tap completed a connection. */
  connect: { source: string; sourceHandle: string; target: string } | null;
}

export const TAP_CONNECT_IDLE: TapConnectState = { mode: "idle" };

export function reduceTapConnect(
  state: TapConnectState,
  event: TapConnectEvent,
  workflow: Pick<Workflow, "nodes" | "edges">
): TapConnectResult {
  switch (event.type) {
    case "start":
      return { state: { mode: "picking", from: { ...event.from }, refusal: null }, connect: null };
    case "cancel":
      return { state: TAP_CONNECT_IDLE, connect: null };
    case "tap-node": {
      if (state.mode !== "picking") return { state, connect: null };
      // Its own block again: a change of mind.
      if (event.nodeId === state.from.nodeId) return { state: TAP_CONNECT_IDLE, connect: null };
      const request = { source: state.from.nodeId, sourceHandle: state.from.handle, target: event.nodeId };
      const refusal = connectionRefusal(workflow, request);
      if (refusal !== null) return { state: { ...state, refusal }, connect: null };
      return { state: TAP_CONNECT_IDLE, connect: request };
    }
  }
}

/** The banner's words while picking. */
export function tapConnectPrompt(
  state: TapConnectState,
  workflow: Pick<Workflow, "nodes">,
  handleLabel: (nodeId: string, handle: string) => string
): string | null {
  if (state.mode !== "picking") return null;
  const source = workflow.nodes.find((node) => node.id === state.from.nodeId);
  if (!source) return null;
  const label = handleLabel(source.id, state.from.handle);
  return `Choose a block to connect ${source.name}${label === "success" ? "" : ` · ${label}`} to`;
}
