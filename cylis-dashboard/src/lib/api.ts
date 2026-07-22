import axios from 'axios';
import { keycloak } from './keycloak';

export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL });

api.interceptors.request.use(async (config) => {
  if (keycloak.token) {
    try { await keycloak.updateToken(30); } catch { keycloak.login(); }
    config.headers.Authorization = `Bearer ${keycloak.token}`;
  }
  return config;
});
