import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Next.js marker module; a no-op outside the Next build.
      "server-only": fileURLToPath(new URL("./tests/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup-env.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The stealth SDK ships extensionless ESM imports; let Vite resolve them.
    server: { deps: { inline: ["@scopelift/stealth-address-sdk"] } },
  },
});
