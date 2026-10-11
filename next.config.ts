import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  poweredByHeader: false,
  images: { unoptimized: true },
  // Don't write AGENTS.md / CLAUDE.md into the project when the dev server starts.
  agentRules: false,
  // Document parsers are loaded from node_modules as they are, not re-bundled.
  serverExternalPackages: ['unpdf', 'mammoth'],
  experimental: {
    // The request guard (src/proxy.ts) makes Next.js buffer request bodies; without this,
    // bodies over 10 MB would be cut short. Batch uploads send one file per request, and a
    // document may be up to LKC_MAX_DOCUMENT_BYTES (25 MB by default).
    proxyClientMaxBodySize: '30mb',
  },
}

export default nextConfig
