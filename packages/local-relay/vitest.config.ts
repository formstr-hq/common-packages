import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The engine + data layer are pure JS; tests run in node with timers/fakes.
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts", // the specs themselves
        "src/**/*.d.ts",
        "src/index.ts", // barrel re-exports
        "src/localRelay/core/protocol.ts", // type-only (NIP-01 message shapes)
        "src/localRelay/transport/frames.ts", // type-only (worker envelopes)
        "src/localRelay/storage/StorageAdapter.ts", // interface only
        "src/localRelay/testkit.ts", // test helpers, not shipped logic
        // Platform shells: real WebSocket / IndexedDB / worker globals — not
        // unit-coverable in node; exercised via integration + the tester app.
        "src/localRelay/sync/Socket.ts",
        "src/localRelay/storage/IndexedDBStorage.ts",
        "src/localRelay/transport/channel.ts",
        "src/localRelay/worker/relay.worker.ts",
      ],
      // 100% statements/functions/lines. The branch floor sits just under 100:
      // five branch OUTCOMES are unreachable through the current (single-threaded)
      // code — two `?? []` fallbacks that are dead given how the maps are built
      // (scope.ts, outbox.ts), EventDB.remove()'s absent-id guard (every caller
      // checks first), and the "same-author deletion of an event still in the
      // store" outcome in query()/getById() (add() maintains that invariant). None
      // is a removable statement: each is an idiomatic `?? []` default or one half
      // of a boolean whose other half is live and tested.
      thresholds: {
        statements: 100,
        functions: 100,
        lines: 100,
        branches: 99,
      },
    },
  },
});
