import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module; keep it out of the server bundle.
  serverExternalPackages: ['better-sqlite3'],
  // This is a private, local tool: no telemetry-style headers, no image optimisation service.
  poweredByHeader: false,
  images: { unoptimized: true },
  experimental: {
    // Uploads go through route handlers; keep server action bodies small.
    serverActions: { bodySizeLimit: '1mb' },
  },
}

export default nextConfig
