import { defineConfig } from "vite";
import { resolve } from "node:path";

// Alias the package to its SOURCE so edits show up with no rebuild step. This is
// also exactly the integration shape a host uses: the worker entry imports the
// engine from "@formstr/local-relay", and the main thread imports the contract.
export default defineConfig({
  base: "./",
  build: { target: "es2022" },
  worker: { format: "es" },
  resolve: {
    alias: [
      {
        find: "@formstr/local-relay",
        replacement: resolve(__dirname, "../../packages/local-relay/src/index.ts"),
      },
    ],
  },
  server: {
    port: 5174,
    fs: { allow: ["../.."] },
    watch: {
      usePolling: true,
      interval: 1000,
      ignored: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
    },
  },
});
