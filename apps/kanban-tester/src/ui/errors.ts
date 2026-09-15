/**
 * The SDK throws named errors rather than strings. Translating by `name` keeps
 * the mapping stable even when the message text changes.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  switch (error.name) {
    case "SignerRequiredError":
      return "That needs a signer. Unlock your account first.";
    case "ViewKeyRequiredError":
      return "No view key for this board. Accept its invitation, or open it from a board list that carries the key.";
    case "NotAMaintainerError":
      return "You have read access to this board, not write access — you can read and comment, not write cards.";
    case "NotAnAdminError":
      return "Only the board's creator and the keys they have promoted to admin can change its columns, title, or roster.";
    case "NotEventAuthorError":
      return "NIP-09 lets only an event's own author delete it, so a tombstone from you would be ignored. Bin the card instead.";
    case "NotBoardOwnerError":
      return "Only the board creator can do that (rotate the key, delete the board).";
    case "InvitationVerificationError":
      return "This invitation failed verification — the seal's author does not match the rumor's. Ignoring it.";
    case "BoardNotFoundError":
      return "Board not found on these relays. It may not have propagated yet, or the relays may differ from where it was written.";
    default:
      return error.message;
  }
}
