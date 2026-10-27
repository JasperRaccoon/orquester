// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/model.test.ts
import assert from "node:assert/strict";
import { it, mock } from "node:test";
import { createDeviceModelSlot, type DeviceModelSource } from "./model.ts";

const pro: DeviceModelSource = { id: "iphone-18-pro", url: "/pro.glb" };
const max: DeviceModelSource = { id: "iphone-18-pro-max", url: "/max.glb" };

type Loaded = { dispose: () => void };

function fixture() {
  const pending: {
    signal: AbortSignal;
    resolve: (model: Loaded) => void;
    reject: (error: Error) => void;
  }[] = [];
  const install = mock.fn((_model: Loaded | null) => {});
  const load = mock.fn(
    (_source: DeviceModelSource, signal: AbortSignal) =>
      new Promise<Loaded>((resolve, reject) => pending.push({ signal, resolve, reject })),
  );
  const slot = createDeviceModelSlot({ load, install });
  return { slot, pending, install, load };
}

const disposable = () => ({ dispose: mock.fn() });
const lastInstalled = (install: ReturnType<typeof fixture>["install"]) =>
  install.mock.calls.at(-1)?.arguments;

it("cancels superseded downloads and releases a late decoded model without installing it", async () => {
  const { slot, pending, install, load } = fixture();
  slot.set(pro);
  slot.set({ ...pro });
  assert.equal(load.mock.callCount(), 1);
  slot.set(max);
  assert.equal(pending[0]!.signal.aborted, true);
  const latest = disposable();
  const stale = disposable();
  pending[1]!.resolve(latest);
  await Promise.resolve();
  pending[0]!.resolve(stale);
  await Promise.resolve();
  assert.equal(install.mock.callCount(), 1);
  assert.equal(install.mock.calls[0]!.arguments[0], latest);
  assert.equal(stale.dispose.mock.callCount(), 1);
  slot.set(null);
  assert.deepEqual(lastInstalled(install), [null]);
  assert.equal(latest.dispose.mock.callCount(), 1);
  slot.dispose();
  assert.equal(latest.dispose.mock.callCount(), 1);
});

it("keeps the fallback on request failure and disposes results that finish after teardown", async () => {
  const { slot, pending, install } = fixture();
  slot.set(pro);
  pending[0]!.reject(new Error("offline"));
  await Promise.resolve();
  assert.equal(install.mock.callCount(), 0);
  slot.set(max);
  slot.dispose();
  assert.equal(pending[1]!.signal.aborted, true);
  const late = disposable();
  pending[1]!.resolve(late);
  await Promise.resolve();
  assert.equal(late.dispose.mock.callCount(), 1);
  assert.equal(install.mock.callCount(), 0);
});

it("retries a failed source while ignoring rejection of a superseded request", async () => {
  const { slot, pending, install, load } = fixture();
  slot.set(pro);
  pending[0]!.reject(new Error("offline"));
  await Promise.resolve();
  slot.set({ ...pro });
  assert.equal(load.mock.callCount(), 2);
  slot.set(max);
  pending[1]!.reject(new Error("cancelled"));
  await Promise.resolve();
  slot.set({ ...max });
  assert.equal(load.mock.callCount(), 3);
  const recovered = disposable();
  pending[2]!.resolve(recovered);
  await Promise.resolve();
  assert.equal(install.mock.callCount(), 1);
  assert.equal(install.mock.calls[0]!.arguments[0], recovered);
  slot.dispose();
});

it("releases an invalid model and restores the fallback if scene preparation rejects it", async () => {
  const { slot, pending, install } = fixture();
  install.mock.mockImplementationOnce(() => {
    throw new Error("invalid display");
  });
  slot.set(pro);
  const model = disposable();
  pending[0]!.resolve(model);
  await Promise.resolve();
  assert.equal(model.dispose.mock.callCount(), 1);
  assert.deepEqual(lastInstalled(install), [null]);
  slot.set({ ...pro });
  const recovered = disposable();
  pending[1]!.resolve(recovered);
  await Promise.resolve();
  assert.equal(lastInstalled(install)?.[0], recovered);
  slot.dispose();
});
