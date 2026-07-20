'use client';
import { useEffect, useState, useRef } from 'react';
import keycloak from '@/lib/keycloak';

export default function Providers({ children }: { children: React.ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false);
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return; // กัน double-init จาก React strict mode
    initialized.current = true;

    keycloak
      .init({ onLoad: 'login-required', pkceMethod: 'S256', checkLoginIframe: false })
      .then((auth) => setAuthenticated(auth));
  }, []);

  if (!authenticated) return <p className="p-6 text-gray-400">Authenticating...</p>;
  return <>{children}</>;
}
