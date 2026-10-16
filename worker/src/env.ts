/** The Worker's bindings (wrangler.toml) and settings (spec/lot-2.md section 5.2). */
export interface Env {
  DB: D1Database;
  TRANSCRIPTS: R2Bucket;
  /** Bearer of the operator endpoints; `/ops/*` does not exist when it is absent or empty. */
  OPS_TOKEN?: string;
}
