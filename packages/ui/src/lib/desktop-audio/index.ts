// Desktop tab audio player: Opus over the desktop audio socket → WebCodecs (or WASM) decoder →
// AudioWorklet jitter buffer → per-desktop GainNode (spec §8.2, §8.3, §10.5).
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { DesktopAudioStateMessage } from "@orquester/api";

import { isDesktopAudioUnlocked, subscribeDesktopAudioUnlock, unlockDesktopAudio } from "./context.ts";
import { DesktopAudioController, type DesktopAudioControllerDeps, type DesktopAudioDecoderKind } from "./controller.ts";
import { createDesktopAudioDecoder, detectDesktopAudioDecoder } from "./decoder.ts";
import type { DesktopAudioStats } from "./jitter-buffer.ts";
import { createDesktopAudioOutput } from "./output.ts";

export type { DesktopAudioStats, DesktopAudioDecoderKind };
export { detectDesktopAudioDecoder, isDesktopAudioUnlocked, subscribeDesktopAudioUnlock, unlockDesktopAudio };

export interface UseDesktopAudioOptions {
  /** Authenticated audio socket URL (`api.desktopSocketUrl(desktopRoutes.audioSocket(id))`), or null. */
  url: string | null;
  /** Tab active AND document visible. The socket is open only when active && unlocked && !muted. */
  active: boolean;
  muted: boolean;
  /** 0..1 */
  volume: number;
}

export interface DesktopAudioState {
  /** The shared AudioContext has been unlocked by a user gesture. */
  unlocked: boolean;
  /** Call from inside a click/touchend handler. */
  unlock(): Promise<void>;
  decoder: DesktopAudioDecoderKind | "checking";
  serverState: DesktopAudioStateMessage | null;
  stats: DesktopAudioStats | null;
  error: string | null;
}

const browserDeps: DesktopAudioControllerDeps = {
  detectDecoder: detectDesktopAudioDecoder,
  createSocket: (url) => new WebSocket(url),
  createDecoder: createDesktopAudioDecoder,
  createOutput: createDesktopAudioOutput
};

export function useDesktopAudio({ url, active, muted, volume }: UseDesktopAudioOptions): DesktopAudioState {
  const unlocked = useSyncExternalStore(subscribeDesktopAudioUnlock, isDesktopAudioUnlocked, isDesktopAudioUnlocked);
  const [controller] = useState(() => new DesktopAudioController(browserDeps));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  useEffect(() => {
    controller.update({ url, active, unlocked, muted, volume });
  }, [controller, url, active, unlocked, muted, volume]);
  useEffect(() => () => controller.dispose(), [controller]);

  // Not async: the AudioContext must be created/resumed synchronously inside the gesture.
  const unlock = useCallback(
    () =>
      unlockDesktopAudio().then(
        () => setUnlockError(null),
        (error: unknown) => setUnlockError(`Couldn't enable sound: ${error instanceof Error ? error.message : String(error)}`)
      ),
    []
  );

  return useMemo(
    () => ({
      unlocked,
      unlock,
      decoder: snapshot.decoder,
      serverState: snapshot.serverState,
      stats: snapshot.stats,
      error: snapshot.error ?? unlockError
    }),
    [unlocked, unlock, snapshot, unlockError]
  );
}
