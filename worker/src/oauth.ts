import { encryptSecret, randomBase64url, sha256Hex } from "./crypto";
import { authCodeTtlSeconds, authRequestTtlSeconds, baseUrl, type Env } from "./env";
import { discover, exchangeCode, type GoogleLogin } from "./google";
import { escapeHtml, htmlError, htmlPage } from "./html";
import { json, notFound } from "./http";
import { log } from "./log";

// The first half of the OAuth flow for MCP clients (spec/lot-2.md sections 10.1 to 10.4): discovery,
// registration, the consent page and the Google callback.

const SCOPE = "digest";
const GOOGLE_SCOPE = "openid email https://www.googleapis.com/auth/youtube.readonly";

/** The OAuth routes; null when the path is not one of them. */
export async function handleOAuth(request: Request, env: Env, path: string): Promise<Response | null> {
  const get = request.method === "GET";
  if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
    if (!get) throw notFound();
    return protectedResource(env);
  }
  if (path === "/.well-known/oauth-authorization-server") {
    if (!get) throw notFound();
    return authorizationServer(env);
  }
  if (path === "/register") {
    if (request.method !== "POST") throw notFound();
    return register(request, env);
  }
  if (path === "/authorize") {
    if (!get) throw notFound();
    return authorize(request, env);
  }
  if (path === "/authorize/consent") {
    if (request.method !== "POST") throw notFound();
    return consent(request, env);
  }
  if (path === "/callback") {
    if (!get) throw notFound();
    return callback(request, env);
  }
  return null;
}

function oauthError(status: number, error: string, description: string): Response {
  return json({ error, error_description: description }, status);
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

/** A redirect to a client's `redirect_uri` with these parameters and, when the client sent one, its `state`. */
function redirectToClient(redirectUri: string, params: Record<string, string>, state: string | null): Response {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  if (state !== null) url.searchParams.set("state", state);
  return redirect(url.href);
}

// 10.1 Discovery

function protectedResource(env: Env): Response {
  const base = baseUrl(env);
  return json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
  });
}

function authorizationServer(env: Env): Response {
  const base = baseUrl(env);
  return json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
  });
}

// 10.2 Dynamic client registration

/** An absolute `https://` URL, or an `http://` URL on `127.0.0.1` or `localhost`, without a fragment. */
function validRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("#") || !URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.protocol === "https:") return url.hostname !== "";
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
}

/** True when `value` is an array whose every element is one of `allowed`. */
function subsetOf(value: unknown, allowed: string[]): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && allowed.includes(item));
}

async function register(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return oauthError(400, "invalid_client_metadata", "the body is not JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return oauthError(400, "invalid_client_metadata", "the body is not a JSON object");
  }
  const metadata = body as Record<string, unknown>;
  const uris = metadata.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 10 || !uris.every(validRedirectUri)) {
    return oauthError(400, "invalid_redirect_uri", "redirect_uris must hold 1 to 10 valid redirect URIs");
  }
  const name = metadata.client_name;
  if (name !== undefined && (typeof name !== "string" || [...name].length > 200)) {
    return oauthError(400, "invalid_client_metadata", "client_name must be a string of up to 200 characters");
  }
  if (metadata.token_endpoint_auth_method !== undefined && metadata.token_endpoint_auth_method !== "none") {
    return oauthError(400, "invalid_client_metadata", "token_endpoint_auth_method must be none");
  }
  if (metadata.grant_types !== undefined && !subsetOf(metadata.grant_types, ["authorization_code", "refresh_token"])) {
    return oauthError(400, "invalid_client_metadata", "grant_types must be a subset of authorization_code, refresh_token");
  }
  if (metadata.response_types !== undefined && !subsetOf(metadata.response_types, ["code"])) {
    return oauthError(400, "invalid_client_metadata", "response_types must be code");
  }
  const clientId = randomBase64url(24);
  const now = new Date();
  await env.DB.prepare(
    "INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(clientId, name ?? null, JSON.stringify(uris), now.toISOString())
    .run();
  log("auth.client.registered", { attrs: { client_id: clientId } });
  return json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(now.getTime() / 1000),
      ...(name === undefined ? {} : { client_name: name }),
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201,
  );
}

// 10.3 GET /authorize and the consent page

interface Client {
  client_id: string;
  client_name: string | null;
  redirect_uris: string;
}

async function authorize(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  const client =
    clientId === null
      ? null
      : await env.DB.prepare("SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?1")
          .bind(clientId)
          .first<Client>();
  if (client === null) return htmlError("Unknown client.");
  if (redirectUri === null || !(JSON.parse(client.redirect_uris) as string[]).includes(redirectUri)) {
    return htmlError("The redirect URI is not registered for this client.");
  }

  const state = params.get("state");
  const fail = (error: string): Response => redirectToClient(redirectUri, { error }, state);
  if (params.get("response_type") !== "code") return fail("unsupported_response_type");
  const codeChallenge = params.get("code_challenge");
  if (codeChallenge === null || codeChallenge === "" || params.get("code_challenge_method") !== "S256") {
    return fail("invalid_request");
  }
  const resource = params.get("resource");
  if (resource !== `${baseUrl(env)}/mcp`) return fail("invalid_target");
  const scope = params.get("scope") ?? SCOPE;
  if (scope !== SCOPE) return fail("invalid_scope");

  const requestId = randomBase64url(32);
  const expiresAt = new Date(Date.now() + authRequestTtlSeconds(env) * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO oauth_requests
       (request_id, client_id, redirect_uri, client_state, code_challenge, scope, resource, google_state, google_nonce, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      requestId,
      client.client_id,
      redirectUri,
      state,
      codeChallenge,
      scope,
      resource,
      randomBase64url(32),
      randomBase64url(32),
      expiresAt,
    )
    .run();
  return htmlPage(
    200,
    "Authorize access",
    `<h1>Authorize access to yt-digest</h1>
<p>The application <strong>${escapeHtml(client.client_name ?? client.client_id)}</strong> asks for access to your digest.</p>
<p>Redirect URI: <code>${escapeHtml(redirectUri)}</code></p>
<p>Scope: <code>${escapeHtml(scope)}</code></p>
<form method="post" action="/authorize/consent">
<input type="hidden" name="request" value="${escapeHtml(requestId)}">
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>`,
  );
}

interface PendingAuthorization {
  request_id: string;
  client_id: string;
  redirect_uri: string;
  client_state: string | null;
  code_challenge: string;
  scope: string;
  resource: string;
  google_state: string;
  google_nonce: string;
}

async function consent(request: Request, env: Env): Promise<Response> {
  const form = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
  const requestId = form.get("request") ?? "";
  const decision = form.get("decision");
  const now = new Date().toISOString();
  if (decision === "deny") {
    const pending = await env.DB.prepare(
      `UPDATE oauth_requests SET used_at = ?2
       WHERE request_id = ?1 AND used_at IS NULL AND expires_at > ?2 RETURNING *`,
    )
      .bind(requestId, now)
      .first<PendingAuthorization>();
    if (pending === null) return htmlError("This authorization request is unknown, expired or already used.");
    log("auth.oauth.denied", { attrs: { client_id: pending.client_id, reason: "access_denied" } });
    return redirectToClient(pending.redirect_uri, { error: "access_denied" }, pending.client_state);
  }
  const pending = await env.DB.prepare(
    "SELECT * FROM oauth_requests WHERE request_id = ?1 AND used_at IS NULL AND expires_at > ?2",
  )
    .bind(requestId, now)
    .first<PendingAuthorization>();
  if (pending === null) return htmlError("This authorization request is unknown, expired or already used.");
  if (decision !== "approve") return htmlError("The decision must be approve or deny.");
  const { authorization_endpoint } = await discover(env);
  const url = new URL(authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${baseUrl(env)}/callback`,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    state: pending.google_state,
    nonce: pending.google_nonce,
    access_type: "offline",
    prompt: "consent",
  }).toString();
  return redirect(url.href);
}

// 10.4 GET /callback and access control

/** The role of an e-mail under access control (section 10.4 step 4), or null when it is not admitted. */
async function admittedRole(env: Env, email: string): Promise<"admin" | "member" | null> {
  if (email === env.ADMIN_EMAIL.toLowerCase()) return "admin";
  const invite = await env.DB.prepare("SELECT 1 FROM invites WHERE email = ?1 AND revoked = 0").bind(email).first();
  return invite === null ? null : "member";
}

function refusalPage(): Response {
  return htmlPage(403, "Access refused", "<h1>Access refused</h1>\n<p>This account is not invited.</p>");
}

async function callback(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const pending = await env.DB.prepare(
    `UPDATE oauth_requests SET used_at = ?2
     WHERE google_state = ?1 AND used_at IS NULL AND expires_at > ?2 RETURNING *`,
  )
    .bind(params.get("state") ?? "", new Date().toISOString())
    .first<PendingAuthorization>();
  if (pending === null) return htmlError("This sign-in is unknown, expired or already used.");
  const deny = (error: string, reason: string): Response => {
    log("auth.oauth.denied", { level: "warn", attrs: { client_id: pending.client_id, reason } });
    return redirectToClient(pending.redirect_uri, { error }, pending.client_state);
  };
  if (params.has("error")) return deny("access_denied", "google_error");

  let login: GoogleLogin;
  try {
    login = await exchangeCode(env, params.get("code") ?? "", `${baseUrl(env)}/callback`, pending.google_nonce);
  } catch {
    return deny("server_error", "google_error");
  }

  const email = login.claims.email.toLowerCase();
  const role = login.claims.emailVerified ? await admittedRole(env, email) : null;
  if (role === null) {
    const reason = login.claims.emailVerified ? "not_invited" : "email_unverified";
    log("auth.oauth.denied", { level: "warn", attrs: { client_id: pending.client_id, reason } });
    return refusalPage();
  }

  const now = new Date();
  const refreshTokenEnc = login.refreshToken === null ? null : await encryptSecret(login.refreshToken, env.TOKEN_ENC_KEY);
  const code = randomBase64url(32);
  const codeExpiresAt = new Date(now.getTime() + authCodeTtlSeconds(env) * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (user_sub, email, role, google_refresh_token_enc, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (user_sub) DO UPDATE SET email = excluded.email, role = excluded.role,
         google_refresh_token_enc = COALESCE(excluded.google_refresh_token_enc, users.google_refresh_token_enc)`,
    ).bind(login.claims.sub, email, role, refreshTokenEnc, now.toISOString()),
    env.DB.prepare("UPDATE invites SET accepted_user_sub = ?2 WHERE email = ?1").bind(email, login.claims.sub),
    env.DB.prepare(
      `INSERT INTO oauth_codes (code_hash, client_id, user_sub, redirect_uri, code_challenge, scope, resource, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(
      await sha256Hex(code),
      pending.client_id,
      login.claims.sub,
      pending.redirect_uri,
      pending.code_challenge,
      pending.scope,
      pending.resource,
      codeExpiresAt,
    ),
  ]);
  log("auth.oauth.completed", { attrs: { client_id: pending.client_id, role } });
  return redirectToClient(pending.redirect_uri, { code }, pending.client_state);
}
