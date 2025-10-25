import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  // If we add workspace packages later, enable and list them here:
  // transpilePackages: ['@repo/ui', '@repo/utils'],
};

export default nextConfig;


