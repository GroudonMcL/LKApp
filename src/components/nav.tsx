'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/import', label: 'Import' },
  { href: '/review', label: 'Review queue' },
  { href: '/assistant', label: 'Task Assistant' },
  { href: '/search', label: 'Search' },
  { href: '/pages', label: 'Page browser' },
  { href: '/relationships', label: 'Relationships' },
  { href: '/health', label: 'Wiki Health' },
  { href: '/tagging', label: 'Tagging assistant' },
  { href: '/tags', label: 'Tag audit' },
  { href: '/chronology', label: 'Chronology' },
  { href: '/knowledge', label: 'Knowledge analysis' },
  { href: '/migrations', label: 'Template migration' },
  { href: '/recipes', label: 'Recipes & templates' },
  { href: '/batches', label: 'Batch jobs' },
  { href: '/history', label: 'History & audit' },
  { href: '/connection', label: 'Connection' },
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
          <div className="muted small">Runs on this computer</div>
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
