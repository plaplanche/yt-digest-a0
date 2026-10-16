import type { ErrorResponse } from "./contracts/error";

/** A response with a JSON body and `Content-Type: application/json`. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** An error answered with the body of contracts/error.schema.json. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }

  response(): Response {
    const body: ErrorResponse = { error: { code: this.code, message: this.message } };
    return json(body, this.status);
  }
}

export function notFound(): HttpError {
  return new HttpError(404, "not_found", "no such route");
}

/**
 * Reads a JSON request body and checks it with `parse` (a generated `parse<Title>`),
 * throwing 400 `invalid_request` when it is not JSON or breaks the schema.
 */
export async function readBody<T>(request: Request, parse: (value: unknown) => T): Promise<T> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new HttpError(400, "invalid_request", "the body is not JSON");
  }
  try {
    return parse(value);
  } catch (error) {
    throw new HttpError(400, "invalid_request", error instanceof Error ? error.message : "invalid body");
  }
}

/** The token of an `Authorization: Bearer <token>` header, or null. */
export function bearer(request: Request): string | null {
  const match = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "");
  return match ? match[1] : null;
}

/** Compares two secrets in constant time (their SHA-256 digests have the same length). */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(hashA, hashB);
}
