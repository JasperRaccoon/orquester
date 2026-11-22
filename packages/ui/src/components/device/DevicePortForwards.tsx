/**
 * The Device panel's port forwards (tailnet machines spec §4.6): which of the chat's project ports
 * the device reaches on its own `localhost` (Metro is added by the daemon when the device runs on
 * another machine), with Remove and an Add form. Read when the device is ready and after each change;
 * the daemon checks every port.
 */

import React from "react";
import { Cable, Loader2, Plus, X } from "lucide-react";

import { DEVICE_METRO_PORT, type DeviceLeaseSummary, type DevicePortForward } from "@orquester/api";

import { addDeviceForward, loadDeviceForwards, removeDeviceForward, type DeviceForwardsApi } from "../../lib/devices/store";

/** A port typed in the form: a whole number in range, else null. */
function parsePort(text: string, min: number): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= min && port <= 65_535 ? port : null;
}

function forwardLabel(forward: DevicePortForward): string {
  const target = forward.targetPort === forward.devicePort ? "" : ` → ${forward.targetPort}`;
  return `${forward.devicePort}${target}${forward.auto && forward.devicePort === DEVICE_METRO_PORT ? " · Metro" : ""}`;
}

export function DevicePortForwards(props: {
  api: DeviceForwardsApi | null;
  lease: Pick<DeviceLeaseSummary, "id" | "state">;
  onNotice: (text: string, tone?: "info" | "danger") => void;
}): React.ReactElement | null {
  const { api, lease, onNotice } = props;
  const [forwards, setForwards] = React.useState<DevicePortForward[] | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [devicePort, setDevicePort] = React.useState("");
  const [targetPort, setTargetPort] = React.useState("");
  const [saving, setSaving] = React.useState<number | "add" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const ready = lease.state === "ready";

  React.useEffect(() => {
    if (!api || !ready) return undefined;
    const abort = new AbortController();
    loadDeviceForwards(api, lease.id, abort.signal).then(
      (list) => setForwards(list),
      () => {
        if (!abort.signal.aborted) setForwards([]);
      }
    );
    return () => abort.abort();
  }, [api, lease.id, ready]);

  if (!api || !ready || forwards === null) return null;

  const remove = (port: number) => {
    setSaving(port);
    removeDeviceForward(api, lease.id, port)
      .then((list) => setForwards(list))
      .catch((err) => onNotice(err instanceof Error ? err.message : String(err), "danger"))
      .finally(() => setSaving(null));
  };

  const add = (event: React.FormEvent) => {
    event.preventDefault();
    const device = parsePort(devicePort, 1024);
    const target = targetPort.trim() === "" ? device : parsePort(targetPort, 1);
    if (device === null) return setError("The device port must be a number from 1024 to 65535.");
    if (target === null) return setError("The project port must be a number from 1 to 65535.");
    setError(null);
    setSaving("add");
    addDeviceForward(api, lease.id, { devicePort: device, targetPort: target })
      .then((list) => {
        setForwards(list);
        setAdding(false);
        setDevicePort("");
        setTargetPort("");
        onNotice(`The device reaches the project's port ${target} at localhost:${device}`);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSaving(null));
  };

  const inputClass =
    "h-6 w-[4.5rem] rounded border border-neutral-700 bg-neutral-900 px-1.5 text-base text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none sm:text-[11.5px]";

  return (
    <section className="shrink-0 border-t border-neutral-800/80 px-3 py-1.5" aria-label="Port forwards">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-neutral-500" title="Ports of this chat's project the device reaches on its own localhost">
          <Cable size={12} aria-hidden />
          Ports
        </span>
        {forwards.length === 0 && !adding ? <span className="text-[11px] text-neutral-600">none</span> : null}
        {forwards.map((forward) => (
          <span key={forward.devicePort} className="inline-flex items-center gap-1 rounded-full bg-neutral-800/80 py-0.5 pl-2 pr-0.5 text-[11px] text-neutral-300" title={`localhost:${forward.devicePort} on the device → the project's port ${forward.targetPort}${forward.auto ? " (added by Orquester)" : ""}`}>
            {forwardLabel(forward)}
            <button
              type="button"
              onClick={() => remove(forward.devicePort)}
              disabled={saving !== null}
              aria-label={`Stop forwarding port ${forward.devicePort}`}
              className="flex h-4 w-4 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-700 hover:text-neutral-100 disabled:opacity-50"
            >
              {saving === forward.devicePort ? <Loader2 size={10} className="animate-spin" aria-hidden /> : <X size={10} aria-hidden />}
            </button>
          </span>
        ))}
        {!adding ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-0.5 rounded px-1 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          >
            <Plus size={11} aria-hidden />
            Add port
          </button>
        ) : null}
      </div>
      {adding ? (
        <form onSubmit={add} className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <input aria-label="Port on the device" inputMode="numeric" placeholder="Device" value={devicePort} onChange={(event) => setDevicePort(event.target.value)} className={inputClass} autoFocus />
          <span className="text-[11px] text-neutral-500">→ project</span>
          <input aria-label="Port of the project (default: the same)" inputMode="numeric" placeholder="Same" value={targetPort} onChange={(event) => setTargetPort(event.target.value)} className={inputClass} />
          <button
            type="submit"
            disabled={saving !== null}
            className="inline-flex h-6 items-center gap-1 rounded bg-neutral-100 px-2 text-[11px] font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
          >
            {saving === "add" ? <Loader2 size={11} className="animate-spin" aria-hidden /> : null}
            Forward
          </button>
          <button
            type="button"
            onClick={() => {
              setAdding(false);
              setError(null);
            }}
            className="h-6 rounded px-1.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          >
            Cancel
          </button>
          {error ? (
            <p role="alert" className="w-full text-[11px] text-danger [overflow-wrap:anywhere]">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}
