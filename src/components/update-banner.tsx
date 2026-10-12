'use client'

import { useEffect, useState } from 'react'
import { Button, Notice, useAction } from './ui'
import { api } from '@/lib/api'
import type { UpdateStatus } from '@/lib/types'

/**
 * Shown at the top of every page when a newer version of the Windows app is published: the
 * prompt at startup, with a one-click update. "Later" hides it until the app is next opened.
 */
export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [hidden, setHidden] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'downloading' | 'restarting'>('idle')
  const action = useAction()

  useEffect(() => {
    try {
      if (sessionStorage.getItem('lkc.update.later') === '1') setHidden(true)
    } catch {
      /* storage unavailable: show it */
    }
    api.get<UpdateStatus>('/api/update').then(setStatus, () => undefined)
  }, [])

  // After restarting, wait for the new version to answer, then reload.
  useEffect(() => {
    if (phase !== 'restarting' || !status) return
    const before = status.current.build
    const timer = setInterval(async () => {
      try {
        const next = await api.get<UpdateStatus>('/api/update')
        if (next.current.build !== before) window.location.reload()
      } catch {
        /* still restarting */
      }
    }, 2000)
    return () => clearInterval(timer)
  }, [phase, status])

  if (!status || hidden || (!status.available && !status.staged)) return null
  const build = status.staged?.build ?? status.latest?.build
  const install = () =>
    action.run(async () => {
      if (!status.staged) {
        setPhase('downloading')
        await api.post('/api/update', { action: 'download' })
      }
      setPhase('restarting')
      await api.post('/api/update', { action: 'restart', confirm: true })
    }).finally(() => setPhase((p) => (p === 'downloading' ? 'idle' : p)))

  return (
    <div className="update-banner">
      <Notice tone="info">
        {phase === 'restarting' && !action.error ? (
          <strong>Installing the new version… LK Companion restarts and this page reloads by itself in a moment.</strong>
        ) : (
          <>
            <strong>A new version of LK Companion is available</strong> (build {build}; you have build {status.current.build}).{' '}
            {status.latest?.name && status.latest.name !== `build ${build}` && <span className="muted">{status.latest.name}. </span>}
            Your settings and data are kept.
            <div className="row" style={{ marginTop: '0.4rem' }}>
              <Button variant="primary" busy={action.busy} onClick={() => void install()}>
                {phase === 'downloading' ? 'Downloading…' : status.staged ? 'Restart and update' : 'Update now'}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  try {
                    sessionStorage.setItem('lkc.update.later', '1')
                  } catch {
                    /* ignore */
                  }
                  setHidden(true)
                }}
              >
                Later
              </Button>
              {status.latest?.pageUrl && (
                <a className="small" href={status.latest.pageUrl} target="_blank" rel="noreferrer">
                  What’s new
                </a>
              )}
            </div>
          </>
        )}
        {action.error && <div className="small">The update did not go ahead: {action.error.message}</div>}
      </Notice>
    </div>
  )
}
