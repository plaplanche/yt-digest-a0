import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd on Miniflare's real D1 and R2 (wrangler.toml's bindings);
// test/setup.ts applies the migrations, handed over as the TEST_MIGRATIONS binding.
export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations, OPS_TOKEN: "ops-test" } },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
