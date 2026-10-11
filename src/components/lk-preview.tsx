'use client'

import type { ReactNode } from 'react'

/**
 * An approximate, read-only rendering of LegendKeeper blocks, for previews. It covers the
 * common block kinds; anything else is shown as a labelled placeholder. It is not the
 * LegendKeeper editor and never sends anything anywhere.
 */

type AnyBlock = Record<string, unknown> & { kind?: string; id?: string }
type Names = Record<string, string>
type AnyRun = { text?: string; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; code?: boolean; link?: string; sub?: boolean; sup?: boolean; mention?: { resourceId: string; text?: string; name?: string }; break?: boolean }

function runs(content: unknown): ReactNode {
  if (!Array.isArray(content)) return null
  return (content as AnyRun[]).map((run, i) => {
    if (run.break) return <br key={i} />
    if (run.mention) {
      return (
        <a key={i} className="lk-mention" href={`/pages/${run.mention.resourceId}`} title={`Link to ${run.mention.resourceId}`}>
          {run.mention.text || run.mention.name || run.mention.resourceId}
        </a>
      )
    }
    let node: ReactNode = run.text ?? ''
    if (run.code) node = <code>{node}</code>
    if (run.bold) node = <strong>{node}</strong>
    if (run.italic) node = <em>{node}</em>
    if (run.underline) node = <u>{node}</u>
    if (run.strike) node = <s>{node}</s>
    if (run.sub) node = <sub>{node}</sub>
    if (run.sup) node = <sup>{node}</sup>
    if (run.link) node = <a href={run.link} rel="noreferrer noopener" target="_blank">{node}</a>
    return <span key={i}>{node}</span>
  })
}

function children(block: AnyBlock, names: Names): ReactNode {
  return Array.isArray(block.children) ? (block.children as AnyBlock[]).map((child, i) => <Block key={child.id ?? i} block={child} names={names} />) : null
}

function KeyValueTable({ rows }: { rows: unknown }) {
  if (!Array.isArray(rows)) return null
  return (
    <table className="lk-kv">
      <tbody>
        {(rows as { key?: string; text?: string; content?: unknown }[]).map((row, i) => (
          <tr key={i}>
            <td>
              <strong>{row.key}</strong>
            </td>
            <td>{row.content ? runs(row.content) : row.text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Block({ block, names }: { block: AnyBlock; names: Names }): ReactNode {
  const title = typeof block.title === 'string' && block.isTitleHidden !== true ? <h4>{block.title}</h4> : null
  switch (block.kind) {
    case 'paragraph':
      return <p>{runs(block.content)}</p>
    case 'heading': {
      const level = Math.min(Math.max(Number(block.level) || 2, 1), 6)
      const Tag = `h${level}` as 'h1'
      return <Tag>{runs(block.content)}</Tag>
    }
    case 'bulletList':
      return <ul>{children(block, names)}</ul>
    case 'orderedList':
      return <ol start={typeof block.start === 'number' ? block.start : undefined}>{children(block, names)}</ol>
    case 'listItem':
      return <li>{children(block, names)}</li>
    case 'taskList':
      return <ul style={{ listStyle: 'none', paddingLeft: '0.5rem' }}>{children(block, names)}</ul>
    case 'taskItem':
      return (
        <li>
          {block.checked ? '☑' : '☐'} {runs(block.content)}
          {children(block, names)}
        </li>
      )
    case 'quote':
      return <blockquote>{children(block, names)}</blockquote>
    case 'code':
      return <pre className="source">{String(block.text ?? '')}</pre>
    case 'rule':
      return <hr />
    case 'callout':
      return <div className={`notice notice-${block.tone === 'warning' ? 'warning' : block.tone === 'error' ? 'error' : block.tone === 'success' ? 'success' : 'info'}`}>{children(block, names)}</div>
    case 'expand':
      return (
        <details>
          <summary>{String(block.title ?? 'Details')}</summary>
          {children(block, names)}
        </details>
      )
    case 'layout':
      return <div className="two-col">{children(block, names)}</div>
    case 'layoutColumn':
      return <div>{children(block, names)}</div>
    case 'secret':
      return (
        <div className="notice notice-warning">
          <span className="small muted">Secret (hidden from players)</span>
          {children(block, names)}
        </div>
      )
    case 'textField':
      return (
        <div>
          {title}
          {children(block, names)}
        </div>
      )
    case 'keyValue':
      return (
        <div>
          {title}
          <KeyValueTable rows={block.rows} />
        </div>
      )
    case 'resourceLink':
      return (
        <div>
          {title}
          <ul>
            {((block.items as { resourceId?: string }[]) ?? []).map((item, i) => (
              <li key={i}>
                <a className="lk-mention" href={`/pages/${item.resourceId}`}>
                  {(item.resourceId && names[item.resourceId]) ?? item.resourceId}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )
    case 'infobox':
      return (
        <aside className="lk-infobox">
          {((block.rows as AnyBlock[]) ?? []).map((row, i) => (
            <Block key={row.id ?? i} block={row} names={names} />
          ))}
        </aside>
      )
    case 'table':
      return (
        <table>
          <tbody>{children(block, names)}</tbody>
        </table>
      )
    case 'tableRow':
      return <tr>{children(block, names)}</tr>
    case 'tableCell':
      return <td>{children(block, names)}</td>
    case 'tableHeader':
      return <th>{children(block, names)}</th>
    case 'unsupported':
      return <p className="muted small">[Content the API cannot show — kept as is in LegendKeeper]</p>
    default:
      return <p className="muted small">[{block.kind ?? 'unknown'} block]</p>
  }
}

/** `names` maps resource IDs to page names, so link lists show names rather than IDs. */
export function LkBlocksPreview({ blocks, names = {} }: { blocks: unknown[]; names?: Names }) {
  if (blocks.length === 0) return <p className="muted">(empty page)</p>
  return (
    <div className="lk-preview">
      {(blocks as AnyBlock[]).map((block, i) => (
        <Block key={block.id ?? i} block={block} names={names} />
      ))}
    </div>
  )
}
