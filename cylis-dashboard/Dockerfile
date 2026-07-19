# ---- Build stage ----
FROM node:20-alpine AS build
WORKDIR /app

# Install deps first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm install

# Copy source and build the production bundle
COPY . .
RUN npm run build

# ---- Serve stage ----
FROM nginx:1.27-alpine AS serve

# SPA-friendly nginx config (falls back to index.html for client-side routing)
COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
