import Keycloak from 'keycloak-js';

export const keycloak = new Keycloak({
  url: process.env.NEXT_PUBLIC_KEYCLOAK_URL!,
  realm: process.env.NEXT_PUBLIC_KEYCLOAK_REALM!,
  clientId: process.env.NEXT_PUBLIC_KEYCLOAK_CLIENT_ID!,
});

// Marks "this tab has logged in" so a refresh keeps the session but a new tab
// (or a reopened browser) must log in again. Only a flag — tokens stay in
// keycloak-js memory. If sessionStorage is unavailable the flag reads as
// absent, so every load forces a login rather than falling back to silent SSO.
const SESSION_FLAG = 'lc_session_active';

function hasSessionFlag(): boolean {
  try {
    return window.sessionStorage.getItem(SESSION_FLAG) === '1';
  } catch {
    return false;
  }
}

function setSessionFlag(): void {
  try {
    window.sessionStorage.setItem(SESSION_FLAG, '1');
  } catch {
    // storage blocked — next load will just ask for a login again
  }
}

function clearSessionFlag(): void {
  try {
    window.sessionStorage.removeItem(SESSION_FLAG);
  } catch {
    // nothing to clear
  }
}

// True when this load is Keycloak redirecting back to us (fragment response
// mode by default, query as a fallback). Must be read before init() strips it.
function isAuthCallback(): boolean {
  const params = new URLSearchParams(window.location.hash.slice(1) || window.location.search);
  return params.has('state') && (params.has('code') || params.has('error'));
}

let initialized = false;

export async function initKeycloak(): Promise<boolean> {
  if (initialized) return keycloak.authenticated ?? false;
  initialized = true;

  const initOptions = { pkceMethod: 'S256' as const, checkLoginIframe: false };
  let authenticated: boolean;

  if (hasSessionFlag()) {
    // Refresh in the same tab: reuse the SSO session as before.
    authenticated = await keycloak.init({ ...initOptions, onLoad: 'login-required' });
  } else {
    // No onLoad: 'login-required' here — it would pick up the SSO session
    // silently. init() still exchanges the code when we're on a callback.
    const callback = isAuthCallback();
    authenticated = await keycloak.init(initOptions);
    if (authenticated) {
      setSessionFlag();
    } else if (callback) {
      // Don't redirect again from a failed callback (loop guard); the
      // Providers error screen offers Retry, which reloads without the callback.
      throw new Error('Keycloak returned without a valid login. Press Retry to sign in again.');
    } else {
      await keycloak.login({ prompt: 'login' });
      return false; // navigating away to the login page
    }
  }

  setInterval(() => keycloak.updateToken(70).catch(() => keycloak.login()), 60000);
  return authenticated;
}

export function logout(): void {
  clearSessionFlag();
  // Back to the dashboard root, which then asks for a fresh login (no session
  // flag). The realm accepts this because logchain-frontend's "Valid post
  // logout redirect URIs" is "+" (= its Valid redirect URIs) — the default for
  // realms imported without the attribute, and set explicitly in the template.
  // An origin missing from the redirect URIs gets "Invalid redirect uri":
  // run ./scripts/sync-keycloak-urls.sh for that URL.
  void keycloak.logout({ redirectUri: window.location.origin });
}
