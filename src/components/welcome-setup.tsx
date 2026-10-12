'use client'

import { useState } from 'react'
import { Button, Card, ErrorBox, Notice, useAction } from '@/components/ui'
import { api } from '@/lib/api'

/**
 * First-run setup: asks for the LegendKeeper key (and optionally the free OpenRouter key)
 * and saves them on this computer. Shown on the dashboard until a LegendKeeper key is set.
 */
export function WelcomeSetup({ onDone }: { onDone: () => void }) {
  const [lk, setLk] = useState('')
  const [openrouter, setOpenrouter] = useState('')
  const action = useAction()
  const save = () =>
    action.run(async () => {
      await api.post('/api/settings', { action: 'setKey', kind: 'legendkeeper', value: lk.trim(), persist: true })
      if (openrouter.trim()) await api.post('/api/settings', { action: 'setKey', kind: 'openrouter', value: openrouter.trim(), persist: true })
      setLk('')
      setOpenrouter('')
      onDone()
    })
  return (
    <Card title="Welcome to LK Companion — let’s connect your LegendKeeper project">
      <ol className="steps-list">
        <li>
          In LegendKeeper, open your project → <strong>Project Settings → Developers → API Keys</strong>, create a key (the project owner needs a paid plan) and copy it.
        </li>
        <li>
          Optional, for AI features: create a free key at <strong>openrouter.ai → Settings → Keys</strong> (leave its credit limit at $0; the app only uses free models).
        </li>
        <li>Paste them below. They are saved in a settings file on this computer, never in the app&apos;s database, and never shown again.</li>
      </ol>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (lk.trim()) void save()
        }}
      >
        <div className="field">
          <label htmlFor="welcome-lk">LegendKeeper API key</label>
          <input id="welcome-lk" type="password" autoComplete="off" value={lk} onChange={(e) => setLk(e.target.value)} placeholder="lk_…" style={{ maxWidth: '28rem', width: '100%' }} />
        </div>
        <div className="field">
          <label htmlFor="welcome-or">OpenRouter API key (optional)</label>
          <input id="welcome-or" type="password" autoComplete="off" value={openrouter} onChange={(e) => setOpenrouter(e.target.value)} placeholder="sk-or-…" style={{ maxWidth: '28rem', width: '100%' }} />
        </div>
        <Button type="submit" variant="primary" busy={action.busy} disabled={!lk.trim()}>
          Save and connect
        </Button>
      </form>
      <ErrorBox error={action.error} />
      <Notice tone="info">You can change or remove these keys later on the Settings page.</Notice>
    </Card>
  )
}
