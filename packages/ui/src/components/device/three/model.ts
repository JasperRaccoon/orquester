// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/model.ts
import type { DevicePlatform } from "./types.ts";

export type DeviceModelId =
  | "iphone-18-pro"
  | "iphone-18-pro-max"
  | "iphone-17"
  | "iphone-air"
  | "iphone-17e"
  | "ipad-pro-13-m5"
  | "ipad-air"
  | "ipad-a16"
  | "iphone-duo";

export interface DeviceModelSource {
  readonly id: DeviceModelId;
  readonly url: string;
}

export interface DeviceAccessorySource {
  readonly id: "ipad-pro-13-m5-magic-keyboard";
  readonly modelId: "ipad-pro-13-m5";
  readonly url: string;
}

export type DeviceAssetSource = DeviceModelSource | DeviceAccessorySource;

/**
 * Simulator device-type names, matched whole and case-insensitively. A name that is not listed
 * gets the procedural body from its shape profile.
 */
const MODEL_NAMES: ReadonlyArray<readonly [RegExp, DeviceModelId]> = [
  [/^iPhone Duo$/i, "iphone-duo"],
  [/^iPhone 18 Pro Max$/i, "iphone-18-pro-max"],
  [/^iPhone 18 Pro$/i, "iphone-18-pro"],
  [/^iPhone 17$/i, "iphone-17"],
  [/^iPhone Air$/i, "iphone-air"],
  [/^iPhone 17e$/i, "iphone-17e"],
  [/^iPad Pro 13-inch \(M5\)$/i, "ipad-pro-13-m5"],
  [/^iPad Air (11|13)-inch \((M3|M4)\)$/i, "ipad-air"],
  [/^iPad \(A16\)$/i, "ipad-a16"],
];

export function resolveDeviceModelId(platform: DevicePlatform, name: string): DeviceModelId | null {
  if (platform !== "ios") return null;
  return MODEL_NAMES.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

/** Each request owns its result. A cancelled or superseded parse must still release its resources. */
export function createDeviceModelSlot<
  T extends { dispose: () => void },
  Source extends DeviceAssetSource = DeviceModelSource,
>(options: {
  load: (source: Source, signal: AbortSignal) => Promise<T>;
  install: (model: T | null) => void;
  onError?: ((cause: unknown) => void) | undefined;
}) {
  let request: { source: Source; controller: AbortController } | null = null;
  let current: T | null = null;
  let disposed = false;
  const clear = () => {
    if (current) options.install(null);
    current?.dispose();
    current = null;
  };
  return {
    set(source: Source | null) {
      if (disposed) return;
      if (source?.id === request?.source.id && source?.url === request?.source.url) return;
      request?.controller.abort();
      request = null;
      clear();
      if (!source) return;
      const next = { source, controller: new AbortController() };
      request = next;
      void options.load(source, next.controller.signal).then(
        (model) => {
          if (disposed || request !== next) {
            model.dispose();
            return;
          }
          try {
            options.install(model);
            current = model;
          } catch (cause) {
            options.install(null);
            model.dispose();
            request = null;
            options.onError?.(cause);
          }
        },
        (cause: unknown) => {
          if (!disposed && request === next) {
            request = null;
            options.onError?.(cause);
          }
        },
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      request?.controller.abort();
      request = null;
      clear();
    },
  };
}
