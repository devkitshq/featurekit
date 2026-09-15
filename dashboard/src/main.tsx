import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app";
import { SessionProvider } from "./lib/session";
import { ToastProvider } from "./components/ui";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("featkit: #root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    {/* The server mounts this bundle at /admin, so the router does too. */}
    <BrowserRouter basename="/admin">
      <ToastProvider>
        <SessionProvider>
          <App />
        </SessionProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
