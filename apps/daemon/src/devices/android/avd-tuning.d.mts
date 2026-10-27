/** Types of `avd-tuning.mjs` (plain JavaScript so the device-cache workflow can run it unchanged). */

export function parseIni(text: string): Map<string, string>;

export function patchAvdConfig(text: string, options: { name: string; hardware: { width: number; height: number; density: number }; gpuMode: string }): string;

export function cutoutSpecInDp(spec: string, density: number): string | null;

export function hasAvdPlaceholders(text: string): boolean;
