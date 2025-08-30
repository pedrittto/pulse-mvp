/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: true,
  // Keep build stable; Turbopack sometimes trips in workspaces on Windows
  webpack: (config: any) => config,
};
export default nextConfig;


