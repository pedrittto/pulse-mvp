/** @type {import('next').NextConfig} */

const isDev = process.env.NODE_ENV !== 'production';

const nextConfig = {
  // App Router is now stable in Next.js 14, no need for experimental flag
  async rewrites() {
    if (isDev) {
      return [{ source: '/api/:path*', destination: 'http://localhost:4000/:path*' }];
    }
    return [];
  },
}

module.exports = nextConfig
