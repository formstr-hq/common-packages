import { describe, it, expect } from "vitest";

import { mapMethod } from "../src/auth/methodMap";

describe("mapMethod", () => {
  it("maps the headless-reachable methods to core SignerMethod", () => {
    expect(mapMethod("ncryptsec")).toBe("local");
    expect(mapMethod("nip46")).toBe("nip46");
  });

  it("maps the remaining LoginMethods for exhaustiveness", () => {
    expect(mapMethod("extension")).toBe("nip07");
    expect(mapMethod("android")).toBe("nip55");
    // `nip55-web` (browser NIP-55, signer 0.3.x) is unreachable headlessly but
    // must map to the same method as its native counterpart.
    expect(mapMethod("nip55-web")).toBe("nip55");
  });
});
