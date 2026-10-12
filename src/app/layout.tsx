import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Nav } from '@/components/nav'
import { UpdateBanner } from '@/components/update-banner'
import './globals.css'

export const metadata: Metadata = {
  title: 'LK Companion',
  description: 'A private companion app for importing, organising and maintaining a LegendKeeper project.',
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <div className="shell">
          <Nav />
          <main id="main" className="main">
            <UpdateBanner />
            {children}
          </main>
        </div>
      </body>
    </html>
  )
}
