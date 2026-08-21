import type { BoardRole } from "../types";

const CURRENT: readonly BoardRole[] = ["owner", "admin", "participant"];

/**
 * Read a role off the wire, tolerating the names 0.1.x wrote.
 *
 * `maintainer` and `member` predate the Admin/Participant split. Both come back
 * as `participant`, which grants nothing: the role recorded on a board-list ref
 * or an invitation is advisory, and the board's own `admin` and `p` tags decide
 * what anybody may actually do.
 *
 * Anything unrecognised, including a forged `owner`, falls back to the least
 * privileged role rather than being trusted.
 */
export function normalizeBoardRole(claimed: string | undefined): BoardRole {
  if (claimed && (CURRENT as readonly string[]).includes(claimed)) return claimed as BoardRole;
  return "participant";
}
