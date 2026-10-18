import { ZodError } from "zod";

/**
 * The one error type that crosses a boundary. Service code throws AppError
 * for anything a caller should see (validation, state-machine violations,
 * permission problems); the boundary — a server action, REST route, or MCP
 * tool call — turns it into a user-facing message or a structured response.
 *
 * `code` is stable and machine-readable: agents branch on it, so never
 * rename one casually. `status` is the HTTP status the REST API returns.
 * Anything that is NOT an AppError is a bug and surfaces as `internal`.
 */
export type ErrorCode =
  | "invalid_input"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_state"
  | "approval_required"
  | "posting_failed"
  | "idempotency_conflict"
  | "rate_limited"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  invalid_input: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid_state: 409,
  approval_required: 409,
  posting_failed: 422,
  idempotency_conflict: 422,
  rate_limited: 429,
  internal: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function notFound(what: string): AppError {
  return new AppError("not_found", `${what} not found.`);
}

export function invalidState(message: string, details?: Record<string, unknown>): AppError {
  return new AppError("invalid_state", message, details);
}

/** Postgres unique_violation → a friendly conflict; everything else rethrows. */
export function rethrowUnique(err: unknown, message: string): never {
  const code =
    (err as { code?: string }).code ??
    (err as { cause?: { code?: string } }).cause?.code;
  if (code === "23505") throw new AppError("conflict", message);
  throw err;
}

/** Normalize anything thrown at a boundary into an AppError. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
    const first = issues[0];
    return new AppError(
      "invalid_input",
      first
        ? `${first.path ? `${first.path}: ` : ""}${first.message}`
        : "Invalid input.",
      { issues }
    );
  }
  console.error("[internal]", err);
  return new AppError("internal", "Something went wrong. The error has been logged.");
}
