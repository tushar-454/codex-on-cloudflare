import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Unit tests run inside workerd (real Workers runtime) with a mocked AI binding passed
// explicitly to the handler, so no Neurons are spent and no Cloudflare login is needed.
export default defineConfig({
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      // Production uses the date in wrangler.jsonc.
      miniflare: { compatibilityDate: "2026-11-01" },
    }),
  ],
  test: { include: ["tests/unit/**/*.test.ts"] },
});
