#!/bin/bash
# Dedicated role + database for Keycloak (separate from the app database `logchain`).
# Runs once when the postgres container is first created (docker-entrypoint-initdb.d).
# Must sort before schema.sql, hence the 00- prefix.
#
# The keycloak role password comes from $KEYCLOAK_DB_PASSWORD (set in docker-compose
# from .env) — DEV-ONLY, never hardcode a production secret here.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE keycloak WITH LOGIN PASSWORD '${KEYCLOAK_DB_PASSWORD}';
  CREATE DATABASE keycloak OWNER keycloak;
  GRANT ALL PRIVILEGES ON DATABASE keycloak TO keycloak;
EOSQL
