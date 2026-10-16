/**
 * Fixed option lists for the Logs filters. One file on purpose: when the
 * backend grows a facets endpoint, swap these constants for its response.
 * Every dropdown except severity also accepts a typed value, so a source or
 * eventType missing from here can still be filtered on.
 */

/** CreateLogDto enum (src/logs/dto/create-log.dto.ts) — the only values a log can hold */
export const LOG_SEVERITIES = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] as const;

/** "Attacks" quick filter — forwarder/detection tag anything suspicious >= WARNING */
export const ATTACK_SEVERITIES = ["WARNING", "ERROR", "CRITICAL"] as const;

/** The VPS log forwarder (forwarder/README.md) — sshd journal + web-proxy all-requests */
export const VPS_SOURCES = ["vps-sshd", "web-proxy"] as const;

export const LOG_SOURCES = [
  ...VPS_SOURCES,
  // demo traffic: detection/gen_traffic.py (app-*, atk-*) and scripts/demo-*.sh
  "auth-service",
  "app-web-1",
  "app-svc-1",
] as const;

export const LOG_EVENT_TYPES = [
  // VPS forwarder
  "SSH_AUTH",
  "HTTP_ACCESS",
  // demo scripts / gen_traffic.py
  "AUTH_FAILURE",
  "AUTH_SUCCESS",
  "LOGIN_SUCCESS",
  "PRIV_ESC",
  "WEB_REQUEST",
  "HTTP_FLOOD",
  "CONN_ATTEMPT",
  "DATA_ACCESS",
  "CARD_ACCESS",
  "USER_ACTIVITY",
  "FILE_ACCESS",
  "DB_QUERY",
  "API_CALL",
  "SYSLOG",
] as const;
