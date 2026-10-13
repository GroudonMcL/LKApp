'use client'

import Link from 'next/link'
import { useState } from 'react'
import { Badge, Button, Card, ErrorBox, KeyValue, Loading, More, Notice, formatDate, useAction, useApi } from '@/components/ui'
import { api } from '@/lib/api'
import type { ConnectionCheck, ConnectionSummary } from '@/lib/types'

export default function ConnectionPage() {
  const { data, error, loading, setData } = useApi<ConnectionSummary>('/api/connection')
  const test = useAction()
  const [check, setCheck] = useState<ConnectionCheck | null>(null)

  const runTest = () =>
    test.run(async () => {
      const result = await api.post<{ check: ConnectionCheck; summary: ConnectionSummary }>('/api/connection')
      setCheck(result.check)
      setData(result.summary)
    })

  const lastCheck = check ?? data?.legendkeeper.lastCheck ?? null

  return (
    <>
      <div className="page-header">
        <h1>LegendKeeper connection</h1>
        <p className="lead">Your link to LegendKeeper, tested automatically.</p>
        <More>
          <p className="small">
            All LegendKeeper calls are made by this app’s server using the official SDK. Your browser never sees the API key. The connection is tested automatically (read-only) when
          you open the app, and again every 10 minutes while you use it.
          </p>
        </More>
      </div>
      <ErrorBox error={error} />
      {loading && !data && <Loading />}
      {data && (
        <>
          <Card title="Connection" actions={<Button variant="primary" onClick={runTest} busy={test.busy} disabled={!data.legendkeeper.keyConfigured}>Test again</Button>}>
            <KeyValue
              rows={[
                ['API key', data.legendkeeper.keyConfigured ? <Badge tone="good">Configured ({data.legendkeeper.keySource === 'memory' ? 'this session only' : '.env.local'})</Badge> : <Badge tone="bad">Not configured</Badge>],
                ['Server', <code key="u">{data.legendkeeper.baseUrl}</code>],
                ['SDK', <code key="s">@legendkeeper/sdk {data.legendkeeper.sdkVersion}</code>],
              ]}
            />
            <ErrorBox error={test.error} title="Connection test failed" />
            {lastCheck && (
              <div style={{ marginTop: '0.75rem' }}>
                {lastCheck.ok && lastCheck.project ? (
                  <Notice tone="success">
                    Connected to <strong>{lastCheck.project.name}</strong> — project ID <code>{lastCheck.project.id}</code>
                    {lastCheck.project.createdAt && <> · created {formatDate(lastCheck.project.createdAt)}</>}
                    <br />
                    <span className="small">Checked {formatDate(lastCheck.checkedAt)}</span>
                  </Notice>
                ) : (
                  <Notice tone="error">
                    <strong>Could not connect.</strong> {lastCheck.error?.message}
                    {lastCheck.error?.requestId && (
                      <div className="small">
                        Request ID <code>{lastCheck.error.requestId}</code>
                      </div>
                    )}
                  </Notice>
                )}
              </div>
            )}
          </Card>

          <WriteAccess summary={data} />
          <KeyHelp />
        </>
      )}
    </>
  )
}

function WriteAccess({ summary }: { summary: ConnectionSummary }) {
  const verify = useAction()
  const [confirm, setConfirm] = useState(false)
  const [result, setResult] = useState<{ resourceId: string; name: string; sandbox: { id: string; name: string } } | null>(null)
  const writes = summary.writes

  return (
    <Card title={<span id="writes">Write access</span>}>
      <p>
        The app creates <strong>one page at a time</strong>, and only after you approve the exact content in the final preview. It never edits, moves or deletes existing pages.
      </p>
      <KeyValue
        rows={[
          [
            'Creating pages',
            writes.allowedByConfig ? (
              <Badge tone="good">on</Badge>
            ) : (
              <>
                <Badge tone="warn">off</Badge> <span className="small">(<code>LKC_ALLOW_WRITES=false</code> in <code>.env.local</code>; remove it and restart to switch on)</span>
              </>
            ),
          ],
          [
            'Confirmed working in this project',
            writes.verification ? (
              <>
                <Badge tone="good">yes, {formatDate(writes.verification.verifiedAt)}</Badge> (page <Link href={`/pages/${writes.verification.resourceId}`}>{writes.verification.resourceId}</Link>)
              </>
            ) : (
              <span className="small">not yet — the first page you approve confirms it</span>
            ),
          ],
          ['Per recipe', 'Each recipe has “Allow creation after approval” (on by default).'],
        ]}
      />

      {writes.sandboxParentId && (
        <details style={{ marginTop: '0.75rem' }}>
          <summary>Optional: test with a throwaway page first</summary>
          <p>
            Creates one page called “LK Companion write check …” under your sandbox page (<code>{writes.sandboxParentId}</code>) and reads it back. The test page is left in place;
            delete it in LegendKeeper whenever you like.
          </p>
          <label className="check">
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
            <span>I understand this creates one test page in my LegendKeeper project, under the sandbox page.</span>
          </label>
          <div className="row" style={{ marginTop: '0.5rem' }}>
            <Button
              disabled={!confirm || !writes.allowedByConfig}
              busy={verify.busy}
              onClick={() =>
                verify.run(async () => {
                  setResult(await api.post('/api/connection/verify-write', { confirm: true }))
                  setConfirm(false)
                })
              }
            >
              Run write check
            </Button>
          </div>
          <ErrorBox error={verify.error} title="Write check failed" />
          {result && (
            <Notice tone="success">
              Write check passed. Created <Link href={`/pages/${result.resourceId}`}>{result.name}</Link> under “{result.sandbox.name}” and read it back successfully.
            </Notice>
          )}
        </details>
      )}
    </Card>
  )
}

function KeyHelp() {
  return (
    <Card title="Creating an API key">
      <ol>
        <li>Open your project in LegendKeeper and go to <strong>Project Settings → Developers → API Keys</strong>. You need the ADMIN role to create keys.</li>
        <li>Name the key (e.g. “LK Companion”), choose its role, and create it. The secret is shown <strong>once</strong>: copy it then.</li>
        <li>
          Put it in <code>.env.local</code> as <code>LEGENDKEEPER_API_KEY=lk_…</code> and restart the app.
        </li>
      </ol>
      <ul className="small">
        <li>API keys need the project owner to be on a <strong>paid plan</strong> (a trial does not count).</li>
        <li>
          A key belongs to one project and acts as the user who created it, with the <em>lower</em> of the key’s role and that user’s current role.
        </li>
        <li>
          A <strong>MEMBER</strong> key is enough for reading. An <strong>ADMIN</strong> key is needed for the live tag list and for creating pages at the top level of the project tree.
          Pages created under a parent you can edit work with either.
        </li>
      </ul>
    </Card>
  )
}
