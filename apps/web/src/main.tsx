import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>Dokan (دكان)</h1>
      <p>Scaffold — UI screens land in the coding phase.</p>
    </main>
  </StrictMode>,
);