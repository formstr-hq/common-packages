import type { SignerMethod } from "@formstr/core";
import type { LoginMethod } from "@formstr/signer";

/**
 * Map a `@formstr/signer` LoginMethod to the core SignerMethod. Only `ncryptsec`
 * and `nip46` are reachable in the headless MCP (no browser extension, no Android
 * signer app); the other arms exist for exhaustiveness. `nip55-web` (browser
 * NIP-55, added in signer 0.3.x) is likewise unreachable here, but maps to the
 * same `nip55` method as its native counterpart.
 */
export function mapMethod(method: LoginMethod): SignerMethod {
  switch (method) {
    case "extension":
      return "nip07";
    case "nip46":
      return "nip46";
    case "ncryptsec":
      return "local";
    case "android":
    case "nip55-web":
      return "nip55";
  }
}
