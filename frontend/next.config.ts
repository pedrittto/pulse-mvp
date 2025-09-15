/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: true,
  // Keep build stable; Turbopack sometimes trips in workspaces on Windows
  webpack: (config: any) => config,
  output: 'export',
  images: {
    unoptimized: true,
  },
  eslint: {
    // Allow production builds to complete with warnings for MVP
    ignoreDuringBuilds: true,
  },
};
export default nextConfig;


