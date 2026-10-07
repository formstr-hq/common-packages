import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "services/index": "src/services/index.ts",
    "services/forms/index": "src/services/forms/index.ts",
    "services/calendar/index": "src/services/calendar/index.ts",
    "services/pages/index": "src/services/pages/index.ts",
    "services/drive/index": "src/services/drive/index.ts",
    "services/polls/index": "src/services/polls/index.ts",
    "services/profile/index": "src/services/profile/index.ts",
    "tools/index": "src/tools/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
});
