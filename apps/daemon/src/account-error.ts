/**
 * `AccountError` lives in its own module so provider modules
 * (`providers/*.ts`) can throw route-mapped errors without importing
 * `accounts.ts` — which imports them back (an import cycle).
 */

/** Error carrying the HTTP status the route should reply with. */
export class AccountError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "AccountError";
  }
}
