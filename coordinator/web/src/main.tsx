import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initializeTheme } from "./theme";
import { installMobileViewport } from "./mobile";
import "@fontsource-variable/dm-sans/wght.css";
import "@fontsource-variable/manrope/wght.css";
import "./style.css";
import "./facelift.css";
import "./voice-screen.css";
import "./product-shell.css";
initializeTheme();
installMobileViewport();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
