import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  poweredByHeader: false,
  images: { unoptimized: true },
  // Don't write AGENTS.md / CLAUDE.md into the project when the dev server starts.
  agentRules: false,
}

export default nextConfig
