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
      return "You are a member, not a maintainer — members can read and comment, not write cards.";
    case "NotBoardOwnerError":
      return "Only the board owner can do that (invite, remove members, rotate the key).";
    case "InvitationVerificationError":
      return "This invitation failed verification — the seal's author does not match the rumor's. Ignoring it.";
    case "BoardNotFoundError":
      return "Board not found on these relays. It may not have propagated yet, or the relays may differ from where it was written.";
    default:
      return error.message;
  }
}
