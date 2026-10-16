/** The Worker's bindings (wrangler.toml) and settings (spec/lot-2.md section 5.2). */
export interface Env {
  DB: D1Database;
  TRANSCRIPTS: R2Bucket;
  /** Bearer of the operator endpoints; `/ops/*` does not exist when it is absent or empty. */
  OPS_TOKEN?: string;
  /** Lease duration in seconds (section 8.3); 600 when absent. */
  LEASE_SECONDS?: string;
  /** The Worker's issuer and the base of its URLs (`WORKER_URL`), a trailing slash ignored. */
  PUBLIC_URL: string;
  /** Lifetime of an authorization code in seconds; 60 when absent. */
  AUTH_CODE_TTL_SECONDS?: string;
  /** Lifetime of a pending authorization in seconds; 600 when absent. */
  AUTH_REQUEST_TTL_SECONDS?: string;
  /** The OpenID Connect issuer users log in with, and the Worker's client there. */
  GOOGLE_ISSUER: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** The admin's e-mail (section 10.4). */
  ADMIN_EMAIL: string;
  /** Base64 of the 32-byte AES-GCM key that encrypts Google refresh tokens. */
  TOKEN_ENC_KEY: string;
}

/** A setting as a positive integer, `fallback` when absent, empty or not a positive integer. */
function positiveInteger(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

/** `LEASE_SECONDS` as a number: 600 when absent, empty or not a positive integer. */
export function leaseSeconds(env: Env): number {
  return positiveInteger(env.LEASE_SECONDS, 600);
}

export function authCodeTtlSeconds(env: Env): number {
  return positiveInteger(env.AUTH_CODE_TTL_SECONDS, 60);
}

export function authRequestTtlSeconds(env: Env): number {
  return positiveInteger(env.AUTH_REQUEST_TTL_SECONDS, 600);
}

/** `PUBLIC_URL` without a trailing slash: the issuer, `BASE` in section 10. */
export function baseUrl(env: Env): string {
  return env.PUBLIC_URL.replace(/\/+$/, "");
}
