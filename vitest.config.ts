import { defineConfig } from "vitest/config";

// Unit tests run in the default Node environment. The crypto/beacon logic uses
// WebCrypto (globalThis.crypto), available in Node 20+.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
