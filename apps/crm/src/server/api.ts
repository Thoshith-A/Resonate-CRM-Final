import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { errorEnvelope } from "@resonate/shared";

/**
 * Thin-route helpers. Route handlers stay declarative: validate the body,
 * call a `src/server` function, and map the result/errors to the shared
 * `{ error: { code, message } }` envelope. No business logic lives here.
 */

/** A domain error that carries an HTTP status + stable code for the envelope. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function notFound(message: string): ApiError {
  return new ApiError(404, "not_found", message);
}

export function badRequest(message: string): ApiError {
  return new ApiError(400, "bad_request", message);
}

export function fail(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json(errorEnvelope(error.code, error.message), {
      status: error.status,
    });
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      errorEnvelope("validation_error", error.issues.map(formatIssue).join("; ")),
      { status: 422 },
    );
  }
  console.error("unhandled api error", error);
  return NextResponse.json(
    errorEnvelope("internal_error", "Something went wrong."),
    { status: 500 },
  );
}

function formatIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.map(String).join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** Parse a request body with a zod schema, throwing a ZodError on mismatch. */
export async function parseJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw badRequest("Request body must be valid JSON.");
  }
  return schema.parse(raw);
}
