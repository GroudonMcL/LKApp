'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/connection', label: 'Connection' },
  { href: '/pages', label: 'Page browser' },
  { href: '/import', label: 'Import studio' },
  { href: '/batches', label: 'Batch jobs' },
  { href: '/recipes', label: 'Recipes & templates' },
  { href: '/health', label: 'Wiki Health' },
  { href: '/tagging', label: 'Tagging assistant' },
  { href: '/tags', label: 'Tag audit' },
  { href: '/history', label: 'History & audit' },
  { href: '/settings', label: 'Settings' },
]

export function Nav() {
  const pathname = usePathname()
  return (
    <nav className="nav" aria-label="Main">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          ✦
        </span>
        <div>
          <strong>LK Companion</strong>
          <div className="muted small">Phase 2 · local only</div>
        </div>
      </div>
      <ul>
        {LINKS.map((link) => {
          const active = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href)
          return (
            <li key={link.href}>
              <Link href={link.href} aria-current={active ? 'page' : undefined} className={active ? 'active' : undefined}>
                {link.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
