import { env } from "cloudflare:test";
import { expect } from "vitest";
import { parseErrorResponse } from "../src/contracts/error";
import type { Env } from "../src/env";
import worker from "../src/index";

/** Sends a request to the Worker, with `overrides` replacing some of the test bindings. */
export async function call(path: string, init: RequestInit = {}, overrides: Partial<Env> = {}): Promise<Response> {
  return worker.fetch(new Request(`http://worker.test${path}`, init), { ...env, ...overrides });
}

/** Checks that a response is a JSON error of contracts/error.schema.json with this status and code. */
export async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toBe("application/json");
  expect(parseErrorResponse(await response.json()).error.code).toBe(code);
}
