import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { LanguageProvider } from "./lib/i18n";
import { initTextScale, initViewportZoom } from "./lib/viewportZoom";
import "@fontsource-variable/inter";
import "./styles.css";

initTextScale();
initViewportZoom();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <LanguageProvider>
        <App />
      </LanguageProvider>
    </BrowserRouter>
  </React.StrictMode>
);
