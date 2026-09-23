# ---- Build stage ----
FROM node:20-alpine AS build
WORKDIR /app

# Install deps first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm ci

# NEXT_PUBLIC_* are inlined at build time, so they must be present here
ARG NEXT_PUBLIC_API_URL=http://localhost:3000/api/v1
ARG NEXT_PUBLIC_KEYCLOAK_URL=http://localhost:8080
ARG NEXT_PUBLIC_KEYCLOAK_REALM=logchain
ARG NEXT_PUBLIC_KEYCLOAK_CLIENT_ID=logchain-frontend
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_KEYCLOAK_URL=$NEXT_PUBLIC_KEYCLOAK_URL \
    NEXT_PUBLIC_KEYCLOAK_REALM=$NEXT_PUBLIC_KEYCLOAK_REALM \
    NEXT_PUBLIC_KEYCLOAK_CLIENT_ID=$NEXT_PUBLIC_KEYCLOAK_CLIENT_ID

# Copy source and build the standalone production server
COPY . .
RUN npm run build

# ---- Serve stage ----
FROM node:20-alpine AS serve
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# รันเป็น user `node` (uid 1000 มีใน node:alpine อยู่แล้ว) ไม่ใช่ root — compliance review 2026-09-23 B8
# --chown: Next.js เขียน .next/cache ตอนรัน (image optimization / ISR) ต้องเป็นเจ้าของ
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

USER node
EXPOSE 3000
CMD ["node", "server.js"]
