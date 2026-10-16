// The mocks server of spec/lot-2.md section 5.3: SponsorBlock and the Google OpenID Connect provider.
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const port = Number(process.env.MOCKS_PORT ?? "8789");
const clientId = process.env.GOOGLE_CLIENT_ID ?? "yt-digest-local";
const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "local-google-secret";
const issuer = `http://127.0.0.1:${port}/google`;

const TOKEN_TTL_SECONDS = 3600;
const CODE_TTL_MS = 60_000;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = randomBytes(8).toString("hex");
const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };

interface Grant {
  email: string;
  scope: string;
  nonce: string | null;
}

interface PendingCode extends Grant {
  redirectUri: string;
  offline: boolean;
  expiresAt: number;
}

const codes = new Map<string, PendingCode>();
const refreshTokens = new Map<string, Grant>();
const accessTokens = new Map<string, { email: string; expiresAt: number }>();

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, "application/json", JSON.stringify(body));
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Subject rule: `g-` and the first 16 hexadecimal characters of the SHA-256 of the lowercased e-mail. */
function subject(email: string): string {
  return `g-${createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 16)}`;
}

function idToken(grant: Grant): string {
  const iat = Math.floor(Date.now() / 1000);
  const claims = {
    iss: issuer,
    aud: clientId,
    sub: subject(grant.email),
    email: grant.email,
    email_verified: true,
    iat,
    exp: iat + TOKEN_TTL_SECONDS,
    ...(grant.nonce === null ? {} : { nonce: grant.nonce }),
  };
  const encode = (part: unknown): string => Buffer.from(JSON.stringify(part)).toString("base64url");
  const input = `${encode({ alg: "RS256", typ: "JWT", kid })}.${encode(claims)}`;
  const signature = createSign("RSA-SHA256").update(input).sign(privateKey, "base64url");
  return `${input}.${signature}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function authorize(url: URL, res: ServerResponse): void {
  const params = url.searchParams;
  const redirectUri = params.get("redirect_uri");
  const redirect = redirectUri !== null && URL.canParse(redirectUri) ? new URL(redirectUri) : null;
  const scope = params.get("scope") ?? "";
  if (
    params.get("client_id") !== clientId ||
    redirect === null ||
    params.get("response_type") !== "code" ||
    !scope.split(" ").includes("openid")
  ) {
    send(res, 400, "text/plain", "invalid authorization request");
    return;
  }
  const loginHint = params.get("login_hint") ?? "";
  if (loginHint === "") {
    const hidden = [...params]
      .filter(([name]) => name !== "login_hint")
      .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
      .join("\n");
    send(
      res,
      200,
      "text/html; charset=utf-8",
      `<!doctype html>
<html><head><meta charset="utf-8"><title>Sign in - fake Google</title></head>
<body>
<form method="get" action="/google/authorize">
${hidden}
<label>E-mail <input type="text" name="login_hint"></label>
<button type="submit">Sign in</button>
</form>
</body></html>`,
    );
    return;
  }
  const code = randomToken();
  codes.set(code, {
    email: loginHint.toLowerCase(),
    scope,
    nonce: params.get("nonce"),
    redirectUri: redirectUri ?? "",
    offline: params.get("access_type") === "offline",
    expiresAt: Date.now() + CODE_TTL_MS,
  });
  redirect.searchParams.set("code", code);
  const state = params.get("state");
  if (state !== null) redirect.searchParams.set("state", state);
  res.writeHead(302, { Location: redirect.href });
  res.end();
}

/** The client of a token request: HTTP Basic (RFC 6749 2.3.1) or `client_id`/`client_secret` in the body. */
function clientAuthenticated(req: IncomingMessage, form: URLSearchParams): boolean {
  const basic = /^Basic (\S+)$/.exec(req.headers.authorization ?? "");
  let id = form.get("client_id");
  let secret = form.get("client_secret");
  if (basic) {
    const decoded = Buffer.from(basic[1], "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon < 0) return false;
    try {
      id = decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, " "));
      secret = decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, " "));
    } catch {
      return false;
    }
  }
  return id === clientId && secret === clientSecret;
}

function issue(res: ServerResponse, grant: Grant, refreshToken: string | null): void {
  const accessToken = randomToken();
  accessTokens.set(accessToken, { email: grant.email, expiresAt: Date.now() + TOKEN_TTL_SECONDS * 1000 });
  sendJson(res, 200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: TOKEN_TTL_SECONDS,
    scope: grant.scope,
    id_token: idToken(grant),
    ...(refreshToken === null ? {} : { refresh_token: refreshToken }),
  });
}

function token(req: IncomingMessage, body: string, res: ServerResponse): void {
  const form = new URLSearchParams(body);
  if (!clientAuthenticated(req, form)) {
    sendJson(res, 401, { error: "invalid_client" });
    return;
  }
  const grantType = form.get("grant_type");
  if (grantType === "authorization_code") {
    const code = form.get("code") ?? "";
    const pending = codes.get(code);
    codes.delete(code);
    if (pending !== undefined && pending.expiresAt > Date.now() && pending.redirectUri === form.get("redirect_uri")) {
      const grant: Grant = { email: pending.email, scope: pending.scope, nonce: pending.nonce };
      let refreshToken: string | null = null;
      if (pending.offline) {
        refreshToken = randomToken();
        refreshTokens.set(refreshToken, { ...grant, nonce: null });
      }
      issue(res, grant, refreshToken);
      return;
    }
  } else if (grantType === "refresh_token") {
    const grant = refreshTokens.get(form.get("refresh_token") ?? "");
    if (grant !== undefined) {
      issue(res, grant, null);
      return;
    }
  }
  sendJson(res, 400, { error: "invalid_grant" });
}

function userinfo(req: IncomingMessage, res: ServerResponse): void {
  const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
  const access = bearer ? accessTokens.get(bearer[1]) : undefined;
  if (access === undefined || access.expiresAt <= Date.now()) {
    sendJson(res, 401, { error: "invalid_token" });
    return;
  }
  sendJson(res, 200, { sub: subject(access.email), email: access.email, email_verified: true });
}

function discovery(res: ServerResponse): void {
  sendJson(res, 200, {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    jwks_uri: `${issuer}/jwks`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
  });
}

function handle(req: IncomingMessage, res: ServerResponse, body: string): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = `${req.method ?? ""} ${url.pathname}`;
  switch (route) {
    case "GET /health":
      return sendJson(res, 200, { status: "ok" });
    case "GET /google/.well-known/openid-configuration":
      return discovery(res);
    case "GET /google/authorize":
      return authorize(url, res);
    case "POST /google/token":
      return token(req, body, res);
    case "GET /google/userinfo":
      return userinfo(req, res);
    case "GET /google/jwks":
      return sendJson(res, 200, { keys: [jwk] });
    case "POST /google/revoke":
      return send(res, 200, "text/plain", "");
    default:
      // GET /sponsorblock/api/skipSegments too: no sponsor segment for any video.
      return send(res, 404, "text/plain", "Not Found");
  }
}

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => handle(req, res, Buffer.concat(chunks).toString("utf8")));
}).listen(port, "127.0.0.1", () => {
  console.log(`mocks: listening on http://127.0.0.1:${port}`);
});
