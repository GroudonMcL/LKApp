'use client'

import { useState } from 'react'
import { Badge, Button, Card, ErrorBox, KeyValue, Loading, Notice, useAction, useApi } from '@/components/ui'
import { api } from '@/lib/api'
import type { ConnectionSummary, UpdateStatus } from '@/lib/types'
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
        <p>
          Your API keys and the AI choice are saved in a settings file on this computer when you press <em>Save on this computer</em>. Other options are described in
          the README.
        </p>
      </div>
      <ErrorBox error={error ?? action.error} />
      {loading && !data && <Loading />}
      {data && (
        <>
          <Card title="AI processing">
            <p>
              {data.ai.enabled ? <Badge tone="good">On</Badge> : <Badge>Off</Badge>} Using{' '}
              <strong>{data.ai.provider === 'openrouter' ? 'OpenRouter (free models only)' : 'Anthropic (Claude)'}</strong> · model <code>{data.ai.model}</code> · key{' '}
              {data.ai.keyConfigured ? <Badge tone="good">{data.ai.keySource === 'memory' ? 'this session' : 'saved'}</Badge> : <Badge tone="warn">not set</Badge>}
              {data.ai.provider === 'anthropic' && <> · effort {data.ai.effort}</>}
            </p>
            <div className="row">
              <span className="small">AI service:</span>
              <label className="check">
                <input type="radio" name="provider" checked={data.ai.provider === 'openrouter'} disabled={action.busy} onChange={() => post({ action: 'setAiProvider', provider: 'openrouter', persist: true })} />
                <span>OpenRouter, free models {data.ai.openrouter.keyConfigured ? '' : '(no key)'}</span>
              </label>
              <label className="check">
                <input type="radio" name="provider" checked={data.ai.provider === 'anthropic'} disabled={action.busy} onChange={() => post({ action: 'setAiProvider', provider: 'anthropic', persist: true })} />
                <span>Anthropic Claude {data.ai.anthropic.keyConfigured ? '' : '(no key)'}</span>
              </label>
              {data.ai.providerSource !== 'default' && (
                <Button variant="ghost" busy={action.busy} onClick={() => post({ action: 'setAiProvider', provider: null, persist: true })}>
                  Back to the default choice
                </Button>
              )}
            </div>
            <p className="small muted">
              The choice is saved on this computer. By default, OpenRouter is used whenever its key is set.
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

          <Card title="API keys">
            <p className="small">
              <strong>Save on this computer</strong> keeps a key in your settings file (<code>{data.local.settingsFile}</code>), so you enter it once. It is never stored in
              the app&apos;s database, shown again, logged or sent anywhere except to its own service. Anyone who can read your user files can read that file, so keep your
              computer account private. <strong>Use for this session only</strong> keeps the key in memory until the app is closed.
            </p>
            <KeyForm label="LegendKeeper API key" kind="legendkeeper" source={data.legendkeeper.keySource} busy={action.busy} post={post} />
            <KeyForm label="OpenRouter API key (free AI models)" kind="openrouter" source={data.ai.openrouter.keySource} busy={action.busy} post={post} />
            <KeyForm label="Anthropic API key (Claude, paid)" kind="anthropic" source={data.ai.anthropic.keySource} busy={action.busy} post={post} />
          </Card>

          <Card title="Where your data is kept">
            <KeyValue
              rows={[
                ['Settings file (keys, AI choice)', <code key="s">{data.local.settingsFile}</code>],
                ['Database and backups folder', <code key="d">{data.local.dataFolder}</code>],
                ['Installed as', data.local.packaged ? 'the Windows package (your data stays when you update the app)' : 'the source folder'],
              ]}
            />
            <p className="small muted">To back up everything, copy the database folder while the app is closed. Your LegendKeeper project itself lives on LegendKeeper.</p>
          </Card>

          <UpdatesCard />

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

function UpdatesCard() {
  const status = useApi<UpdateStatus>('/api/update')
  const action = useAction()
  const data = status.data
  return (
    <Card title="Updates">
      <ErrorBox error={status.error ?? action.error} />
      {data && (
        <>
          <KeyValue
            rows={[
              ['This version', `${data.current.version}, build ${data.current.build || 'local'}${data.current.commit ? ` (${data.current.commit.slice(0, 7)})` : ''}`],
              ['Latest published', data.latest ? `build ${data.latest.build}${data.latest.publishedAt ? `, ${new Date(data.latest.publishedAt).toLocaleDateString('en-GB')}` : ''}` : data.current.packaged ? 'not known yet' : '—'],
              ['Last checked', data.checkedAt ? new Date(data.checkedAt).toLocaleString('en-GB') : 'not yet'],
            ]}
          />
          {data.note && <Notice>{data.note}</Notice>}
          {data.error && <Notice tone="warning">{data.error}</Notice>}
          {data.current.packaged && (
            <>
              {data.available || data.staged ? (
                <Notice tone="info">A new version is available: use the banner at the top of the page to install it.</Notice>
              ) : data.latest ? (
                <p className="small">You have the latest version.</p>
              ) : null}
              <div className="row">
                <Button busy={action.busy} onClick={() => void action.run(async () => status.setData(await api.get<UpdateStatus>('/api/update?refresh=1')))}>
                  Check now
                </Button>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={data.checksEnabled}
                  onChange={(e) => void action.run(async () => { await api.post('/api/update', { action: 'setChecks', enabled: e.target.checked }); await status.reload() })}
                />
                <span>Check for a new version when the app starts (at most every 6 hours)</span>
              </label>
              <p className="small muted">
                Checking asks GitHub (<code>{data.source}</code>) for the latest published version; nothing about you or your data is sent. An update is downloaded only when you
                press <strong>Update now</strong>, checked against its published SHA-256 checksum, and installed by restarting. Your settings and data are kept.
              </p>
            </>
          )}
        </>
      )}
    </Card>
  )
}

function KeyForm({ label, kind, source, busy, post }: { label: string; kind: string; source: string | null; busy: boolean; post: (body: unknown) => void }) {
  const [value, setValue] = useState('')
  const save = (persist: boolean) => {
    if (!value.trim()) return
    post({ action: 'setKey', kind, value: value.trim(), persist })
    setValue('')
  }
  return (
    <form
      className="field"
      onSubmit={(e) => {
        e.preventDefault()
        save(true)
      }}
    >
      <label htmlFor={`key-${kind}`}>
        {label}{' '}
        <span className="hint">currently: {source === 'memory' ? 'set for this session only' : source === 'env' ? 'saved' : 'not set'}</span>
      </label>
      <div className="row">
        <input id={`key-${kind}`} type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} style={{ maxWidth: '28rem' }} placeholder={source ? 'Enter a new key to replace it' : 'Paste the key here'} />
        <Button type="submit" variant="primary" busy={busy} disabled={!value.trim()}>
          Save on this computer
        </Button>
        <Button busy={busy} disabled={!value.trim()} onClick={() => save(false)}>
          Use for this session only
        </Button>
        {source === 'memory' && (
          <Button variant="ghost" onClick={() => post({ action: 'clearKey', kind })}>
            Forget session key
          </Button>
        )}
        {source === 'env' && (
          <Button variant="ghost" onClick={() => post({ action: 'clearKey', kind, persist: true })}>
            Remove saved key
          </Button>
        )}
      </div>
    </form>
  )
}
