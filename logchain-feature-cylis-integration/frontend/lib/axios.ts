import axios from 'axios';
import keycloak from './keycloak';

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
});

api.interceptors.request.use(async (config) => {
  if (keycloak.token) {
    try {
      await keycloak.updateToken(30);
    } catch {
      keycloak.login();
    }
    config.headers.Authorization = `Bearer ${keycloak.token}`;
  }
  return config;
});

export default api;
