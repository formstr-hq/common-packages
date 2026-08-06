import { describe, expect, it } from "vitest";

import { KANBAN_KINDS } from "./kinds";

describe("KANBAN_KINDS", () => {
  it("matches the NIP-100 public kinds", () => {
    expect(KANBAN_KINDS.publicBoard).toBe(30301);
    expect(KANBAN_KINDS.publicCard).toBe(30302);
  });

  it("maps git status kinds used by tracker cards", () => {
    expect(KANBAN_KINDS.gitStatusOpen).toBe(1630);
    expect(KANBAN_KINDS.gitStatusClosed).toBe(1632);
  });

  it("has no duplicate kind numbers", () => {
    const values = Object.values(KANBAN_KINDS);
    expect(new Set(values).size).toBe(values.length);
  });
});
