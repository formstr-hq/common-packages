import { describe, expect, it } from "vitest";

import { normalizeBoardRole } from "./role";

describe("normalizeBoardRole", () => {
  it("passes the current roles through", () => {
    expect(normalizeBoardRole("owner")).toBe("owner");
    expect(normalizeBoardRole("admin")).toBe("admin");
    expect(normalizeBoardRole("participant")).toBe("participant");
  });

  it("reads a pre-0.2 maintainer as a participant", () => {
    expect(normalizeBoardRole("maintainer")).toBe("participant");
  });

  it("reads a pre-0.2 member as a participant too", () => {
    // The role on a list ref or an invitation is advisory: the board's own tags
    // decide what anyone may do. Nothing is granted by reading it generously,
    // and the Viewer role it named no longer exists.
    expect(normalizeBoardRole("member")).toBe("participant");
  });

  it("falls back to the least privileged role for anything unrecognised", () => {
    expect(normalizeBoardRole(undefined)).toBe("participant");
    expect(normalizeBoardRole("")).toBe("participant");
    expect(normalizeBoardRole("superuser")).toBe("participant");
  });

  it("does not let a forged owner claim become one", () => {
    expect(normalizeBoardRole("Owner")).toBe("participant");
  });
});
