import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image
  output: "standalone",
  // The repo root also has a package-lock.json; pin the root so Turbopack
  // doesn't infer the NestJS project as this app's workspace.
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
