import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export consumed by Tauri (src-tauri expects frontendDist: "../out").
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;
