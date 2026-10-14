// Scheduled tasks — `/api/scheduled-tasks` (contract: `@orquester/api` `scheduled-tasks.ts`). Both
// transports, like the saved-prompt routes: the bearer hook gates remote HTTP, and nothing here
// returns a secret. Refusals are `ScheduledTaskError`'s own status with a flat `{ code, message }`.

import type { FastifyInstance, FastifyReply } from "fastify";
import {
  scheduledTaskRoutes,
  type CreateScheduledTaskRequest,
  type RunScheduledTaskResponse,
  type ScheduledTask,
  type ScheduledTaskListResponse,
  type UpdateScheduledTaskRequest
} from "@orquester/api";
import { ScheduledTaskError, type ScheduledTasksService } from "./service.ts";

export interface ScheduledTaskRouteDeps {
  /** Null while the daemon has none (a test server): every route answers 503. */
  service(): ScheduledTasksService | null;
}

const ITEM = `${scheduledTaskRoutes.list}/:id`;

function fail(reply: FastifyReply, error: unknown): void {
  if (error instanceof ScheduledTaskError) {
    void reply.code(error.status).send({ code: error.code, message: error.message });
    return;
  }
  console.error("[scheduled-tasks] route failed", error);
  void reply.code(500).send({ code: "INTERNAL", message: "The scheduled-task operation failed." });
}

function unavailable(reply: FastifyReply): void {
  void reply.code(503).send({ code: "SCHEDULER_UNAVAILABLE", message: "Scheduled tasks are unavailable." });
}

export function registerScheduledTaskRoutes(app: FastifyInstance, deps: ScheduledTaskRouteDeps): void {
  app.get<{ Querystring: { threadId?: string; projectPath?: string } }>(
    scheduledTaskRoutes.list,
    async (request, reply): Promise<ScheduledTaskListResponse | void> => {
      const service = deps.service();
      if (!service) return unavailable(reply);
      const { threadId, projectPath } = request.query;
      return {
        tasks: service.list({
          ...(typeof threadId === "string" && threadId.length > 0 ? { threadId } : {}),
          ...(typeof projectPath === "string" ? { projectPath } : {})
        })
      };
    }
  );

  app.get<{ Params: { id: string } }>(ITEM, async (request, reply): Promise<ScheduledTask | void> => {
    const service = deps.service();
    if (!service) return unavailable(reply);
    const task = service.get(request.params.id);
    if (!task) {
      return fail(reply, new ScheduledTaskError(404, "SCHEDULED_TASK_NOT_FOUND", `No scheduled task with id "${request.params.id}".`));
    }
    return task;
  });

  app.post<{ Body: CreateScheduledTaskRequest }>(scheduledTaskRoutes.list, async (request, reply): Promise<ScheduledTask | void> => {
    const service = deps.service();
    if (!service) return unavailable(reply);
    try {
      return reply.code(201).send(await service.create(request.body));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.put<{ Params: { id: string }; Body: UpdateScheduledTaskRequest }>(ITEM, async (request, reply): Promise<ScheduledTask | void> => {
    const service = deps.service();
    if (!service) return unavailable(reply);
    try {
      return await service.update(request.params.id, request.body ?? {});
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>(ITEM, async (request, reply): Promise<void> => {
    const service = deps.service();
    if (!service) return unavailable(reply);
    try {
      await service.delete(request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>(`${ITEM}/run`, async (request, reply): Promise<RunScheduledTaskResponse | void> => {
    const service = deps.service();
    if (!service) return unavailable(reply);
    try {
      return await service.runNow(request.params.id);
    } catch (error) {
      return fail(reply, error);
    }
  });
}
