import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd on Miniflare's real D1 and R2 (wrangler.toml's bindings);
// test/setup.ts applies the migrations, handed over as the TEST_MIGRATIONS binding. Google's
// endpoints (GOOGLE_ISSUER) are answered by a stub of `fetch` in the OAuth tests.
export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            OPS_TOKEN: "ops-test",
            PUBLIC_URL: "http://worker.test/",
            GOOGLE_ISSUER: "https://google.test",
            GOOGLE_CLIENT_ID: "worker-client",
            GOOGLE_CLIENT_SECRET: "worker-secret",
            ADMIN_EMAIL: "Alice@Test",
            TOKEN_ENC_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
