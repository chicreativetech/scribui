import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CLIENT_ID } from "./api";
import { App } from "./App";
import { useStore } from "./store";

(window as unknown as { __icClient: string }).__icClient = CLIENT_ID;
// exposed for end-to-end tests and debugging from the console
(window as unknown as { __intentcue: typeof useStore }).__intentcue = useStore;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
