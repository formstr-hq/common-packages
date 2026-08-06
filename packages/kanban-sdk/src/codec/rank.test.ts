import { describe, expect, it } from "vitest";

import { RANK_STEP, computeRank, needsRebalance, rebalance } from "./rank";

describe("computeRank", () => {
  it("returns the base step for an empty column", () => {
    expect(computeRank([], 0)).toBe(RANK_STEP);
  });

  it("places a card before the first by stepping down", () => {
    expect(computeRank([10, 20, 30], 0)).toBe(0);
  });

  it("places a card after the last by stepping up", () => {
    expect(computeRank([10, 20, 30], 3)).toBe(40);
  });

  it("places a card between two neighbours at the midpoint", () => {
    expect(computeRank([10, 20, 30], 1)).toBe(15);
    expect(computeRank([10, 20, 30], 2)).toBe(25);
  });

  it("clamps an out-of-range index to the end", () => {
    expect(computeRank([10], 99)).toBe(20);
  });

  it("treats a negative index as the start", () => {
    expect(computeRank([10], -3)).toBe(0);
  });
});

describe("needsRebalance", () => {
  it("is false for well-spaced ranks", () => {
    expect(needsRebalance([10, 20, 30])).toBe(false);
  });

  it("is true when neighbours are closer than the precision floor", () => {
    expect(needsRebalance([10, 10 + 1e-10, 20])).toBe(true);
  });

  it("is true for exactly equal neighbours", () => {
    expect(needsRebalance([10, 10, 20])).toBe(true);
  });

  it("is false for fewer than two cards", () => {
    expect(needsRebalance([10])).toBe(false);
    expect(needsRebalance([])).toBe(false);
  });
});

describe("rebalance", () => {
  it("produces evenly spaced ranks", () => {
    expect(rebalance(3)).toEqual([10, 20, 30]);
  });

  it("produces an empty array for zero cards", () => {
    expect(rebalance(0)).toEqual([]);
  });
});
