'use client'

import { useState } from 'react'
import { Badge, Button, Card, ErrorBox, KeyValue, Loading, Notice, useAction, useApi } from '@/components/ui'
import { api } from '@/lib/api'
import type { ConnectionSummary } from '@/lib/types'

export default function SettingsPage() {
  const { data, error, loading, setData } = useApi<ConnectionSummary>('/api/settings')
  const action = useAction()
  const post = (body: unknown) => action.run(async () => setData(await api.post<ConnectionSummary>('/api/settings', body)))

  return (
    <>
      <div className="page-header">
        <h1>Settings</h1>
        <p>Most settings live in <code>.env.local</code> (see the README). The options below change only how this running app behaves.</p>
      </div>
      <ErrorBox error={error ?? action.error} />
      {loading && !data && <Loading />}
      {data && (
        <>
          <Card title="AI processing">
            <p>
              {data.ai.enabled ? <Badge tone="good">On</Badge> : <Badge>Off</Badge>} Model <code>{data.ai.model}</code> · effort {data.ai.effort} · key{' '}
              {data.ai.keyConfigured ? <Badge tone="good">{data.ai.keySource === 'memory' ? 'this session' : '.env.local'}</Badge> : <Badge tone="warn">not set</Badge>}
            </p>
            {data.ai.disabledByEnv ? (
              <Notice>AI is switched off by <code>LKC_AI_ENABLED=false</code>. Change it in .env.local and restart to switch it on.</Notice>
            ) : (
              <Button busy={action.busy} onClick={() => post({ action: 'setAiEnabled', enabled: !data.ai.enabled })}>
                {data.ai.enabled ? 'Switch AI off' : 'Switch AI on'}
              </Button>
            )}
            <h3>What is sent to the AI provider</h3>
            <ul className="small">
              <li>Only when you click “Run AI transformation” on an import.</li>
              <li>The source text of that one import, the recipe’s instructions and field list, the template’s section headings, and the names of your existing tags (not their pages).</li>
              <li>Never your API keys, never other pages’ content, and never anything automatically.</li>
              <li>With AI switched off, browsing, tag audits and structural (no-AI) imports still work.</li>
            </ul>
          </Card>

          <Card title="API keys for this session">
            <Notice tone="warning">
              Keys entered here are kept <strong>in this server’s memory only</strong>: not saved to disk, not stored in the database, never shown again, and forgotten when the app
              restarts. For a permanent setup, put them in <code>.env.local</code> instead. A key entered here takes priority over the one in .env.local until you clear it.
            </Notice>
            <KeyForm label="LegendKeeper API key" kind="legendkeeper" source={data.legendkeeper.keySource} busy={action.busy} onSave={(value) => post({ action: 'setKey', kind: 'legendkeeper', value })} onClear={() => post({ action: 'clearKey', kind: 'legendkeeper' })} />
            <KeyForm label="Anthropic API key" kind="anthropic" source={data.ai.keySource} busy={action.busy} onSave={(value) => post({ action: 'setKey', kind: 'anthropic', value })} onClear={() => post({ action: 'clearKey', kind: 'anthropic' })} />
          </Card>

          <Card title="Limits and safety">
            <KeyValue
              rows={[
                ['Largest upload', `${(data.limits.maxUploadBytes / 1_000_000).toFixed(1)} MB (LKC_MAX_UPLOAD_BYTES)`],
                ['Longest source per import', `${data.limits.maxSourceChars.toLocaleString('en-GB')} characters (LKC_MAX_SOURCE_CHARS)`],
                ['Writes', data.writes.allowedByConfig ? 'allowed by configuration (LKC_ALLOW_WRITES=true); each page still needs approval' : 'off (LKC_ALLOW_WRITES is not true)'],
                ['Sandbox parent', data.writes.sandboxParentId ?? 'not set'],
                ['Network', 'This app only answers requests from this computer (localhost).'],
              ]}
            />
          </Card>
        </>
      )}
    </>
  )
}

function KeyForm({ label, kind, source, busy, onSave, onClear }: { label: string; kind: string; source: string | null; busy: boolean; onSave: (value: string) => void; onClear: () => void }) {
  const [value, setValue] = useState('')
  return (
    <form
      className="field"
      onSubmit={(e) => {
        e.preventDefault()
        if (value.trim()) onSave(value.trim())
        setValue('')
      }}
    >
      <label htmlFor={`key-${kind}`}>
        {label}{' '}
        <span className="hint">
          currently: {source === 'memory' ? 'set for this session' : source === 'env' ? 'from .env.local' : 'not set'}
        </span>
      </label>
      <div className="row">
        <input id={`key-${kind}`} type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} style={{ maxWidth: '28rem' }} />
        <Button type="submit" busy={busy} disabled={!value.trim()}>
          Use for this session
        </Button>
        {source === 'memory' && (
          <Button variant="ghost" onClick={onClear}>
            Forget session key
          </Button>
        )}
      </div>
    </form>
  )
}
