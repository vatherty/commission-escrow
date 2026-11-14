import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./theme.css";

/* Standalone build: the app owns its QueryClient (the Space version shared
   the hosting SDK's). Defaults are deliberately plain — a short staleTime
   so navigation feels instant, one retry for flaky mobile networks. */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
    mutations: { retry: 0 },
  },
});

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("missing #root element");
}

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <div className="app-root">
        <App />
      </div>
    </QueryClientProvider>
  </StrictMode>,
);
