import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { LanguageProvider } from "./lib/i18n";
import { privyEnabled } from "./lib/privy-env";
import { initTextScale, initViewportZoom } from "./lib/viewportZoom";
import "@fontsource-variable/syne";
import "@fontsource-variable/dm-sans";
import "./styles.css";

initTextScale();
initViewportZoom();

const tree = (
  <BrowserRouter>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </BrowserRouter>
);

async function render() {
  let root: React.ReactNode = tree;
  if (privyEnabled()) {
    const { PrivyRoot } = await import("./lib/privy");
    root = <PrivyRoot>{tree}</PrivyRoot>;
  }
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>{root}</React.StrictMode>
  );
}

void render();
