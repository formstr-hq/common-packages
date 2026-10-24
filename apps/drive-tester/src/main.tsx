import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// No StrictMode on purpose: double-invoked effects would fire every relay query twice and make the
// inspector — the thing this app exists to show — a misleading duplicate of itself.
createRoot(document.getElementById("root")!).render(<App />);
