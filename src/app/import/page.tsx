'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Badge, Button, Card, Empty, ErrorBox, Loading, Notice, formatDate, statusTone, useAction, useApi } from '@/components/ui'
import { api } from '@/lib/api'
import type { JobSummary } from '@/lib/types'
import type { Recipe } from '@/core/recipe'

interface Chunk {
  index: number
  heading: string
  chars: number
  text: string
}

export default function ImportStudio() {
  return (
    <>
      <div className="page-header">
        <h1>Import studio</h1>
        <p>
          Bring in a file or pasted text, turn it into a draft page with a recipe, review and edit it, and only then — with your approval — create it in LegendKeeper. Phase 1
          accepts plain text, Markdown and JSON.
        </p>
      </div>
      <NewImport />
      <RecentImports />
    </>
  )
}

function NewImport() {
  const router = useRouter()
  const recipes = useApi<{ recipes: Recipe[] }>('/api/recipes')
  const create = useAction()
  const splitter = useAction()
  const [mode, setMode] = useState<'file' | 'paste'>('file')
  const [file, setFile] = useState<File | null>(null)
  const [text, setText] = useState('')
  const [format, setFormat] = useState('')
  const [name, setName] = useState('')
  const [attribution, setAttribution] = useState('')
  const [citation, setCitation] = useState('')
  const [recipeId, setRecipeId] = useState('')
  const [chunks, setChunks] = useState<Chunk[] | null>(null)

  const form = (override?: { text: string; name: string }) => {
    const data = new FormData()
    if (override) data.set('text', override.text)
    else if (mode === 'file' && file) data.set('file', file)
    else data.set('text', text)
    if (format) data.set('format', format)
    data.set('name', override?.name ?? name)
    data.set('attributionTitle', attribution || (mode === 'file' && file ? file.name : ''))
    data.set('citation', citation)
    data.set('recipeId', recipeId)
    return data
  }

  const submit = (override?: { text: string; name: string }) =>
    create.run(async () => {
      const job = await api.upload<{ id: string }>('/api/imports', form(override))
      router.push(`/import/${job.id}`)
    })

  const tooLong = create.error?.code === 'TOO_LONG'

  return (
    <Card title="New import">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={mode === 'file'} onClick={() => setMode('file')}>
          Upload a file
        </button>
        <button role="tab" aria-selected={mode === 'paste'} onClick={() => setMode('paste')}>
          Paste text
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setChunks(null)
          void submit()
        }}
      >
        {mode === 'file' ? (
          <div className="field">
            <label htmlFor="file">File (.txt, .md or .json)</label>
            <input id="file" type="file" accept=".txt,.text,.md,.markdown,.json,text/plain,text/markdown,application/json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>
        ) : (
          <div className="field">
            <label htmlFor="text">Text</label>
            <textarea id="text" value={text} onChange={(e) => setText(e.target.value)} rows={10} className="mono" />
            <div className="row" style={{ marginTop: '0.4rem' }}>
              <label htmlFor="format" style={{ margin: 0 }}>
                Format
              </label>
              <select id="format" value={format} onChange={(e) => setFormat(e.target.value)} style={{ width: 'auto' }}>
                <option value="">Detect automatically</option>
                <option value="text">Plain text</option>
                <option value="markdown">Markdown</option>
                <option value="json">JSON</option>
              </select>
            </div>
          </div>
        )}
        <div className="grid grid-2">
          <div className="field">
            <label htmlFor="name">
              Job name <span className="hint">(optional — defaults to the title found in the source)</span>
            </label>
            <input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="recipe">Recipe</label>
            <select id="recipe" value={recipeId} onChange={(e) => setRecipeId(e.target.value)}>
              <option value="">Choose later</option>
              {recipes.data?.recipes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.definition.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="attribution">
              Source title <span className="hint">(e.g. “World of Greyhawk Gazetteer”)</span>
            </label>
            <input id="attribution" type="text" value={attribution} onChange={(e) => setAttribution(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="citation">
              Citation <span className="hint">(page, chapter, edition…)</span>
            </label>
            <input id="citation" type="text" value={citation} onChange={(e) => setCitation(e.target.value)} />
          </div>
        </div>
        <p className="small muted">
          Creating an import stores the source on this computer only while you review it. Nothing is sent to the AI until you run a transformation.
        </p>
        <Button type="submit" variant="primary" busy={create.busy} disabled={mode === 'file' ? !file : !text.trim()}>
          Create import
        </Button>
      </form>
      <ErrorBox error={create.error} title="The source could not be imported" />
      {tooLong && (
        <Notice tone="info">
          <p>Long sources are not cut short. Split it into sections and import one section at a time:</p>
          <Button busy={splitter.busy} onClick={() => splitter.run(async () => setChunks((await api.upload<{ chunks: Chunk[] }>('/api/imports/split', form())).chunks))}>
            Split source
          </Button>
        </Notice>
      )}
      <ErrorBox error={splitter.error} />
      {chunks && (
        <div className="table-wrap">
          <p>
            {chunks.length} sections. Joined together they are exactly the original source. Import the one you want to work on:
          </p>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Starts with</th>
                <th>Characters</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {chunks.map((chunk) => (
                <tr key={chunk.index}>
                  <td>{chunk.index + 1}</td>
                  <td>{chunk.heading}</td>
                  <td>{chunk.chars.toLocaleString('en-GB')}</td>
                  <td>
                    <Button onClick={() => submit({ text: chunk.text, name: `${name || attribution || file?.name || 'Source'} — part ${chunk.index + 1}: ${chunk.heading}`.slice(0, 200) })}>Import this section</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function RecentImports() {
  const { data, error, loading } = useApi<{ items: JobSummary[]; total: number }>('/api/imports?pageSize=50')
  return (
    <Card title="Imports">
      <ErrorBox error={error} />
      {loading && <Loading />}
      {data && data.items.length === 0 && <Empty title="No imports yet">Create one above.</Empty>}
      {data && data.items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Import</th>
                <th>Status</th>
                <th>Draft</th>
                <th>Source</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((job) => (
                <tr key={job.id}>
                  <td>
                    <Link href={`/import/${job.id}`}>{job.name}</Link>
                  </td>
                  <td>
                    <Badge tone={statusTone(job.status)}>{job.status}</Badge>
                  </td>
                  <td>
                    {job.draft ? (
                      <>
                        <Badge tone={statusTone(job.draft.status)}>{job.draft.status}</Badge>{' '}
                        {job.draft.createdResourceId && <Link href={`/pages/${job.draft.createdResourceId}`}>open page</Link>}
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="small">
                    {job.sourceKind} · {job.sourceFormat} · {(job.sourceSize / 1024).toFixed(1)} KB
                  </td>
                  <td className="small nowrap">{formatDate(job.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
