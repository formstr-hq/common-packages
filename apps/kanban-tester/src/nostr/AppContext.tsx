import { KanbanSDK } from "@formstr/kanban-sdk";
import { createSigner, type ActiveSigner, type StoredAccount } from "@formstr/signer";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { LoggingRuntime } from "./loggingRuntime";
import { loadRelays, saveRelays } from "./relays";

const signer = createSigner({
  appName: "kanban-tester",
  storageKeyPrefix: "kanban-tester:signer:",
});

// One runtime for the app's lifetime: it owns the relay pool and the event log,
// and neither should be thrown away when the SDK is rebuilt on login.
const runtime = new LoggingRuntime();

interface AppState {
  account: StoredAccount | null;
  /** Null while the account is locked — every account rehydrates locked. */
  active: ActiveSigner | null;
  /** Null until an account is unlocked. Reads need a signer too (they decrypt). */
  sdk: KanbanSDK | null;
  runtime: LoggingRuntime;
  relays: string[];
  setRelays(relays: string[]): void;
  signer: typeof signer;
  /** Call after any signer mutation the Signer does not emit an event for. */
  syncSigner(): void;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<StoredAccount | null>(() => signer.getActiveAccount());
  const [active, setActive] = useState<ActiveSigner | null>(() => signer.getActiveSigner());
  const [relays, setRelaysState] = useState<string[]>(loadRelays);

  const syncSigner = useCallback(() => {
    setAccount(signer.getActiveAccount());
    setActive(signer.getActiveSigner());
  }, []);

  useEffect(() => signer.onChange(syncSigner), [syncSigner]);

  // Extension accounts can be re-attached with no user interaction, so a reload
  // lands back on the board instead of the login screen.
  useEffect(() => {
    const stored = signer.getActiveAccount();
    if (!stored || signer.getActiveSigner() || stored.method !== "extension") return;
    signer
      .unlock()
      .then(syncSigner)
      .catch(() => {
        /* leave the account locked; the UI offers the login form */
      });
  }, [syncSigner]);

  const setRelays = useCallback((next: string[]) => {
    saveRelays(next);
    setRelaysState(next);
  }, []);

  // `ActiveSigner` is a structural superset of `KanbanSigner`, so it drops
  // straight in — no adapter. Rebuilt whenever the identity or relays change.
  const sdk = useMemo(() => {
    if (!active) return null;
    return new KanbanSDK({ signer: active, relays, runtime });
  }, [active, relays]);

  const value = useMemo<AppState>(
    () => ({ account, active, sdk, runtime, relays, setRelays, signer, syncSigner }),
    [account, active, sdk, relays, setRelays, syncSigner],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside <AppProvider>");
  return ctx;
}

/** For the many components that only run once an account is unlocked. */
export function useSdk(): KanbanSDK {
  const { sdk } = useApp();
  if (!sdk) throw new Error("No signer — this component must render behind the login gate");
  return sdk;
}
