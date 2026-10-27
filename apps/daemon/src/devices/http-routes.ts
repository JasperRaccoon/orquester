/**
 * The devices HTTP routes (`deviceRoutes`, devices spec §8, §10): state, hosts, leases, the
 * controller, the action log, kept screenshots, settings and setup jobs, and (phase 2) host
 * drain, cache warms, the pool summary and lease thumbnails, on both transports (the
 * bearer hook gates remote HTTP like every other route), and the hub proxy on the remote transport
 * only (streams need HTTP; the desktop app's unix socket lists and drives leases without video).
 *
 * While the plugin is off there is no service: `GET /api/devices` answers `enabled: false` with
 * the default settings, everything else 409 `DEVICES_DISABLED`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  DEFAULT_DEVICES_SETTINGS,
  DEVICE_ERROR_CODES,
  DEVICE_HUB_ROUTE_PATTERN,
  DEVICE_PROFILES,
  DEVICE_SCREENSHOT_ROUTE_PATTERN,
  deviceRoutes,
  isDevicePlatform,
  DEVICE_THUMBNAIL_ROUTE_PATTERN,
  DEVICE_THUMBNAIL_WIDTH,
  parseDeviceCacheWarmRequest,
  parseDeviceControllerRequest,
  parseDeviceHostDrainRequest,
  parseDeviceOpenRequest,
  parseDeviceSetupRequest,
  parseDevicesSettingsPatch,
  parseDeviceUserActionRequest,
  type DeviceActionsResponse,
  type DeviceCacheWarmResponse,
  type DeviceHostResponse,
  type DeviceHostsResponse,
  type DevicePoolResponse,
  type DeviceLeaseResponse,
  type DeviceLeasesResponse,
  type DevicesListResponse,
  type DevicesSettingsResponse,
  type DevicesStateResponse,
  type DeviceSetupResponse,
  type DeviceUserActionResponse
} from "@orquester/api";

import { DeviceError, devicesDisabled, isDeviceError } from "./errors.ts";
import type { HubProxy } from "./hub-proxy.ts";
import type { DeviceService } from "./service.ts";

interface DeviceHttpRoutesDeps {
  /** The running service, or null while the plugin is off (read per request). */
  devices(): DeviceService | null;
  hubProxy(): HubProxy;
  logger?: Pick<Console, "error">;
}

type Params<T extends string> = { Params: Record<T, string> };

function sendError(reply: FastifyReply, error: unknown, logger: Pick<Console, "error">): FastifyReply {
  if (isDeviceError(error)) return reply.code(error.status).send({ code: error.code, message: error.message });
  logger.error("[devices] a route failed", error instanceof Error ? error.message : String(error));
  return reply.code(500).send({ code: "INTERNAL", message: "The device operation failed." });
}

/** The query string without `token` (the bearer never reaches a hub), with its `?`, or "". */
export function hubSearch(url: string): string {
  const at = url.indexOf("?");
  if (at === -1) return "";
  const params = new URLSearchParams(url.slice(at + 1));
  params.delete("token");
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

export function registerDeviceHttpRoutes(app: FastifyInstance, deps: DeviceHttpRoutesDeps, mode: "local" | "remote"): void {
  const logger = deps.logger ?? console;
  /** Run `handle` with the service, answering the plugin's refusal while it is off and any `DeviceError`. */
  const withService =
    <R extends FastifyRequest>(handle: (service: DeviceService, request: R, reply: FastifyReply) => unknown) =>
    async (request: R, reply: FastifyReply): Promise<unknown> => {
      const service = deps.devices();
      if (!service) return sendError(reply, devicesDisabled(), logger);
      try {
        return await handle(service, request, reply);
      } catch (error) {
        return sendError(reply, error, logger);
      }
    };

  app.get(deviceRoutes.state, async (): Promise<DevicesStateResponse> => {
    const service = deps.devices();
    if (service) return service.snapshot();
    return { enabled: false, hosts: [], leases: [], profiles: [...DEVICE_PROFILES], settings: structuredClone(DEFAULT_DEVICES_SETTINGS), setupJobs: [] };
  });

  app.get(deviceRoutes.hosts, withService((service): DeviceHostsResponse => ({ hosts: service.hostSummaries() })));

  app.get<Params<"hostId">>(
    `${deviceRoutes.hosts}/:hostId`,
    withService((service, request: FastifyRequest<Params<"hostId">>) => {
      const host = service.hostSummaries().find((entry) => entry.id === request.params.hostId);
      if (!host) throw new DeviceError(DEVICE_ERROR_CODES.HOST_NOT_FOUND, `There is no device host ${request.params.hostId}.`);
      return { host };
    })
  );

  app.delete<Params<"hostId">>(
    `${deviceRoutes.hosts}/:hostId`,
    withService(async (service, request: FastifyRequest<Params<"hostId">>, reply) => {
      await service.destroyHost(request.params.hostId);
      return reply.code(204).send();
    })
  );

  // Phase 2: the fleet view's Drain / Undrain, "Warm caches", and the pool summary.
  app.put<Params<"hostId">>(
    `${deviceRoutes.hosts}/:hostId/drain`,
    withService((service, request: FastifyRequest<Params<"hostId">>): DeviceHostResponse => {
      const parsed = parseDeviceHostDrainRequest(request.body);
      if (!parsed.ok) throw new DeviceError("INVALID_ARGUMENT", parsed.message);
      return { host: service.setHostDraining(request.params.hostId, parsed.value.draining) };
    })
  );

  app.post(
    deviceRoutes.cacheWarm,
    withService(async (service, request): Promise<DeviceCacheWarmResponse> => {
      const parsed = parseDeviceCacheWarmRequest(request.body);
      if (!parsed.ok) throw new DeviceError("INVALID_ARGUMENT", parsed.message);
      return service.warmCaches(parsed.value.platform);
    })
  );

  app.get(deviceRoutes.pool, withService((service): DevicePoolResponse => ({ pool: service.poolSummary() })));

  app.get(deviceRoutes.devices, withService(async (service): Promise<DevicesListResponse> => ({ devices: await service.listDevices() })));

  app.get<{ Querystring: { threadId?: string } }>(
    deviceRoutes.leases,
    withService((service, request: FastifyRequest<{ Querystring: { threadId?: string } }>): DeviceLeasesResponse => {
      const threadId = typeof request.query.threadId === "string" && request.query.threadId !== "" ? request.query.threadId : undefined;
      return { leases: service.leaseSummaries(threadId !== undefined ? { threadId } : {}) };
    })
  );

  // The panel's picker: answers with the lease `starting` — placed, or still waiting for a host
  // (`hostId: "pool"`, never blocking on the pool's queue); the wait, the boot and their outcome
  // arrive as `devices.lease` / `devices.lease.closed` events.
  app.post(
    deviceRoutes.leases,
    withService(async (service, request, reply) => {
      const parsed = parseDeviceOpenRequest(request.body);
      if (!parsed.ok) throw new DeviceError("INVALID_ARGUMENT", parsed.message);
      const lease = await service.openQueued({ ...parsed.value, openedBy: "user", rentalApproved: true });
      return reply.code(201).send({ lease } satisfies DeviceLeaseResponse);
    })
  );

  app.get<Params<"leaseId">>(
    `${deviceRoutes.leases}/:leaseId`,
    withService((service, request: FastifyRequest<Params<"leaseId">>): DeviceLeaseResponse => {
      const lease = service.lease(request.params.leaseId);
      if (!lease) throw new DeviceError(DEVICE_ERROR_CODES.DEVICE_NOT_LEASED, "There is no such lease.");
      return { lease };
    })
  );

  app.delete<Params<"leaseId"> & { Querystring: { shutdown?: string } }>(
    `${deviceRoutes.leases}/:leaseId`,
    withService(async (service, request: FastifyRequest<Params<"leaseId"> & { Querystring: { shutdown?: string } }>, reply) => {
      const released = await service.releaseLease(request.params.leaseId, "user", { shutdown: request.query.shutdown === "1" || request.query.shutdown === "true" });
      if (!released) throw new DeviceError(DEVICE_ERROR_CODES.DEVICE_NOT_LEASED, "There is no such lease.");
      return reply.send({ lease: released } satisfies DeviceLeaseResponse);
    })
  );

  app.put<Params<"leaseId">>(
    `${deviceRoutes.leases}/:leaseId/controller`,
    withService((service, request: FastifyRequest<Params<"leaseId">>): DeviceLeaseResponse => {
      const parsed = parseDeviceControllerRequest(request.body);
      if (!parsed.ok) throw new DeviceError("INVALID_ARGUMENT", parsed.message);
      return { lease: service.setController(request.params.leaseId, parsed.value.controller) };
    })
  );

  // The panel's buttons that are not hub input: the user's own (an agent's or external client's
  // principal is refused — agents drive devices through their tools, under the controller rules).
  app.post<Params<"leaseId">>(
    `${deviceRoutes.leases}/:leaseId/user-action`,
    withService(async (service, request: FastifyRequest<Params<"leaseId">>, reply): Promise<DeviceUserActionResponse> => {
      const principal = (request as FastifyRequest & { principal?: { kind: string } | null }).principal;
      if (principal && principal.kind !== "user") throw new DeviceError("PERMISSION_DENIED", "Only a person uses the Device panel's buttons; agents use device_action.");
      const parsed = parseDeviceUserActionRequest(request.body);
      if (!parsed.ok) throw new DeviceError("INVALID_ARGUMENT", parsed.message);
      const abort = new AbortController();
      // The panel went away before the answer: stop what is still running on the device's behalf.
      reply.raw.once("close", () => {
        if (!reply.raw.writableFinished) abort.abort();
      });
      return service.userAction(request.params.leaseId, parsed.value, abort.signal);
    })
  );

  app.get<Params<"leaseId">>(
    `${deviceRoutes.leases}/:leaseId/actions`,
    withService((service, request: FastifyRequest<Params<"leaseId">>): DeviceActionsResponse => {
      if (!service.lease(request.params.leaseId)) throw new DeviceError(DEVICE_ERROR_CODES.DEVICE_NOT_LEASED, "There is no such lease.");
      return { leaseId: request.params.leaseId, actions: service.actions(request.params.leaseId) };
    })
  );

  // A kept screenshot outlives its lease (a chat row's thumbnail), until the chat closes.
  app.get<Params<"leaseId" | "screenshotId">>(
    DEVICE_SCREENSHOT_ROUTE_PATTERN,
    withService(async (service, request: FastifyRequest<Params<"leaseId" | "screenshotId">>, reply) => {
      const shot = await service.screenshot(request.params.leaseId, request.params.screenshotId);
      if (!shot) throw new DeviceError(DEVICE_ERROR_CODES.DEVICE_NOT_FOUND, "There is no such screenshot.");
      return reply.header("content-type", shot.mimeType).header("cache-control", "private, max-age=86400, immutable").send(shot.data);
    })
  );

  // The fleet view's card image (`?token=` accepted on GET: `deviceQueryTokenAllowed`).
  app.get<Params<"leaseId"> & { Querystring: { w?: string } }>(
    DEVICE_THUMBNAIL_ROUTE_PATTERN,
    withService(async (service, request: FastifyRequest<Params<"leaseId"> & { Querystring: { w?: string } }>, reply) => {
      const raw = request.query.w;
      const asked = raw === undefined || raw === "" ? DEVICE_THUMBNAIL_WIDTH.default : Number(raw);
      if (!Number.isInteger(asked) || asked < DEVICE_THUMBNAIL_WIDTH.min || asked > DEVICE_THUMBNAIL_WIDTH.max) {
        throw new DeviceError("INVALID_ARGUMENT", `\`w\` must be a whole number from ${DEVICE_THUMBNAIL_WIDTH.min} to ${DEVICE_THUMBNAIL_WIDTH.max}.`);
      }
      const jpeg = await service.thumbnail(request.params.leaseId, asked);
      return reply.header("content-type", "image/jpeg").header("cache-control", "no-store").send(jpeg);
    })
  );

  app.get(deviceRoutes.settings, withService((service): DevicesSettingsResponse => ({ settings: service.settings() })));

  app.put(
    deviceRoutes.settings,
    withService(async (service, request): Promise<DevicesSettingsResponse> => {
      const parsed = parseDevicesSettingsPatch(request.body);
      if (!parsed.ok) throw new DeviceError("INVALID_ARGUMENT", parsed.message);
      try {
        return { settings: await service.updateSettings(parsed.value) };
      } catch (error) {
        if (isDeviceError(error)) throw error;
        throw new DeviceError("UNAVAILABLE", error instanceof Error ? error.message : "The settings could not be saved.");
      }
    })
  );

  app.get<Params<"platform">>(
    "/api/devices/setup/:platform",
    withService((service, request: FastifyRequest<Params<"platform">>): DeviceSetupResponse => {
      const { platform } = request.params;
      if (!isDevicePlatform(platform)) throw new DeviceError("INVALID_ARGUMENT", "`platform` must be ios or android.");
      return { job: service.setupJob(platform) };
    })
  );

  app.post<Params<"platform">>(
    "/api/devices/setup/:platform",
    withService((service, request: FastifyRequest<Params<"platform">>, reply) => {
      const { platform } = request.params;
      if (!isDevicePlatform(platform)) throw new DeviceError("INVALID_ARGUMENT", "`platform` must be ios or android.");
      const parsed = parseDeviceSetupRequest(request.body);
      if (!parsed.ok) throw new DeviceError("INVALID_ARGUMENT", parsed.message);
      return reply.code(202).send({ job: service.startSetup(platform, parsed.value.actions) } satisfies DeviceSetupResponse);
    })
  );

  if (mode !== "remote") return;

  // The hub proxy (spec §8): the bearer hook already authenticated the request (the
  // `Authorization` header only: no `?token=` here, `deviceQueryTokenAllowed`); viewing a
  // host's hub needs a live lease on it. Its own scope hands every body through raw, so the proxy
  // can stream it upstream; the proxy owns the allowlists and header rewriting.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_request, payload, done) => done(null, payload));
    scope.all<Params<"hostId" | "*">>(
      DEVICE_HUB_ROUTE_PATTERN,
      withService(async (service, request: FastifyRequest<Params<"hostId" | "*">>, reply) => {
        const { hostId } = request.params;
        if (!service.hosts.get(hostId)) throw new DeviceError(DEVICE_ERROR_CODES.HOST_NOT_FOUND, `There is no device host ${hostId}.`);
        if (!service.hostHasLease(hostId)) throw new DeviceError(DEVICE_ERROR_CODES.DEVICE_NOT_LEASED, "No device on this host is leased.");
        const origin = service.hubOrigin(hostId);
        if (!origin) throw new DeviceError("UNAVAILABLE", "The device hub is not running.");
        await deps.hubProxy().handleHttp(request, reply, { hostId, origin, hubPath: `/${request.params["*"] ?? ""}`, search: hubSearch(request.url), token: service.hubToken(hostId) });
        return reply;
      })
    );
  });
}
