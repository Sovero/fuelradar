/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // NEXT_OUTPUT=standalone задаёт desktop/scripts/prepare-server.mjs — сборка
  // для встраивания в Electron (desktop/main.cjs запускает server.js сам).
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" } : {}),
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${process.env.API_INTERNAL_URL || 'http://127.0.0.1:8000'}/api/:path*` }];
  },
};

export default nextConfig;
