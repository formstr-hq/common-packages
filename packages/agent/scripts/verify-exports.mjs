// Resolve every published subpath against the built dist. Exits non-zero on any miss.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const subpaths = [
  "@formstr/agent",
  "@formstr/agent/services",
  "@formstr/agent/services/forms",
  "@formstr/agent/services/calendar",
  "@formstr/agent/services/pages",
  "@formstr/agent/services/drive",
  "@formstr/agent/services/polls",
  "@formstr/agent/services/profile",
  "@formstr/agent/tools",
];
let failed = 0;
for (const s of subpaths) {
  try {
    require.resolve(s);
    console.log("OK   " + s);
  } catch (e) {
    failed++;
    console.error("FAIL " + s + " — " + e.message);
  }
}
process.exit(failed ? 1 : 0);
