# LogChain API gateway (NestJS)
#
# node เวอร์ชันตาม .nvmrc (22.19.0) — package.json engines คือ
# ^20.19.0 || ^22.12.0 || >=23.0.0 เพราะ jwks-rsa@4 ลาก jose@6 ที่เป็น ESM-only
# node 18 จะตายตอน boot ด้วย ERR_REQUIRE_ESM

# ---- deps (prod only) ----
FROM node:22.19-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- build ----
FROM node:22.19-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:22.19-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

# wget มากับ busybox ของ alpine อยู่แล้ว — healthcheck ใน compose เรียกตัวนี้
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY package.json ./

USER node
EXPOSE 3000
CMD ["node", "dist/main"]
