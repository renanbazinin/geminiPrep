import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

function render() {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// The server sends signed-out page loads to /login itself; this check covers the Vite dev
// server, which serves this page without asking the API server first.
fetch("/api/session")
  .then((response) => {
    if (response.status === 401) {
      window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    } else {
      render();
    }
  })
  .catch(render);

