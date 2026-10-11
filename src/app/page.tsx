'use client'

import Link from 'next/link'
import { Badge, Card, ErrorBox, Loading, Notice, formatDate, statusTone, useApi } from '@/components/ui'
import type { StatusResponse } from '@/lib/types'

export default function DashboardPage() {
  const { data, error, loading } = useApi<StatusResponse>('/api/status')

  return (
    <>
      <div className="page-header">
        <h1>Dashboard</h1>
        <p>An overview of your LegendKeeper connection, your local resource index, and recent work. Counts come from local data and the last scan.</p>
      </div>
      <ErrorBox error={error} />
      {loading && !data && <Loading />}
      {data && <Dashboard data={data} />}
    </>
  )
}

function Dashboard({ data }: { data: StatusResponse }) {
  const lk = data.connection.legendkeeper
  const check = lk.lastCheck
  const stats = data.index.stats
  const imports = data.imports
  const openImports = (imports.extracted ?? 0) + (imports.drafted ?? 0) + (imports.failed ?? 0)

  return (
    <>
      {!lk.keyConfigured && (
        <Notice tone="warning">
          <strong>LegendKeeper is not configured yet.</strong> Add <code>LEGENDKEEPER_API_KEY</code> to <code>.env.local</code> (see the README), or enter a key for this session on the{' '}
          <Link href="/settings">Settings</Link> page.
        </Notice>
      )}

      <div className="grid grid-2">
        <Card title="LegendKeeper connection" actions={<Link href="/connection">Open</Link>}>
          {check?.ok && check.project ? (
            <p>
              <Badge tone="good">Connected</Badge> <strong>{check.project.name}</strong> <code className="small">{check.project.id}</code>
              <br />
              <span className="muted small">Checked {formatDate(check.checkedAt)}</span>
            </p>
          ) : check && !check.ok ? (
            <p>
              <Badge tone="bad">Failed</Badge> {check.error?.message}
            </p>
          ) : lk.knownProject ? (
            <p>
              <Badge>Not tested this session</Badge> Last known project: <strong>{lk.knownProject.name}</strong>
            </p>
          ) : (
            <p>
              <Badge>Not connected yet</Badge> Check the API key on the Connection page.
            </p>
          )}
          <p className="muted small">SDK @legendkeeper/sdk {lk.sdkVersion}</p>
        </Card>

        <Card title="Writing to LegendKeeper" actions={<Link href="/connection#writes">Details</Link>}>
          {data.writeBlockers.length === 0 ? (
            <p>
              <Badge tone="good">Enabled</Badge> Single-page creation is verified and switched on. Every write still needs your explicit approval.
            </p>
          ) : (
            <>
              <p>
                <Badge tone="warn">Disabled</Badge> Page creation is off until:
              </p>
              <ul className="small">
                {data.writeBlockers.map((b) => (
                  <li key={b.code}>{b.message}</li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>

      <div className="grid grid-3" style={{ marginBottom: '1rem' }}>
        <Stat label="Resources in local index" value={stats?.total ?? '—'} hint={data.index.lastCompleted ? `Scanned ${formatDate(data.index.lastCompleted.finishedAt)}` : 'No complete scan yet'} />
        <Stat label="Pages without tags" value={stats && stats.total > 0 ? stats.untagged : '—'} hint={<Link href="/tags">Tag audit</Link>} />
        <Stat label="Distinct tags" value={stats && stats.total > 0 ? stats.distinctTags : '—'} />
        <Stat label="Open imports" value={openImports} hint={<Link href="/import">Import studio</Link>} />
        <Stat label="Pages created by this app" value={data.pagesCreated} />
        <Stat label="Saved recipes" value={data.recipes} hint={<Link href="/recipes">Recipes</Link>} />
      </div>

      <div className="grid grid-2">
        <Card title="AI processing" actions={<Link href="/settings">Settings</Link>}>
          <p>
            {data.connection.ai.enabled && data.connection.ai.keyConfigured ? (
              <Badge tone="good">On</Badge>
            ) : data.connection.ai.enabled ? (
              <Badge tone="warn">No API key</Badge>
            ) : (
              <Badge>Off</Badge>
            )}{' '}
            Model <code>{data.connection.ai.model}</code>, effort {data.connection.ai.effort}
          </p>
          <p className="muted small">Without AI you can still browse, audit tags and use structural (no-AI) imports.</p>
        </Card>
        <Card title="Recent activity" actions={<Link href="/history">All history</Link>}>
          {data.recentActivity.length === 0 ? (
            <p className="muted">Nothing yet.</p>
          ) : (
            <ul className="small" style={{ paddingLeft: '1.1rem', margin: 0 }}>
              {data.recentActivity.map((event) => (
                <li key={event.id}>
                  <Badge tone={statusTone(event.outcome)}>{event.outcome}</Badge> <code>{event.operation}</code> {event.message} <span className="muted">· {formatDate(event.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
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
