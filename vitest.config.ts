import { defineConfig } from "vitest/config";

// Unit tests run in the default Node environment. The crypto/beacon logic uses
// WebCrypto (globalThis.crypto), available in Node 20+.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // `test/workers` runs under `workerd` via vitest.workers.config.ts; those
    // specs import `cloudflare:test`, which does not resolve in Node.
    exclude: ["test/workers/**"],
    environment: "node",
  },
});
