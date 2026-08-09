"use client";

import { useEffect, useRef, useState } from "react";
import { initKeycloak } from "@/lib/keycloak";

const message: React.CSSProperties = {
  padding: 24,
  color: "#7c87a3",
  fontFamily: "var(--font-sans),system-ui,sans-serif",
  fontSize: 14,
  lineHeight: 1.6,
};

/**
 * Gates the app behind Keycloak, replacing the `initKeycloak().then(render)`
 * bootstrap that used to live in src/main.tsx.
 *
 * A rejected init can't reach an error boundary (it happens in an effect, not
 * during render), so the failure is caught and kept in state instead.
 */
export default function Providers({ children }: { children: React.ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return; // guard against React strict-mode double-init
    initialized.current = true;

    initKeycloak()
      .then((ok) => {
        setAuthenticated(ok);
        if (!ok) setError("Keycloak did not authenticate this session.");
      })
      .catch((e) => {
        console.error("Keycloak init failed", e);
        setError(e?.message || "Could not reach Keycloak.");
      });
  }, []);

  if (error) {
    return (
      <div style={message} role="alert">
        <div style={{ color: "#f43f5e", fontWeight: 600, marginBottom: 6 }}>
          Sign-in unavailable
        </div>
        <div>{error}</div>
        <div style={{ marginTop: 10, fontSize: 13 }}>
          Check that Keycloak is running at{" "}
          <code>{process.env.NEXT_PUBLIC_KEYCLOAK_URL}</code> and that realm{" "}
          <code>{process.env.NEXT_PUBLIC_KEYCLOAK_REALM}</code> is imported.
        </div>
        <button
          onClick={() => window.location.reload()}
          style={{
            marginTop: 16,
            padding: "7px 14px",
            borderRadius: 9,
            background: "rgba(59,130,246,0.18)",
            border: "1px solid rgba(59,130,246,0.35)",
            color: "#60a5fa",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!authenticated) {
    return <p style={message}>Authenticating…</p>;
  }

  return <>{children}</>;
}
