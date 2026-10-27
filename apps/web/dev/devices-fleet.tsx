/**
 * Dev-only harness: the Devices fleet view over a made-up fleet (`fixtures.test-helpers.ts`),
 * with drawn screens as thumbnails, in either theme and at any width — for visual checks without
 * a daemon. Never part of the production build (Vite builds index.html only).
 */

import React from "react";
import ReactDOM from "react-dom/client";

import "../../../packages/ui/src/styles/globals.css";
import "../src/styles.css";

import type { DevicesStateResponse } from "../../../packages/api/src/devices";
import type { ApiClient } from "../../../packages/ui/src/lib/api-client";
import { loadDevices } from "../../../packages/ui/src/lib/devices/store";
import { useAppStore } from "../../../packages/ui/src/store/app";
import { DevicesFleetHeader } from "../../../packages/ui/src/components/devices-fleet/DevicesFleetEntry";
import { DevicesFleetView } from "../../../packages/ui/src/components/devices-fleet/DevicesFleetView";
import { fleetFixture } from "../../../packages/ui/src/components/devices-fleet/fixtures.test-helpers";
import { defaultThumbnailDeps, type ThumbnailDeps } from "../../../packages/ui/src/components/devices-fleet/thumbnail-poller";

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.mode = params.get("mode") === "light" ? "light" : "dark";
document.documentElement.dataset.scheme = params.get("scheme") ?? "default";
document.documentElement.style.colorScheme = document.documentElement.dataset.mode;

const fleet = fleetFixture(Date.now());
const state: DevicesStateResponse = {
  enabled: true,
  hosts: params.get("empty") ? [fleet.hosts[1]!, fleet.hosts[0]!] : fleet.hosts,
  leases: params.get("empty") ? [] : fleet.leases,
  profiles: [],
  settings: fleet.settings,
  setupJobs: [],
  pool: fleet.pool
};

const api = {
  connection: { id: "harness" },
  async devicesState() {
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (params.get("fail")) throw new Error("connect ECONNREFUSED 127.0.0.1:4318");
    return state;
  },
  async deviceLeaseActions(leaseId: string) {
    return { leaseId, actions: fleet.actions[leaseId] ?? [] };
  },
  deviceHttpRequest: (path: string) => ({ url: `harness:${path}`, headers: { Authorization: "Bearer t" } }),
  async setDeviceHostDraining(hostId: string) {
    return { host: state.hosts.find((host) => host.id === hostId)! };
  },
  async destroyDeviceHost() {},
  async warmDeviceCaches() {
    return { started: true, message: null };
  }
} as unknown as ApiClient;

// A drawn app screen per device, changing every second, as the hub's screenshot would.
const HUES = [212, 152, 28, 280, 340, 190, 48];
function drawScreen(device: string): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = 270;
  canvas.height = 585;
  const ctx = canvas.getContext("2d")!;
  const hue = HUES[[...device].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % HUES.length]!;
  ctx.fillStyle = `hsl(${hue} 30% 97%)`;
  ctx.fillRect(0, 0, 270, 585);
  ctx.fillStyle = `hsl(${hue} 70% 45%)`;
  ctx.fillRect(0, 0, 270, 110);
  ctx.fillStyle = "#fff";
  ctx.font = "600 13px system-ui";
  ctx.fillText(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), 20, 26);
  ctx.font = "700 22px system-ui";
  ctx.fillText("Acme Shop", 20, 82);
  for (let i = 0; i < 6; i += 1) {
    const y = 130 + i * 70;
    ctx.fillStyle = "#fff";
    ctx.fillRect(14, y, 242, 58);
    ctx.fillStyle = `hsl(${(hue + i * 25) % 360} 60% 70%)`;
    ctx.fillRect(24, y + 9, 40, 40);
    ctx.fillStyle = "#333";
    ctx.font = "600 12px system-ui";
    ctx.fillText(`Product ${i + 1}`, 76, y + 25);
    ctx.fillStyle = "#888";
    ctx.font = "11px system-ui";
    ctx.fillText(`$${(19 + i * 7).toFixed(2)}`, 76, y + 42);
  }
  const tick = Math.floor(Date.now() / 1000) % 10;
  ctx.fillStyle = `hsl(${hue} 70% 45%)`;
  ctx.fillRect(20, 548, 23 * (tick + 1), 6);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"));
}

const thumbnailDeps: ThumbnailDeps = {
  ...defaultThumbnailDeps(),
  fetch: async (url) => {
    await new Promise((resolve) => setTimeout(resolve, 120 + Math.random() * 200));
    const device = new URL(url.replace(/^harness:/, "http://h")).searchParams.get("device") ?? "";
    if (device === "emulator-5620") return { ok: false, status: 502, blob: async () => new Blob() };
    return { ok: true, status: 200, blob: async () => drawScreen(device) };
  }
};

useAppStore.setState({
  api,
  sessions: fleet.sessions as never,
  registry: { ...useAppStore.getState().registry, agents: fleet.agents as never },
  plugins: [{ id: "devices", name: "Device simulators", scope: "global", enabled: true, enabledWorkspaces: [] } as never],
  devicesFleetOpen: true
});
void loadDevices(api).catch(() => undefined);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-100">
      <header className="flex h-11 shrink-0 items-center border-b border-neutral-800 bg-neutral-900/60 pl-2">
        <DevicesFleetHeader />
      </header>
      <DevicesFleetView thumbnailDeps={thumbnailDeps} />
    </div>
  </React.StrictMode>
);
