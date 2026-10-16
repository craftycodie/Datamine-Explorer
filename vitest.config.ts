import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __DATAMINE_EXPLORER_DESKTOP__: "true" },
  test: { include: ["tests/**/*.test.ts"] },
});
