import { createRoot } from "react-dom/client";

import { App } from "./App";
import { AppProvider } from "./nostr/AppContext";
import { ToastProvider } from "./ui/Toast";
import "./styles.css";

// No StrictMode on purpose. Its double-invoked effects fire every relay query
// twice, which turns the event log — the thing this app exists to show — into a
// misleading duplicate of itself.
createRoot(document.getElementById("root")!).render(
  <ToastProvider>
    <AppProvider>
      <App />
    </AppProvider>
  </ToastProvider>,
);
