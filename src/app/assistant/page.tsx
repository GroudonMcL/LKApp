'use client'

import Link from 'next/link'
import { useState } from 'react'
import { Badge, Button, Card, ErrorBox, Notice, useAction, useApi } from '@/components/ui'
import { api } from '@/lib/api'

interface PlanStep {
  step: Record<string, unknown> & { op: string }
  label: string
  effect: 'read' | 'analysis' | 'handoff'
  describes: string
  usesAi: boolean
  refs: { asWritten: string; page: { id: string; name: string } | null; candidates: { id: string; name: string; path: string }[] }[]
  sends: string | null
}
interface PlanView {
  source: 'rules' | 'ai'
  recognised: boolean
  message?: string
  ai: { sent: string; servedBy: string } | null
  plan?: { understanding: string; steps: unknown[]; missing: string[] }
  steps?: PlanStep[]
  needsAi?: boolean
  clarification?: { question: string; options: string[] } | null
  pendingChoices?: { asWritten: string; candidates: { id: string; name: string; path: string }[] }[]
  canRun?: boolean
  limitations?: string[]
}
interface StepResult {
  op: string
  title: string
  summary: string
  columns: string[]
  rows: { resourceId: string | null; cells: Record<string, string> }[]
  links: { label: string; href: string }[]
  notes: string[]
}

const EXAMPLES = [
  'Find all untagged NPC pages in Saltreach.',
  'Find historical events involving Iuz that have no confirmed date.',
  'Identify pages mentioning the Lanternwardens that are not linked to it.',
  'Find creatures that appear to use the old statblock layout.',
  'Suggest a chronology of events mentioned in these pages: Iuz, Iggwilv, Tasha',
  'Find inconsistencies between "Iuz" and "The Soul Husks of the Old One"',
  'Prepare a report of all references to Wee Jas.',
]

const EFFECT: Record<PlanStep['effect'], { label: string; tone: 'good' | 'info' | 'warn' }> = {
  read: { label: 'reads only', tone: 'good' },
  analysis: { label: 'records findings in the app', tone: 'info' },
  handoff: { label: 'opens another tool', tone: 'warn' },
}

export default function AssistantPage() {
  const [request, setRequest] = useState('')
  const [view, setView] = useState<PlanView | null>(null)
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [confirmAi, setConfirmAi] = useState(false)
  const [results, setResults] = useState<StepResult[] | null>(null)
  const settings = useApi<{ ai: { provider: string; model: string; enabled: boolean } }>('/api/settings')
  const action = useAction()

  const plan = (useAi: boolean) =>
    action.run(async () => {
      setResults(null)
      setChoices({})
      setConfirmAi(false)
      setView(await api.post<PlanView>('/api/assistant', { action: 'plan', request, useAi }))
    })
  const unresolved = view?.pendingChoices?.filter((p) => !choices[p.asWritten]) ?? []
  const runnable = view?.recognised && view.plan && view.plan.steps.length > 0 && unresolved.length === 0 && (!view.needsAi || confirmAi)

  return (
    <>
      <div className="page-header">
        <h1>Task Assistant</h1>
        <p>
          Describe a maintenance task in ordinary words. The assistant turns it into a plan made only of the app&apos;s own operations (find pages, list events, report
          references, run analyses…), shows it to you, and runs it. It never writes to LegendKeeper: for changes it points you to the tool that makes them with a final
          preview and your approval. The AI is not needed for the requests below; it is used only when you choose it.
        </p>
      </div>
      <Card title="Your request">
        <textarea className="inline-input" rows={3} style={{ width: '100%' }} value={request} onChange={(e) => setRequest(e.target.value)} placeholder="e.g. Find all untagged NPC pages in Saltreach" maxLength={1000} />
        <div className="row toolbar">
          <Button variant="primary" busy={action.busy} disabled={request.trim().length < 3} onClick={() => void plan(false)}>
            Make a plan
          </Button>
          <Button busy={action.busy} disabled={request.trim().length < 3 || settings.data?.ai.enabled === false} onClick={() => void plan(true)} title="Sends only your request, the list of operations and your tag names">
            Plan with AI
          </Button>
          {settings.data && (
            <span className="small muted">
              AI planning sends only your request, the list of operations and your tag names to {settings.data.ai.provider} ({settings.data.ai.model}); no page text.
            </span>
          )}
        </div>
        <div className="small muted">Examples:</div>
        <div className="pill-list">
          {EXAMPLES.map((e) => (
            <button key={e} className="badge badge-neutral" style={{ cursor: 'pointer' }} onClick={() => setRequest(e)}>
              {e}
            </button>
          ))}
        </div>
        <ErrorBox error={action.error} />
      </Card>

      {view && !view.recognised && <Notice tone="info">{view.message}</Notice>}
      {view?.recognised && view.plan && (
        <Card title={`Plan${view.source === 'ai' ? ' (proposed by the AI, checked by the app)' : ''}`}>
          <p>
            <strong>Understood as:</strong> {view.plan.understanding}
          </p>
          {view.steps?.length ? (
            <ol className="steps-list">
              {view.steps.map((s, i) => (
                <li key={i}>
                  <strong>{s.label}</strong> <Badge tone={EFFECT[s.effect].tone}>{EFFECT[s.effect].label}</Badge> {s.usesAi ? <Badge tone="warn">uses AI</Badge> : <Badge>no AI</Badge>}
                  <div className="small muted">{s.describes}</div>
                  <Params step={s.step} />
                  {s.refs.map((r) => (
                    <div key={r.asWritten} className="small">
                      “{r.asWritten}” →{' '}
                      {r.page ? (
                        <Link href={`/pages/${encodeURIComponent(r.page.id)}`}>{r.page.name}</Link>
                      ) : r.candidates.length ? (
                        <select className="inline-select" value={choices[r.asWritten] ?? ''} onChange={(e) => setChoices({ ...choices, [r.asWritten]: e.target.value })} aria-label={`Which page is “${r.asWritten}”?`}>
                          <option value="">Which page?</option>
                          {r.candidates.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                              {c.path ? ` (${c.path})` : ''}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="error-text">no page with this name</span>
                      )}
                    </div>
                  ))}
                  {s.sends && <Notice tone="warning">Sent to the AI: {s.sends}</Notice>}
                </li>
              ))}
            </ol>
          ) : null}
          {view.clarification && <Notice tone="info">{view.clarification.question}{view.clarification.options.length > 0 && ` (${view.clarification.options.join(', ')})`}</Notice>}
          {view.plan.missing.length > 0 && (
            <ul className="small">
              {view.plan.missing.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          )}
          {view.limitations && (
            <p className="small muted">
              Limitations: {view.limitations.join(' ')}
            </p>
          )}
          {view.needsAi && (
            <label className="check">
              <input type="checkbox" checked={confirmAi} onChange={(e) => setConfirmAi(e.target.checked)} /> Send the page text listed above to the AI provider for this task.
            </label>
          )}
          <div className="row">
            <Button
              variant="primary"
              disabled={!runnable}
              busy={action.busy}
              onClick={() => void action.run(async () => setResults((await api.post<{ results: StepResult[] }>('/api/assistant', { action: 'run', plan: view.plan, choices, confirmAi })).results))}
            >
              Run the plan
            </Button>
            {!view.steps?.length && <span className="small muted">Answer the question above in your request and make the plan again.</span>}
          </div>
        </Card>
      )}

      {results?.map((r, i) => (
        <Card key={i} title={r.title}>
          <p>{r.summary}</p>
          {r.rows.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {r.columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r.rows.map((row, j) => (
                    <tr key={j}>
                      {r.columns.map((c, k) => (
                        <td key={c} className={k === 0 ? undefined : 'small'}>
                          {k === 0 && row.resourceId ? <Link href={`/pages/${encodeURIComponent(row.resourceId)}`}>{row.cells[c]}</Link> : row.cells[c]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {r.notes.map((n, j) => (
            <p key={j} className="small muted">
              {n}
            </p>
          ))}
          <div className="row">
            {r.links.map((l) => (
              <Link key={l.href + l.label} className="btn btn-ghost" href={l.href}>
                {l.label} →
              </Link>
            ))}
          </div>
        </Card>
      ))}
    </>
  )
}

function Params({ step }: { step: Record<string, unknown> }) {
  const entries = Object.entries(step).filter(([k, v]) => k !== 'op' && v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0))
  if (!entries.length) return null
  return <div className="small">{entries.map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`).join(' · ')}</div>
}
