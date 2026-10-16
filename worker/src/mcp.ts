import { baseUrl, type Env } from "./env";
import { bearer, HttpError, json, notFound } from "./http";
import { log } from "./log";
import { checkAccessToken } from "./token";
import { VERSION } from "./version";

// The MCP endpoint (spec/lot-2.md section 11): Streamable HTTP without sessions, every answer JSON.

const PROTOCOL_VERSION = "2025-06-18";
const TOOL = "list_subscriptions";

type Id = string | number;

/** `POST /mcp`: the Origin check (11.2), then the access token (11.1), then the JSON-RPC message. */
export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (origin !== null && !allowedOrigins(env).includes(origin)) {
    log("auth.origin.rejected", { level: "warn", attrs: { origin } });
    throw new HttpError(403, "origin_rejected", "this origin may not call /mcp");
  }
  const refusal = await authenticate(request, env);
  if (refusal !== null) return refusal;
  if (request.method !== "POST") throw notFound();
  return answer(await readMessage(request));
}

/** The origin of `BASE` and those of `ALLOWED_ORIGINS` (comma-separated, blanks dropped). */
function allowedOrigins(env: Env): string[] {
  const extra = (env.ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim());
  return [new URL(baseUrl(env)).origin, ...extra.filter((origin) => origin !== "")];
}

/** Null for a valid access token (10.6), else the 401 `invalid_token` answer. */
async function authenticate(request: Request, env: Env): Promise<Response | null> {
  const token = bearer(request);
  const reason = token === null ? "missing" : await checkAccessToken(env, token).then((check) => (check.valid ? null : check.reason));
  if (reason === null) return null;
  log("auth.bearer.rejected", { level: "warn", attrs: { surface: "mcp", reason } });
  const response = json({ error: "invalid_token", error_description: "a valid access token is required" }, 401);
  response.headers.set("WWW-Authenticate", `Bearer resource_metadata="${baseUrl(env)}/.well-known/oauth-protected-resource"`);
  return response;
}

/** A JSON-RPC 2.0 message: a request (with `id`), a notification, or a response from the client. */
interface Message {
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
}

/** The body as one JSON-RPC message; 400 `invalid_request` for anything else (6.1). */
async function readMessage(request: Request): Promise<Message> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new HttpError(400, "invalid_request", "the body is not JSON");
  }
  if (!isObject(value) || value.jsonrpc !== "2.0") throw new HttpError(400, "invalid_request", "not a JSON-RPC 2.0 message");
  const { id, method, params } = value;
  if (id !== undefined && typeof id !== "string" && typeof id !== "number") throw new HttpError(400, "invalid_request", "invalid id");
  if (method !== undefined && typeof method !== "string") throw new HttpError(400, "invalid_request", "invalid method");
  if (params !== undefined && !isObject(params)) throw new HttpError(400, "invalid_request", "invalid params");
  if (method === undefined && (id === undefined || !("result" in value || "error" in value))) {
    throw new HttpError(400, "invalid_request", "not a JSON-RPC 2.0 message");
  }
  return { id, method, params };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A notification or a client's response gets 202 without a body; a request gets its JSON-RPC response. */
function answer(message: Message): Response {
  if (message.id === undefined || message.method === undefined) return new Response(null, { status: 202 });
  const { id, method, params = {} } = message;
  switch (method) {
    case "initialize":
      return result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "yt-digest", version: VERSION },
      });
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, {
        tools: [
          {
            name: TOOL,
            description: "Lists the user's subscriptions.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });
    case "tools/call":
      return callTool(id, params);
    default:
      return error(id, -32601, `method not found: ${method}`);
  }
}

/** `tools/call` (11.3), logged as `mcp.tool.call`. */
function callTool(id: Id, params: Record<string, unknown>): Response {
  const started = Date.now();
  const { name } = params;
  if (typeof name !== "string") return error(id, -32602, "params.name must be a string");
  const known = name === TOOL;
  log("mcp.tool.call", { attrs: { tool: name, outcome: known ? "ok" : "error", duration_ms: Date.now() - started } });
  if (!known) return error(id, -32602, `unknown tool: ${name}`);
  return result(id, { content: [{ type: "text", text: JSON.stringify({ subscriptions: [] }) }], isError: false });
}

function result(id: Id, value: unknown): Response {
  return json({ jsonrpc: "2.0", id, result: value });
}

function error(id: Id, code: number, message: string): Response {
  return json({ jsonrpc: "2.0", id, error: { code, message } });
}
