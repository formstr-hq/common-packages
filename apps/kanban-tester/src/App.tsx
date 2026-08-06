import { useState } from "react";

import { BoardPage } from "./components/BoardPage";
import { BoardsPage } from "./components/BoardsPage";
import { EventLogDrawer } from "./components/EventLogDrawer";
import { Header } from "./components/Header";
import { LoginPanel } from "./components/LoginPanel";
import { useApp } from "./nostr/AppContext";
import { useRoute } from "./router";

export function App() {
  const { sdk } = useApp();
  const route = useRoute();
  const [logOpen, setLogOpen] = useState(false);

  return (
    <div className={logOpen ? "app app-with-log" : "app"}>
      <Header onToggleLog={() => setLogOpen((open) => !open)} />
      <main className="app-main">
        {/* Reads decrypt, so even viewing a private board needs an unlocked signer. */}
        {!sdk ? (
          <LoginPanel />
        ) : route.name === "board" ? (
          <BoardPage coordinate={route.coordinate} />
        ) : (
          <BoardsPage />
        )}
      </main>
      {logOpen && <EventLogDrawer onClose={() => setLogOpen(false)} />}
    </div>
  );
}
