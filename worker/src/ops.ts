import type { Env } from "./env";
import { bearer, HttpError, json, notFound, secretsEqual } from "./http";
import { log } from "./log";

/** Every table of spec/lot-2.md section 6.3. */
export const TABLES = [
  "nodes",
  "jobs",
  "leases",
  "node_events",
  "invites",
  "users",
  "oauth_clients",
  "oauth_requests",
  "oauth_codes",
  "oauth_tokens",
] as const;

/** The operator endpoints (section 7): authentication first, then the route. */
export async function handleOps(request: Request, env: Env, path: string): Promise<Response> {
  const token = env.OPS_TOKEN ?? "";
  if (token === "") throw notFound();
  const given = bearer(request);
  if (given === null || !(await secretsEqual(given, token))) {
    log("auth.bearer.rejected", {
      level: "warn",
      attrs: { surface: "ops", reason: given === null ? "missing" : "unknown" },
    });
    throw new HttpError(401, "unauthorized", "a valid operator bearer is required");
  }
  if (request.method === "POST" && path === "/ops/reset") return reset(env);
  throw notFound();
}

async function reset(env: Env): Promise<Response> {
  await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  let cursor: string | undefined;
  do {
    const page = await env.TRANSCRIPTS.list({ prefix: "transcripts/", cursor });
    if (page.objects.length > 0) await env.TRANSCRIPTS.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return json({ ok: true });
}
