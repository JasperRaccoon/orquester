import type { ProjectSummary } from "@orquester/api";

/**
 * A scaffold/clone flow that got PAST the create step and then failed (no shell
 * on the server, the session create was refused, the command could not be
 * delivered). The distinction matters to the caller: the project directory
 * exists and is already open, so the honest message is "created, but its setup
 * command didn't start" — not "could not create the project", and never a retry
 * that would try to create the same directory again.
 */
export class ProjectSetupError extends Error {
  constructor(
    message: string,
    /** The project that WAS created (and opened) before the failure. */
    public readonly project: ProjectSummary
  ) {
    super(message);
    this.name = "ProjectSetupError";
  }
}
