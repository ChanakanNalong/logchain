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
  // Keycloak shows its own logged-out page for now: the running Keycloak has
  // no "Valid post logout redirect URIs" for logchain-frontend yet, so any
  // post_logout_redirect_uri fails with "Invalid redirect uri". Plain
  // keycloak.logout() can't avoid that — keycloak-js 26 falls back to
  // location.href when no redirectUri is given — so drop the parameter from
  // its logout URL (id_token_hint stays, so Keycloak doesn't ask to confirm).
  // Once the URIs are set in the Admin Console (the realm template already
  // has them), replace this with:
  //   void keycloak.logout({ redirectUri: window.location.origin });
  const url = new URL(keycloak.createLogoutUrl());
  url.searchParams.delete('post_logout_redirect_uri');
  window.location.replace(url.toString());
}
