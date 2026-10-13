'use client'

import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force'
import { useEffect, useMemo, useRef, useState } from 'react'

export interface MapNode {
  id: string
  name: string
  kind: string
  degree: number
  distance: number
  read: boolean
}
export interface MapEdge {
  source: string
  target: string
  types: string[]
  support: 'api' | 'link' | 'field' | 'text' | 'ai'
  count: number
}

type SimNode = MapNode & SimulationNodeDatum
type SimLink = SimulationLinkDatum<SimNode> & { edge: MapEdge }

export const KIND_COLOURS: Record<string, string> = {
  person: '#3b82f6',
  deity: '#d97706',
  faction: '#16a34a',
  place: '#7c3aed',
  event: '#dc2626',
  creature: '#8a6d3b',
  item: '#0891b2',
  rule: '#64748b',
  other: '#9ca3af',
}
const DASH: Record<MapEdge['support'], number[]> = { field: [], link: [], ai: [1, 3], text: [6, 4], api: [2, 4] }

const radius = (n: MapNode) => Math.min(16, 3.5 + Math.sqrt(n.degree) * 1.6)

/**
 * A pan-and-zoom map of pages and their relationships, laid out by a force simulation (d3-force)
 * and drawn on a canvas, so it stays smooth with thousands of pages. Click a page to select it;
 * drag to move around; scroll (or pinch) to zoom.
 */
export function RelationshipMap({
  nodes,
  edges,
  centre,
  labels,
  selected,
  onSelect,
}: {
  nodes: MapNode[]
  edges: MapEdge[]
  centre?: string | null
  labels: Record<string, string>
  selected: string | null
  onSelect: (id: string | null) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const view = useRef({ x: 0, y: 0, k: 1 })
  const [hover, setHover] = useState<SimNode | null>(null)
  const [settled, setSettled] = useState(false)
  const draw = useRef<() => void>(() => {})

  // The simulation's own copies (it adds positions to them).
  const sim = useMemo(() => {
    const simNodes: SimNode[] = nodes.map((n) => ({ ...n }))
    const byId = new Map(simNodes.map((n) => [n.id, n]))
    const links: SimLink[] = edges.filter((e) => byId.has(e.source) && byId.has(e.target)).map((e) => ({ source: e.source, target: e.target, edge: e }))
    const neighbours = new Map<string, Set<string>>()
    for (const e of edges) {
      if (!neighbours.has(e.source)) neighbours.set(e.source, new Set())
      if (!neighbours.has(e.target)) neighbours.set(e.target, new Set())
      neighbours.get(e.source)!.add(e.target)
      neighbours.get(e.target)!.add(e.source)
    }
    return { nodes: simNodes, links, byId, neighbours }
  }, [nodes, edges])

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const ctx = el.getContext('2d')
    if (!ctx) return
    const css = getComputedStyle(document.documentElement)
    const colour = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
    const text = colour('--text', '#1e1d1a')
    const muted = colour('--muted', '#6a675f')
    const surface = colour('--surface', '#ffffff')
    const accent = colour('--accent', '#6b3fa0')

    const resize = () => {
      const ratio = window.devicePixelRatio || 1
      const rect = el.getBoundingClientRect()
      el.width = Math.max(1, Math.round(rect.width * ratio))
      el.height = Math.max(1, Math.round(rect.height * ratio))
      draw.current()
    }

    draw.current = () => {
      const ratio = window.devicePixelRatio || 1
      const { x, y, k } = view.current
      const w = el.width / ratio
      const h = el.height / ratio
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      ctx.clearRect(0, 0, w, h)
      ctx.translate(w / 2 + x, h / 2 + y)
      ctx.scale(k, k)
      const focus = selected ?? hover?.id ?? null
      const near = focus ? sim.neighbours.get(focus) ?? new Set<string>() : null
      const lit = (id: string) => !near || id === focus || near.has(id)

      for (const link of sim.links) {
        const s = link.source as SimNode
        const t = link.target as SimNode
        const on = !near || ((s.id === focus || t.id === focus) && lit(s.id) && lit(t.id))
        ctx.globalAlpha = on ? (near ? 0.9 : 0.35) : 0.06
        ctx.strokeStyle = on && near ? accent : muted
        ctx.lineWidth = (0.6 + Math.min(link.edge.count, 4) * 0.35) / Math.sqrt(k)
        ctx.setLineDash(DASH[link.edge.support].map((d) => d / k))
        ctx.beginPath()
        ctx.moveTo(s.x!, s.y!)
        ctx.lineTo(t.x!, t.y!)
        ctx.stroke()
      }
      ctx.setLineDash([])
      for (const n of sim.nodes) {
        ctx.globalAlpha = lit(n.id) ? 1 : 0.15
        ctx.fillStyle = KIND_COLOURS[n.kind] ?? KIND_COLOURS.other!
        ctx.beginPath()
        ctx.arc(n.x!, n.y!, radius(n), 0, Math.PI * 2)
        ctx.fill()
        if (n.id === centre || n.id === selected) {
          ctx.lineWidth = 2.5 / k
          ctx.strokeStyle = n.id === selected ? accent : text
          ctx.stroke()
        }
      }
      // Names: the busiest pages, everything once zoomed in, and the focus with its neighbours.
      const busiest = [...sim.nodes].sort((a, b) => b.degree - a.degree).slice(0, Math.max(12, Math.round(30 * k * k)))
      const named = new Set(busiest.map((n) => n.id))
      ctx.font = `${12 / k}px system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.lineJoin = 'round'
      for (const n of sim.nodes) {
        const show = k >= 2.2 || named.has(n.id) || n.id === centre || n.id === focus || (near?.has(n.id) ?? false)
        if (!show || !lit(n.id)) continue
        const label = n.name.length > 32 ? `${n.name.slice(0, 31)}…` : n.name
        ctx.globalAlpha = 1
        ctx.lineWidth = 3 / k
        ctx.strokeStyle = surface
        ctx.strokeText(label, n.x!, n.y! + radius(n) + 2 / k)
        ctx.fillStyle = text
        ctx.fillText(label, n.x!, n.y! + radius(n) + 2 / k)
      }
      ctx.globalAlpha = 1
    }

    // Lay out: a few ticks a frame, so the page stays responsive and the map settles visibly.
    setSettled(false)
    const big = sim.nodes.length > 600
    const simulation = forceSimulation<SimNode>(sim.nodes)
      .force('link', forceLink<SimNode, SimLink>(sim.links).id((d) => d.id).distance(big ? 28 : 45).strength(0.7))
      .force('charge', forceManyBody<SimNode>().strength(big ? -40 : -110).distanceMax(500))
      .force('collide', forceCollide<SimNode>((d) => radius(d) + 3))
      .force('x', forceX<SimNode>(0).strength(0.04))
      .force('y', forceY<SimNode>(0).strength(0.04))
      .force('center', forceCenter(0, 0))
      .stop()
    if (centre) {
      const c = sim.byId.get(centre)
      if (c) (c.fx = 0), (c.fy = 0)
    }
    let frame = 0
    const step = () => {
      for (let i = 0; i < (big ? 3 : 6); i++) simulation.tick()
      draw.current()
      if (simulation.alpha() > 0.02) frame = requestAnimationFrame(step)
      else {
        fit()
        setSettled(true)
      }
    }
    const fit = () => {
      if (!sim.nodes.length) return
      const xs = sim.nodes.map((n) => n.x!)
      const ys = sim.nodes.map((n) => n.y!)
      const rect = el.getBoundingClientRect()
      const width = Math.max(...xs) - Math.min(...xs) + 80
      const height = Math.max(...ys) - Math.min(...ys) + 80
      const k = Math.min(2.5, Math.max(0.1, Math.min(rect.width / width, rect.height / height)))
      view.current = { k, x: -((Math.max(...xs) + Math.min(...xs)) / 2) * k, y: -((Math.max(...ys) + Math.min(...ys)) / 2) * k }
      draw.current()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(el)
    resize()
    frame = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(frame)
      simulation.stop()
      observer.disconnect()
    }
    // Selection and hover only redraw (below); they do not restart the layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sim, centre])

  useEffect(() => draw.current(), [selected, hover])

  // Pan, zoom, hover and click.
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const toWorld = (cx: number, cy: number) => {
      const rect = el.getBoundingClientRect()
      const { x, y, k } = view.current
      return { x: (cx - rect.left - rect.width / 2 - x) / k, y: (cy - rect.top - rect.height / 2 - y) / k }
    }
    const hit = (cx: number, cy: number): SimNode | null => {
      const p = toWorld(cx, cy)
      let best: SimNode | null = null
      let bestD = Infinity
      for (const n of sim.nodes) {
        const d = Math.hypot(n.x! - p.x, n.y! - p.y)
        if (d < radius(n) + 4 / view.current.k && d < bestD) (best = n), (bestD = d)
      }
      return best
    }
    let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null
    const down = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId)
      drag = { x: e.clientX, y: e.clientY, vx: view.current.x, vy: view.current.y, moved: false }
    }
    const move = (e: PointerEvent) => {
      if (drag) {
        const dx = e.clientX - drag.x
        const dy = e.clientY - drag.y
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true
        view.current = { ...view.current, x: drag.vx + dx, y: drag.vy + dy }
        draw.current()
      } else {
        const n = hit(e.clientX, e.clientY)
        setHover((current) => (current?.id === n?.id ? current : n))
        el.style.cursor = n ? 'pointer' : 'grab'
      }
    }
    const up = (e: PointerEvent) => {
      if (drag && !drag.moved) onSelect(hit(e.clientX, e.clientY)?.id ?? null)
      drag = null
    }
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const { x, y, k } = view.current
      const next = Math.min(8, Math.max(0.05, k * Math.exp(-e.deltaY * 0.0015)))
      const px = e.clientX - rect.left - rect.width / 2
      const py = e.clientY - rect.top - rect.height / 2
      view.current = { k: next, x: px - ((px - x) * next) / k, y: py - ((py - y) * next) / k }
      draw.current()
    }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('wheel', wheel, { passive: false })
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('wheel', wheel)
    }
  }, [sim, onSelect])

  const zoom = (factor: number) => {
    const { x, y, k } = view.current
    const next = Math.min(8, Math.max(0.05, k * factor))
    view.current = { k: next, x: (x * next) / k, y: (y * next) / k }
    draw.current()
  }
  const focusOn = (id: string) => {
    const n = sim.byId.get(id)
    if (!n) return
    const k = Math.max(view.current.k, 1.6)
    view.current = { k, x: -n.x! * k, y: -n.y! * k }
    draw.current()
  }
  // Moving to the selected page when it is chosen from outside (the search box).
  useEffect(() => {
    if (selected && settled) focusOn(selected)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, settled])

  const kinds = [...new Set(nodes.map((n) => n.kind))]
  return (
    <div>
      <div className="graph-wrap">
        <canvas ref={canvas} role="img" aria-label={`Map of ${nodes.length} pages and ${edges.length} connections`} style={{ display: 'block', width: '100%', height: '640px', cursor: 'grab', touchAction: 'none' }} />
        <div className="graph-tools">
          <button type="button" className="btn" onClick={() => zoom(1.4)} aria-label="Zoom in">
            +
          </button>
          <button type="button" className="btn" onClick={() => zoom(1 / 1.4)} aria-label="Zoom out">
            −
          </button>
        </div>
        {!settled && <div className="small muted" style={{ position: 'absolute', left: '0.75rem', top: '0.5rem' }}>Laying out {nodes.length} pages…</div>}
        {hover && !selected && (
          <div className="small" style={{ position: 'absolute', left: '0.75rem', bottom: '0.5rem', background: 'var(--surface)', padding: '0.2rem 0.5rem', borderRadius: 6, border: '1px solid var(--border)' }}>
            <strong>{hover.name}</strong> · {hover.kind} · {hover.degree} connection{hover.degree === 1 ? '' : 's'}
          </div>
        )}
      </div>
      <div className="graph-legend">
        {kinds.map((k) => (
          <span key={k} style={{ ['--dot' as string]: KIND_COLOURS[k] ?? KIND_COLOURS.other }}>
            {k}
          </span>
        ))}
        <span style={{ ['--dot' as string]: 'transparent' }}>Solid: link or field · dashed: wording · dotted: page tree or accepted AI suggestion</span>
      </div>
      {Object.keys(labels).length === 0 && null}
    </div>
  )
}
