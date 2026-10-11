import { defineConfig } from "tsup";

export default defineConfig({
  // The local-relay adapter is a separate entry; it imports nothing from @formstr/local-relay (structural types only).
  entry: { index: "src/index.ts", "local-relay": "src/local-relay.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
});
