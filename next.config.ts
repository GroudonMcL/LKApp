import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The Windows package runs a self-contained server (`.next/standalone/server.js`) with its own
  // copy of Node.js; see scripts/package-windows.mjs. Normal builds are unchanged.
  ...(process.env.LKC_STANDALONE === '1' ? { output: 'standalone' as const } : {}),
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
