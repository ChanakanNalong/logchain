# Cylis — LogChain Security Dashboard

Next.js (App Router) dashboard for the LogChain API gateway. Migrated from the
original React + Vite SPA; the UI, theme tokens and page contents are unchanged.

## Structure

```
src/
  app/
    layout.tsx          <html> shell, next/font (Manrope + JetBrains Mono), metadata
    providers.tsx       Keycloak init gate (replaces the old main.tsx bootstrap)
    page.tsx            renders <App />
    globals.css         resets that used to live in index.html
  App.tsx               sidebar, header, theme toggle, in-page view switching
  theme.ts              dark/light theme tokens + ThemeContext
  components/
    ui.tsx              Card, SectionLabel, Badge, Button, Th, Td
    LogTable.tsx        shared log table
  data/
    mockData.js         mock data (KPIs, dataset stats, ML metrics, RBAC, etc.)
  views/                the 7 dashboard views (Dashboard, Logs, MLDetection,
                        Dataset, Verify, Reports, Settings)
```

`views/` is deliberately *not* named `pages/` — with the App Router, a
`src/pages` directory would be picked up as the legacy Pages Router.

Imports use the `@/*` alias, which maps to `src/*`.

## Getting started

```bash
cp .env.local.example .env.local
npm install
npm run dev       # http://localhost:3003
npm run build     # production build
npm start         # serve the production build on :3003
```

## Environment

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | LogChain API base, e.g. `http://localhost:3000/api/v1` |
| `NEXT_PUBLIC_KEYCLOAK_URL` | Keycloak base URL |
| `NEXT_PUBLIC_KEYCLOAK_REALM` | Keycloak realm (`logchain`) |
| `NEXT_PUBLIC_KEYCLOAK_CLIENT_ID` | Public client id (`logchain-frontend`) |

These are inlined at **build** time, so the Docker image takes them as build
args (see `Dockerfile` / `docker-compose.yml`).

## Backend wiring

- Auth: `keycloak-js` with `onLoad: 'login-required'` + PKCE S256. The token is
  attached as `Authorization: Bearer …` by the axios interceptor in
  `src/lib/api.ts`, and refreshed 30s before expiry on every request.
- `views/Logs.tsx` → `GET /api/v1/logs` (roles: analyst / operator / admin)
- `views/Verify.tsx` → `GET /api/v1/logs/:id/proof`
- The API gateway must allow this origin: add `http://localhost:3003` to
  `ALLOWED_ORIGINS` in the repo-root `.env`.
- Keycloak client `logchain-frontend` needs `http://localhost:3003/*` in its
  valid redirect URIs and `http://localhost:3003` in web origins.

## Docker

```bash
docker compose up --build    # http://localhost:3003
```

The image is a Next standalone build served by `node server.js` (the old
nginx static-serve setup is gone, since Next ships its own server).
