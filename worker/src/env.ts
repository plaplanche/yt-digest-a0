/** The Worker's bindings (wrangler.toml) and settings (spec/lot-2.md section 5.2). */
export interface Env {
  DB: D1Database;
  TRANSCRIPTS: R2Bucket;
  /** Bearer of the operator endpoints; `/ops/*` does not exist when it is absent or empty. */
  OPS_TOKEN?: string;
  /** Lease duration in seconds (section 8.3); 600 when absent. */
  LEASE_SECONDS?: string;
}

/** `LEASE_SECONDS` as a number: 600 when absent, empty or not a positive integer. */
export function leaseSeconds(env: Env): number {
  const value = Number(env.LEASE_SECONDS);
  return Number.isInteger(value) && value > 0 ? value : 600;
}
