import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import { initKeycloak } from "./lib/keycloak";

initKeycloak().then(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});