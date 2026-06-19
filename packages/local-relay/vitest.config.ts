import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The engine + data layer are pure JS; tests run in node with timers/fakes.
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
  },
});
