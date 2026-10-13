'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Badge, Card, ErrorBox, Loading, More, formatDate, statusTone, useApi } from '@/components/ui'
import type { StatusResponse } from '@/lib/types'
import { WelcomeSetup } from '@/components/welcome-setup'

interface ReviewItem {
  key: string
  type: string
  severity: 'high' | 'medium' | 'low'
  title: string
  explanation: string
  href: string
}

const SEVERITY_TONE = { high: 'bad', medium: 'warn', low: 'neutral' } as const

export default function DashboardPage() {
  const { data, error, loading, reload } = useApi<StatusResponse>('/api/status')
  return (
    <>
      <div className="dash-header">
        <h1>Dashboard</h1>
        {data && <StatusIcons data={data} />}
      </div>
      <ErrorBox error={error} />
      {loading && !data && <Loading />}
      {data && !data.connection.legendkeeper.keyConfigured && <WelcomeSetup onDone={() => void reload()} />}
      <div className="dash-top">
        <AssistantBox />
        <SearchBox />
      </div>
      <div className="dash">
        <div>
          <Tools data={data} />
          {data && <AtAGlance data={data} />}
        </div>
        <ReviewColumn total={data?.review.total ?? null} high={data?.review.high ?? 0} />
      </div>
    </>
  )
}

function StatusIcons({ data }: { data: StatusResponse }) {
  const lk = data.connection.legendkeeper
  const check = lk.lastCheck
  const lkState = check?.ok ? 'good' : check && !check.ok ? 'bad' : 'warn'
  const lkLabel = check?.ok && check.project ? check.project.name : check && !check.ok ? 'Not connected' : lk.knownProject?.name ?? 'Not checked yet'
  const ai = data.connection.ai
  const aiState = ai.enabled && ai.keyConfigured ? 'good' : ai.enabled ? 'warn' : 'bad'
  return (
    <>
      <Link className={`status-dot ${aiState}`} href="/settings" title={`AI: ${ai.enabled ? (ai.keyConfigured ? `on (${ai.model})` : 'no API key') : 'off'}`}>
        AI
      </Link>
      <Link className={`status-dot ${lkState}`} href="/connection" title={`LegendKeeper: ${lkLabel}${data.writeBlockers.length ? ' · writing is off' : ''}`}>
        {lkLabel}
      </Link>
    </>
  )
}

function AssistantBox() {
  const router = useRouter()
  const [task, setTask] = useState('')
  return (
    <Card title="Task Assistant">
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault()
          router.push(task.trim() ? `/assistant?task=${encodeURIComponent(task.trim())}` : '/assistant')
        }}
      >
        <input type="text" value={task} onChange={(e) => setTask(e.target.value)} placeholder="e.g. Find untagged NPC pages in Saltreach" aria-label="Task" />
        <button type="submit" className="btn btn-primary">
          Make a plan
        </button>
      </form>
    </Card>
  )
}

function SearchBox() {
  const router = useRouter()
  const [q, setQ] = useState('')
  return (
    <Card title="Search">
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault()
          router.push(q.trim() ? `/search?q=${encodeURIComponent(q.trim())}` : '/search')
        }}
      >
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="A page name or alias" aria-label="Search" />
        <button type="submit" className="btn btn-primary">
          Search
        </button>
      </form>
    </Card>
  )
}

function Tools({ data }: { data: StatusResponse | null }) {
  const stats = data?.index.stats
  const openImports = data ? (data.imports.extracted ?? 0) + (data.imports.drafted ?? 0) + (data.imports.failed ?? 0) : 0
  const tools: { href: string; label: string; hint: string; count?: number | null }[] = [
    { href: '/import', label: 'Import', hint: 'Files, web pages or text into pages', count: openImports || null },
    { href: '/pages', label: 'Page browser', hint: 'Browse and scan your project', count: stats?.total ?? null },
    { href: '/relationships', label: 'Relationships', hint: 'How pages connect, as a map' },
    { href: '/health', label: 'Wiki Health', hint: 'Audit pages for problems' },
    { href: '/tagging', label: 'Tagging assistant', hint: 'Suggest and apply tags' },
    { href: '/tags', label: 'Tag audit', hint: 'Untagged pages and tag spelling', count: stats && stats.total > 0 ? stats.untagged : null },
    { href: '/chronology', label: 'Chronology', hint: 'Dated events and timelines' },
    { href: '/knowledge', label: 'Knowledge analysis', hint: 'Contradictions, missing pages' },
    { href: '/migrations', label: 'Template migration', hint: 'Move old pages to a new layout' },
    { href: '/recipes', label: 'Recipes & templates', hint: 'Page kinds and layouts', count: data?.recipes ?? null },
    { href: '/batches', label: 'Batch jobs', hint: 'Every batch and its results' },
    { href: '/settings', label: 'Settings', hint: 'AI, keys and updates' },
  ]
  return (
    <Card title="Tools">
      <div className="tool-grid">
        {tools.map((tool) => (
          <Link key={tool.href} className="tool" href={tool.href}>
            {tool.count !== undefined && tool.count !== null && <span className="count">{tool.count}</span>}
            <strong>{tool.label}</strong>
            <span>{tool.hint}</span>
          </Link>
        ))}
      </div>
    </Card>
  )
}

function AtAGlance({ data }: { data: StatusResponse }) {
  const stats = data.index.stats
  return (
    <More label="Project at a glance">
      <div className="grid grid-3" style={{ marginBottom: '1rem' }}>
        <Stat label="Resources in local index" value={stats?.total ?? '—'} hint={data.index.lastCompleted ? `Scanned ${formatDate(data.index.lastCompleted.finishedAt)}` : 'No complete scan yet'} />
        <Stat label="Pages without tags" value={stats && stats.total > 0 ? stats.untagged : '—'} />
        <Stat label="Distinct tags" value={stats && stats.total > 0 ? stats.distinctTags : '—'} />
        <Stat label="Pages created by this app" value={data.pagesCreated} />
      </div>
      <p className="small">
        Writing to LegendKeeper:{' '}
        {data.writeBlockers.length === 0 ? (
          <>
            <Badge tone="good">On</Badge> every write still needs your approval.
          </>
        ) : (
          <>
            <Badge tone="warn">Off</Badge> {data.writeBlockers.map((b) => b.message).join(' ')}
          </>
        )}
      </p>
      <p className="small">
        AI: {data.connection.ai.provider === 'openrouter' ? 'OpenRouter, free models only' : 'Anthropic Claude'} · <code>{data.connection.ai.model}</code> · SDK @legendkeeper/sdk{' '}
        {data.connection.legendkeeper.sdkVersion}
      </p>
      {data.recentActivity.length > 0 && (
        <>
          <h3>Recent activity</h3>
          <ul className="queue-list">
            {data.recentActivity.map((event) => (
              <li key={event.id}>
                <Badge tone={statusTone(event.outcome)}>{event.outcome}</Badge> {event.message ?? event.operation} <span className="muted small">· {formatDate(event.at)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </More>
  )
}

function ReviewColumn({ total, high }: { total: number | null; high: number }) {
  const { data, error } = useApi<{ items: ReviewItem[]; total: number }>('/api/review')
  const items = data?.items.slice(0, 8) ?? []
  return (
    <Card
      title={
        <>
          Review queue {total !== null && <Badge tone={high ? 'bad' : total ? 'warn' : 'good'}>{total}</Badge>}
        </>
      }
      actions={
        <Link href="/review" className="btn btn-ghost" title="Open the review queue">
          Expand ⤢
        </Link>
      }
    >
      <ErrorBox error={error} />
      {!data && !error && <Loading />}
      {data && items.length === 0 && <p className="muted">Nothing is waiting for you.</p>}
      {items.length > 0 && (
        <ul className="queue-list">
          {items.map((item) => (
            <li key={item.key}>
              <Badge tone={SEVERITY_TONE[item.severity]}>{item.severity}</Badge> <Link href={item.href}>{item.title}</Link>
              <div className="muted small">{item.explanation}</div>
            </li>
          ))}
        </ul>
      )}
      {data && data.total > items.length && (
        <p className="small">
          <Link href="/review">and {data.total - items.length} more…</Link>
        </p>
      )}
      <div style={{ borderTop: '1px solid var(--border)', marginTop: '0.75rem', paddingTop: '0.75rem' }}>
        <Link href="/history" className="btn">
          History &amp; audit
        </Link>
      </div>
    </Card>
  )
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="stat">
      <div className="value">{value}</div>
      <div className="label">{label}</div>
      {hint && <div className="small muted">{hint}</div>}
    </div>
  )
}
