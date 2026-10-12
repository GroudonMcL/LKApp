'use client'

import { useState } from 'react'
import { Badge, Button, Card, ErrorBox, KeyValue, Loading, Notice, useAction, useApi } from '@/components/ui'
import { api } from '@/lib/api'
import type { ConnectionSummary } from '@/lib/types'
import type { OpenRouterStatus } from '@/server/services/ai-status'

type SettingsView = ConnectionSummary & { openrouterStatus: OpenRouterStatus | null }

export default function SettingsPage() {
  const { data, error, loading, setData } = useApi<SettingsView>('/api/settings')
  const action = useAction()
  const post = (body: unknown) => action.run(async () => setData(await api.post<SettingsView>('/api/settings', body)))

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
              {data.ai.enabled ? <Badge tone="good">On</Badge> : <Badge>Off</Badge>} Using{' '}
              <strong>{data.ai.provider === 'openrouter' ? 'OpenRouter (free models only)' : 'Anthropic (Claude)'}</strong> · model <code>{data.ai.model}</code> · key{' '}
              {data.ai.keyConfigured ? <Badge tone="good">{data.ai.keySource === 'memory' ? 'this session' : '.env.local'}</Badge> : <Badge tone="warn">not set</Badge>}
              {data.ai.provider === 'anthropic' && <> · effort {data.ai.effort}</>}
            </p>
            <div className="row">
              <span className="small">AI service:</span>
              <label className="check">
                <input type="radio" name="provider" checked={data.ai.provider === 'openrouter'} disabled={action.busy} onChange={() => post({ action: 'setAiProvider', provider: 'openrouter' })} />
                <span>OpenRouter, free models {data.ai.openrouter.keyConfigured ? '' : '(no key)'}</span>
              </label>
              <label className="check">
                <input type="radio" name="provider" checked={data.ai.provider === 'anthropic'} disabled={action.busy} onChange={() => post({ action: 'setAiProvider', provider: 'anthropic' })} />
                <span>Anthropic Claude {data.ai.anthropic.keyConfigured ? '' : '(no key)'}</span>
              </label>
              {data.ai.providerSource === 'settings' && (
                <Button variant="ghost" busy={action.busy} onClick={() => post({ action: 'setAiProvider', provider: null })}>
                  Back to the .env.local choice
                </Button>
              )}
            </div>
            <p className="small muted">
              The choice made here lasts until the app restarts. To make it permanent, set <code>LKC_AI_PROVIDER=openrouter</code> or <code>anthropic</code> in .env.local. Without that,
              OpenRouter is used whenever its key is set.
            </p>
            {data.ai.provider === 'openrouter' && (
              <>
                <h3>OpenRouter: free models only</h3>
                <ul className="small">
                  <li>
                    Only <code>openrouter/free</code> (OpenRouter picks an available free model) or a model whose id ends in <code>:free</code> is accepted, and only if OpenRouter
                    lists it at a price of 0. Change the model with <code>LKC_OPENROUTER_MODEL</code>.
                  </li>
                  <li>Every request tells OpenRouter that the most it may cost is 0, so it is never sent to a paid model; every reply’s reported cost is checked to be 0.</li>
                  <li>Free models are slower and less consistent than Claude; their replies are still checked against the source like any AI result.</li>
                </ul>
                {data.openrouterStatus && (
                  <KeyValue
                    rows={[
                      ['Free requests today', data.openrouterStatus.freeRequestsToday ? `${data.openrouterStatus.freeRequestsToday.remaining} of ${data.openrouterStatus.freeRequestsToday.limit} left (each AI step on one record or page is one request; a retry is another)` : (data.openrouterStatus.error ?? 'unknown')],
                      ['Spending limit on the key', data.openrouterStatus.limitUsd === null ? 'none set — set one of $0 in OpenRouter to be doubly sure' : `$${data.openrouterStatus.limitUsd}`],
                      ['Account', data.openrouterStatus.isFreeTier ? 'free tier (no credits bought)' : data.openrouterStatus.isFreeTier === false ? 'has credits' : 'unknown'],
                    ]}
                  />
                )}
                <Notice tone="warning">
                  Free models on OpenRouter may log the text you send and may use it to improve their models, depending on the model provider and your OpenRouter privacy
                  settings. Don’t send anything you want to keep private; use the structural (no-AI) options or an Anthropic key for that.
                </Notice>
              </>
            )}
            {data.ai.disabledByEnv ? (
              <Notice>AI is switched off by <code>LKC_AI_ENABLED=false</code>. Change it in .env.local and restart to switch it on.</Notice>
            ) : (
              <Button busy={action.busy} onClick={() => post({ action: 'setAiEnabled', enabled: !data.ai.enabled })}>
                {data.ai.enabled ? 'Switch AI off' : 'Switch AI on'}
              </Button>
            )}
            <h3>What is sent to the AI service</h3>
            <ul className="small">
              <li>Only when you choose an AI option (AI drafting, transcribing an image, AI tag suggestions, AI migration drafting) — never automatically.</li>
              <li>The text of the records or pages you selected, the recipe’s instructions and field list, the template’s section headings, and the names of your existing tags.</li>
              <li>Never your API keys, and never pages you did not select.</li>
              <li>With AI switched off, browsing, audits, rule-based tagging and structural (no-AI) imports and migrations still work.</li>
            </ul>
          </Card>

          <Card title="API keys for this session">
            <Notice tone="warning">
              Keys entered here are kept <strong>in this server’s memory only</strong>: not saved to disk, not stored in the database, never shown again, and forgotten when the app
              restarts. For a permanent setup, put them in <code>.env.local</code> instead. A key entered here takes priority over the one in .env.local until you clear it.
            </Notice>
            <KeyForm label="LegendKeeper API key" kind="legendkeeper" source={data.legendkeeper.keySource} busy={action.busy} onSave={(value) => post({ action: 'setKey', kind: 'legendkeeper', value })} onClear={() => post({ action: 'clearKey', kind: 'legendkeeper' })} />
            <KeyForm label="OpenRouter API key" kind="openrouter" source={data.ai.openrouter.keySource} busy={action.busy} onSave={(value) => post({ action: 'setKey', kind: 'openrouter', value })} onClear={() => post({ action: 'clearKey', kind: 'openrouter' })} />
            <KeyForm label="Anthropic API key" kind="anthropic" source={data.ai.anthropic.keySource} busy={action.busy} onSave={(value) => post({ action: 'setKey', kind: 'anthropic', value })} onClear={() => post({ action: 'clearKey', kind: 'anthropic' })} />
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
