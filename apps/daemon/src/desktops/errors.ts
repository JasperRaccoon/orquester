/** A refusal the routes answer verbatim: `status` with `{ code, message, hint? }`. */
export class DesktopError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 500 | 503,
    readonly code: string,
    message: string,
    readonly hint: string | null = null
  ) {
    super(message);
    this.name = "DesktopError";
  }
}
