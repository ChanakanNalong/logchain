import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image
  output: "standalone",
  // Always inline the mock switch (src/lib/endpoints.ts). An unset NEXT_PUBLIC_*
  // is not replaced at build time, so the mock branch would survive as a
  // lazily-loaded chunk; pinning it to "0" lets the bundler drop it entirely.
  env: {
    NEXT_PUBLIC_USE_MOCK: process.env.NEXT_PUBLIC_USE_MOCK === "1" ? "1" : "0",
  },
  // The repo root also has a package-lock.json; pin the root so Turbopack
  // doesn't infer the NestJS project as this app's workspace.
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
