import Keycloak from 'keycloak-js';

export const keycloak = new Keycloak({
  url: process.env.NEXT_PUBLIC_KEYCLOAK_URL!,
  realm: process.env.NEXT_PUBLIC_KEYCLOAK_REALM!,
  clientId: process.env.NEXT_PUBLIC_KEYCLOAK_CLIENT_ID!,
});

let initialized = false;

export async function initKeycloak(): Promise<boolean> {
  if (initialized) return keycloak.authenticated ?? false;
  initialized = true;
  const authenticated = await keycloak.init({
    onLoad: 'login-required',
    pkceMethod: 'S256',
    checkLoginIframe: false,
  });
  setInterval(() => keycloak.updateToken(70).catch(() => keycloak.login()), 60000);
  return authenticated;
}
