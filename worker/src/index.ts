import type { Env } from "./env";
import { HttpError, json, notFound } from "./http";
import { handleOps } from "./ops";
import { VERSION } from "./version";

// The entry module exports only the handler: workerd rejects any other export.

async function route(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/health" && request.method === "GET") return json({ status: "ok", version: VERSION });
  if (path.startsWith("/ops/")) return handleOps(request, env, path);
  throw notFound();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) return error.response();
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
