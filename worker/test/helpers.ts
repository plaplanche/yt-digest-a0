import { env } from "cloudflare:test";
import { expect, vi } from "vitest";
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

export const OPS = { Authorization: `Bearer ${env.OPS_TOKEN ?? ""}` };

export function captureLogs(): () => Record<string, unknown>[] {
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return () => spy.mock.calls.map((args) => JSON.parse(String(args[0])) as Record<string, unknown>);
}

/** `count` distinct valid video ids, `prefix` padded to 11 characters. */
export function videoIds(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(11 - prefix.length, "0")}`);
}

export async function enroll(nodeId: string): Promise<string> {
  const response = await call("/ops/nodes", {
    method: "POST",
    headers: OPS,
    body: JSON.stringify({ node_id: nodeId, owner_label: `owner of ${nodeId}` }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

export async function enqueue(ids: string[], priority?: number): Promise<{ enqueued: string[]; existing: string[] }> {
  const response = await call("/ops/jobs", {
    method: "POST",
    headers: OPS,
    body: JSON.stringify(priority === undefined ? { video_ids: ids } : { video_ids: ids, priority }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { enqueued: string[]; existing: string[] };
}

export async function job(videoId: string): Promise<Record<string, unknown>> {
  const response = await call(`/ops/jobs/${videoId}`, { headers: OPS });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}
