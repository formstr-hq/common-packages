#!/usr/bin/env node
// Live smoke test of the BUILT package (dist/), against real relays and a real Blossom server.
//
//   pnpm build
//   node scripts/smoke.mjs --yes
//   DRIVE_SMOKE_RELAYS=wss://a,wss://b DRIVE_SMOKE_BLOSSOM=https://blossom.example node scripts/smoke.mjs --yes
//
// What it writes, and why you must say --yes: it publishes a handful of small ENCRYPTED events and uploads one
// ~6 KB ENCRYPTED blob to the servers below, all under a brand-new throwaway key that is discarded when the
// run ends. It then deletes the blob and tombstones the file. Nothing readable and nothing tied to you is
// left, but it is real traffic on shared infrastructure, so the servers are printed first and the script
// refuses to proceed without an explicit --yes.
import { pathToFileURL } from "node:url";
import { runSmoke } from "./smoke-flow.mjs";

const DEFAULT_RELAYS = ["wss://relay.formstr.app", "wss://relay.damus.io", "wss://nos.lol"];
const DEFAULT_BLOSSOM = ["https://nostr.download"];

const list = (value, fallback) => (value ? value.split(/[\s,]+/).filter(Boolean) : fallback);
const relays = list(process.env.DRIVE_SMOKE_RELAYS, DEFAULT_RELAYS);
const blossom = list(process.env.DRIVE_SMOKE_BLOSSOM, DEFAULT_BLOSSOM);

console.log(`Node ${process.version}`);
console.log(`relays:  ${relays.join(", ")}`);
console.log(`blossom: ${blossom.join(", ")}`);
if (!process.argv.includes("--yes")) {
  console.log("\nThis writes encrypted test data under a throwaway key to the servers above. Re-run with --yes to proceed.");
  process.exit(2);
}

const sdkUrl = new URL("../dist/index.js", pathToFileURL(process.argv[1]));
let sdk;
try {
  sdk = await import(sdkUrl.href);
} catch (error) {
  console.error(`Could not load the built package (${sdkUrl.pathname}). Run \`pnpm build\` first.\n${error.message}`);
  process.exit(2);
}

// Node 22+ has a global WebSocket; Node 20 does not, and needs the `ws` package.
let webSocket = globalThis.WebSocket;
if (!webSocket) {
  try {
    webSocket = (await import("ws")).default;
  } catch {
    console.error("This Node has no global WebSocket. Install the `ws` package (it is a devDependency here: pnpm install).");
    process.exit(2);
  }
}

const makeStore = () => sdk.createRelayPoolStore({ relays, webSocket });
const { ok, results, identity } = await runSmoke({
  sdk,
  makeStore,
  transport: sdk.createFetchBlossomTransport(),
  blossom,
  log: (line) => console.log(line),
});

console.log(`\nthrowaway identity: ${identity.slice(0, 12)}…  (key discarded)`);
const count = (status) => results.filter((r) => r.status === status).length;
console.log(`${ok ? "PASSED" : "FAILED"}: ${count("PASS")} passed, ${count("WARN")} warning(s), ${count("FAIL")} failed`);
process.exit(ok ? 0 : 1);
