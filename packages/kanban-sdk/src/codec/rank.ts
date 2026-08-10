/**
 * Fractional indexing for card order within a column. Cards sort by ascending
 * `rank`. kanbanstr uses the same midpoint scheme (stores/kanban.ts:790) but
 * never rebalances; `needsRebalance` + `rebalance` close that gap.
 */

export const RANK_STEP = 10;

/** Smallest gap we tolerate before rebalancing. Well above float epsilon. */
const PRECISION_FLOOR = 1e-6;

/**
 * Rank for a card landing at `targetIndex` within a column whose existing cards
 * (excluding the one being moved) have `sortedRanks` in ascending order.
 */
export function computeRank(sortedRanks: number[], targetIndex: number): number {
  if (sortedRanks.length === 0) return RANK_STEP;

  if (targetIndex <= 0) return sortedRanks[0] - RANK_STEP;
  if (targetIndex >= sortedRanks.length) {
    return sortedRanks[sortedRanks.length - 1] + RANK_STEP;
  }

  const before = sortedRanks[targetIndex - 1];
  const after = sortedRanks[targetIndex];
  return before + (after - before) / 2;
}

/** True when any adjacent pair has collapsed and the column should be rewritten. */
export function needsRebalance(sortedRanks: number[]): boolean {
  for (let i = 1; i < sortedRanks.length; i += 1) {
    if (sortedRanks[i] - sortedRanks[i - 1] < PRECISION_FLOOR) return true;
  }
  return false;
}

/** Evenly spaced ranks for `count` cards, in display order. */
export function rebalance(count: number): number[] {
  return Array.from({ length: count }, (_, i) => (i + 1) * RANK_STEP);
}
