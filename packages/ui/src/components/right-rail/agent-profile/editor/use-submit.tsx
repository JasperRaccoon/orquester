/**
 * One save at a time, and what its refusal means: `INVALID_NAME` goes beside
 * the name field, `ITEM_EXISTS` asks Replace / Keep both and sends the same
 * request again with that `onConflict`, `PROFILE_CONFLICT` says "Changed on
 * disk" and offers Reload, anything else is the banner above the Save bar.
 * A save that lands closes the editor and tells the panel — even if the
 * editor was closed while it was in flight; one refused after the editor
 * closed says so in the panel's notice rather than nowhere.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";

import type { ProfileConflictPolicy, ProfileMutationResponse } from "@orquester/api";

import { setAgentProfileNotice } from "../../../../lib/agent-profile/store";
import { useEditorEnv } from "./env";
import { profileError, profileErrorPlacement, type ProfileErrorInfo, type ProfileErrorPlacement } from "./errors";
import { Banner, SmallButton } from "./fields";

export type MutationSend = (onConflict?: ProfileConflictPolicy) => Promise<ProfileMutationResponse>;

export interface SubmitState {
  busy: boolean;
  error: ProfileErrorInfo | null;
  placement: ProfileErrorPlacement | null;
}

export interface ProfileSubmit extends SubmitState {
  run(send: MutationSend, onConflict?: ProfileConflictPolicy): Promise<void>;
  /** The Replace / Keep both answer to an `ITEM_EXISTS`. */
  resolveConflict(policy: Exclude<ProfileConflictPolicy, "fail">): void;
  clear(): void;
  /** The name field's refusal, when the daemon's answer was about the name. */
  nameError: string | undefined;
}

export function useProfileSubmit(): ProfileSubmit {
  const env = useEditorEnv();
  const [state, setState] = useState<SubmitState>({ busy: false, error: null, placement: null });
  const inFlight = useRef(false);
  const lastSend = useRef<MutationSend | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(
    async (send: MutationSend, onConflict?: ProfileConflictPolicy) => {
      if (inFlight.current) return;
      inFlight.current = true;
      lastSend.current = send;
      setState({ busy: true, error: null, placement: null });
      env.setSaving(true);
      try {
        const response = await send(onConflict);
        inFlight.current = false;
        env.setSaving(false);
        env.finish(response);
      } catch (error) {
        inFlight.current = false;
        env.setSaving(false);
        const info = profileError(error);
        if (!alive.current) {
          // Closed while it was in flight: the editor that would show why is gone.
          setAgentProfileNotice({ tone: "error", text: `Your change was not saved: ${info.message}` });
          return;
        }
        setState({ busy: false, error: info, placement: profileErrorPlacement(info) });
      }
    },
    [env]
  );

  const resolveConflict = useCallback(
    (policy: Exclude<ProfileConflictPolicy, "fail">) => {
      const send = lastSend.current;
      if (send) void run(send, policy);
    },
    [run]
  );

  const clear = useCallback(() => {
    setState((current) => (current.error === null ? current : { busy: current.busy, error: null, placement: null }));
  }, []);

  return {
    ...state,
    run,
    resolveConflict,
    clear,
    nameError: state.placement === "name" ? state.error?.message : undefined
  };
}

/**
 * The refusal above the Save bar. `name` refusals are the name field's when
 * the editor has one (`nameShown`: not repeated here) — an editor without one
 * (an import, a copy, a plugin install, a hook) shows them here, or they would
 * be said nowhere; `onReload` is what "Changed on disk" offers.
 * `onResolveConflict` is for a CREATE only: an edit's `ITEM_EXISTS` (a rename
 * onto a name that is taken) is a plain refusal, since `PUT …/items/:id` takes
 * no `onConflict` — offering Replace / Keep both there would only send the
 * same request again. `keepBoth` is for the named kinds only (MCP servers,
 * skills, commands): a second copy of one plugin, marketplace or hook is
 * refused or refused again by the adapters, so those offer Replace alone.
 */
export const SubmitStatus: React.FC<{
  state: Pick<SubmitState, "error" | "placement">;
  onResolveConflict?: (policy: "replace" | "keep-both") => void;
  onDismiss?: () => void;
  onReload?: () => void;
  /** The editor shows `INVALID_NAME` beside its own name field. */
  nameShown?: boolean;
  /** Offer Keep both (a suffixed second copy) beside Replace. */
  keepBoth?: boolean;
}> = ({ state, onResolveConflict, onDismiss, onReload, nameShown = false, keepBoth = true }) => {
  const { error, placement } = state;
  if (error === null || (placement === "name" && nameShown)) return null;
  if (placement === "exists" && onResolveConflict) {
    return (
      <Banner
        tone="warn"
        title="It already exists"
        actions={
          <>
            <SmallButton onClick={() => onResolveConflict("replace")}>Replace</SmallButton>
            {keepBoth ? <SmallButton onClick={() => onResolveConflict("keep-both")}>Keep both</SmallButton> : null}
            {onDismiss ? <SmallButton onClick={onDismiss}>Cancel</SmallButton> : null}
          </>
        }
      >
        {error.message} {keepBoth ? "Replace it, or keep both (the new one gets a suffix)?" : "Replace it?"}
      </Banner>
    );
  }
  if (placement === "changed") {
    return (
      <Banner
        tone="warn"
        title="Changed on disk"
        actions={onReload ? <SmallButton onClick={onReload}>Reload (discard my changes)</SmallButton> : undefined}
      >
        {error.message}
      </Banner>
    );
  }
  return <Banner tone="error">{error.message}</Banner>;
};
