import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolve } from "node:path";

// Alias the SDK to its SOURCE so SDK edits show up with no rebuild (same trick as apps/kanban-tester).
// The app only ever touches the package's public entry point.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { target: "es2022" },
  resolve: {
    alias: [{ find: "@formstr/drive-sdk", replacement: resolve(__dirname, "../../packages/drive-sdk/src/index.ts") }],
  },
  server: { port: 5176, fs: { allow: ["../.."] } },
});
