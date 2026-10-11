'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, toErrorInfo, type ApiErrorInfo } from '@/lib/api'

/** Small, accessible building blocks shared by every page. */

export function ErrorBox({ error, title = 'Something went wrong' }: { error: ApiErrorInfo | null; title?: string }) {
  if (!error) return null
  return (
    <div className="notice notice-error" role="alert">
      <strong>{title}</strong>
      <p>{error.message}</p>
      {error.issues.length > 0 && (
        <ul>
          {error.issues.map((issue, i) => (
            <li key={i}>{issue}</li>
          ))}
        </ul>
      )}
      {error.requestId && (
        <p className="muted small">
          LegendKeeper request ID: <code>{error.requestId}</code> (quote it when reporting a problem)
        </p>
      )}
    </div>
  )
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warning' | 'success' | 'error'; children: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  )
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" /> {label}
    </p>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <div>{children}</div>}
    </div>
  )
}

export function Badge({ tone = 'neutral', children, title }: { tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info'; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  )
}

export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-header">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

export function Button({
  onClick,
  busy,
  disabled,
  variant = 'secondary',
  children,
  type = 'button',
  title,
}: {
  onClick?: () => void
  busy?: boolean
  disabled?: boolean
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  children: ReactNode
  type?: 'button' | 'submit'
  title?: string
}) {
  return (
    <button type={type} className={`btn btn-${variant}`} onClick={onClick} disabled={disabled || busy} aria-busy={busy} title={title}>
      {busy && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  )
}

export function KeyValue({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{value ?? <span className="muted">—</span>}</dd>
        </div>
      ))}
    </dl>
  )
}

export function JsonView({ value, label = 'Show JSON' }: { value: unknown; label?: string }) {
  return (
    <details className="json">
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  )
}

/** Loads JSON from a GET endpoint, with loading and error state and a reload function. */
export function useApi<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<ApiErrorInfo | null>(null)
  const [loading, setLoading] = useState(url !== null)
  const current = useRef(url)
  current.current = url

  const reload = useCallback(async () => {
    if (!url) return
    setLoading(true)
    try {
      const result = await api.get<T>(url)
      if (current.current === url) {
        setData(result)
        setError(null)
      }
    } catch (err) {
      if (current.current === url) setError(toErrorInfo(err))
    } finally {
      if (current.current === url) setLoading(false)
    }
  }, [url])

  useEffect(() => {
    void reload()
  }, [reload])

  return { data, error, loading, reload, setData }
}

/** Runs an action with busy and error state. */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiErrorInfo | null>(null)
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true)
    setError(null)
    try {
      return await fn()
    } catch (err) {
      setError(toErrorInfo(err))
      return undefined
    } finally {
      setBusy(false)
    }
  }, [])
  return { busy, error, run, setError }
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
}

export function statusTone(status: string): 'neutral' | 'good' | 'warn' | 'bad' | 'info' {
  if (['created', 'completed', 'success', 'existing', 'resolved', 'source', 'user'].includes(status)) return 'good'
  if (['failed', 'write_failed', 'failure', 'error', 'rejected', 'blocked', 'ambiguous'].includes(status)) return 'bad'
  if (['write_uncertain', 'uncertain', 'warning', 'new', 'suggested', 'awaiting_approval', 'interrupted', 'paused', 'case_variant'].includes(status)) return 'warn'
  if (['running', 'transforming', 'writing', 'info', 'drafted'].includes(status)) return 'info'
  return 'neutral'
}
