import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";

import { RequireSession } from "./App";
import { router } from "./router";
import { ThemeProvider } from "./lib/theme";
import "./lib/i18n";
import "./index.css";

const queryClient = new QueryClient();

// A missing #root is an index.html that shipped without its mount point — a broken
// build, not a state the app can run in. Naming it fails at startup with a message
// that says what is wrong, instead of a non-null assertion that says nothing.
const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("index.html is missing its #root element");

createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RequireSession>
          <RouterProvider router={router} />
        </RequireSession>
        <Toaster richColors position="top-center" />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);