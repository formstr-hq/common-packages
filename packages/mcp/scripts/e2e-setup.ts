// One-off helper for the realtime e2e: seed a headless MCP keystore account.
// Run from packages/mcp with FORMSTR_MCP_KEYSTORE=file, FORMSTR_MCP_CONFIG_DIR and
// FORMSTR_MCP_NCRYPTSEC_PASSPHRASE set. Not part of the published package.
import { createSigner } from "@formstr/signer";

import { createKeystoreStorage } from "../src/auth/kvStore";

void (async () => {
  const pass = process.env.FORMSTR_MCP_NCRYPTSEC_PASSPHRASE;
  if (!pass) throw new Error("FORMSTR_MCP_NCRYPTSEC_PASSPHRASE is required");

  const signer = createSigner({ storage: await createKeystoreStorage(), appName: "mcp-e2e" });
  const account = await signer.createAccount(pass);
  console.log(JSON.stringify(account, null, 2));
})();
