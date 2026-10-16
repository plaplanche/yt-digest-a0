import type { D1Migration } from "cloudflare:test";
import type { Env } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends EnvOfWorker {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

type EnvOfWorker = Env;
