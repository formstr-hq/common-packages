import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolve } from "node:path";

// Alias both packages to their SOURCE so SDK edits show up with no rebuild —
// same trick as apps/local-relay-tester. This is also the honest integration
// shape: the app only ever touches the packages' public entry points.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { target: "es2022" },
  resolve: {
    alias: [
      {
        find: "@formstr/kanban-sdk",
        replacement: resolve(__dirname, "../../packages/kanban-sdk/src/index.ts"),
      },
      {
        find: "@formstr/signer",
        replacement: resolve(__dirname, "../../packages/signer/src/index.ts"),
      },
    ],
  },
  server: {
    port: 5175,
    fs: { allow: ["../.."] },
  },
});
