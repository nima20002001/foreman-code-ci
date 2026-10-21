import { useRef, useState, useEffect, type ReactNode } from 'react'
import { Button } from './Button'
import { EmptyState } from './Feedback'
import { Icon } from './Icon'
import type { Tone } from './utils'

export interface Column<T> { id: string; header: string; render: (row: T) => ReactNode; sortable?: boolean; align?: 'start' | 'end' }
export interface DataTableProps<T> {
  label: string; rows: readonly T[]; columns: readonly Column<T>[]; rowKey: (row: T) => string
  sort?: { column: string; direction: 'asc' | 'desc' }; onSortChange?: (sort: { column: string; direction: 'asc' | 'desc' }) => void
  emptyTitle?: string; emptyDescription?: string; busy?: boolean
}
/** Controlled table: filtering, pagination and sorting stay with the URL/query owner. */
export function DataTable<T>({ label, rows, columns, rowKey, sort, onSortChange, busy, emptyTitle = 'Nothing here yet', emptyDescription = 'New results will appear here.' }: DataTableProps<T>) {
  return <div className="n-table-scroll" role="region" aria-label={label} tabIndex={0} aria-busy={busy || undefined}>
    <table className="n-table"><caption className="n-sr-only">{label}</caption><thead><tr>{columns.map((column) => <th key={column.id} scope="col" data-align={column.align}
      aria-sort={sort?.column === column.id ? (sort.direction === 'asc' ? 'ascending' : 'descending') : column.sortable ? 'none' : undefined}>
      {column.sortable && onSortChange ? <button type="button" onClick={() => onSortChange({ column: column.id, direction: sort?.column === column.id && sort.direction === 'asc' ? 'desc' : 'asc' })}>
        {column.header}<span aria-hidden="true">{sort?.column === column.id ? (sort.direction === 'asc' ? '↑' : '↓') : '↕'}</span></button> : column.header}
    </th>)}</tr></thead><tbody>{rows.map((row) => <tr key={rowKey(row)}>{columns.map((column) => <td key={column.id} data-align={column.align}>{column.render(row)}</td>)}</tr>)}</tbody></table>
    {rows.length === 0 && !busy && <EmptyState title={emptyTitle} description={emptyDescription} />}
    {rows.length === 0 && busy && <p className="n-table-loading" role="status">Loading results…</p>}
  </div>
}

export function CodeBlock({ code, label = 'Code', language = 'text', copy = true }: { code: string; label?: string; language?: string; copy?: boolean }) {
  const [message, setMessage] = useState({ code: '', text: '' })
  const sequence = useRef(0)
  useEffect(() => () => { sequence.current += 1 }, [])
  async function copyText() {
    const request = ++sequence.current
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(code)
      if (request === sequence.current) setMessage({ code, text: 'Copied to clipboard.' })
    } catch {
      if (request === sequence.current) setMessage({ code, text: 'Could not copy. Select the text and copy it manually.' })
    }
  }
  return <div className="n-code"><div className="n-code-header"><span>{label}</span><span className="n-code-language">{language}</span>{copy && <Button size="sm" variant="ghost" leading={<Icon name="copy" size={14} />} onClick={() => void copyText()}>Copy</Button>}</div>
    <pre tabIndex={0} aria-label={label}><code>{code}</code></pre><span className="n-copy-status" role="status">{message.code === code ? message.text : ''}</span></div>
}

export interface TimelineItem { id: string; title: string; description?: string; time: string; dateTime?: string; tone?: Tone }
export function Timeline({ items, label = 'Activity' }: { items: readonly TimelineItem[]; label?: string }) {
  return <ol className="n-timeline" aria-label={label}>{items.map((item) => <li key={item.id} data-tone={item.tone ?? 'neutral'}>
    <span className="n-timeline-dot" aria-hidden="true" /><div><strong>{item.title}</strong>{item.description && <p>{item.description}</p>}</div><time dateTime={item.dateTime}>{item.time}</time>
  </li>)}</ol>
}

export function LogViewer({ lines, label = 'Execution log' }: { lines: readonly { id: string; timestamp: string; message: string; tone?: Tone }[]; label?: string }) {
  const [follow, setFollow] = useState(true)
  const scroll = useRef<HTMLDivElement>(null)
  const latestId = lines.at(-1)?.id
  useEffect(() => {
    if (follow && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [follow, latestId])
  return <div className="n-log"><div className="n-code-header"><Icon name="terminal" size={16} /><strong>{label}</strong>
    <Button variant="ghost" size="sm" aria-pressed={follow} onClick={() => setFollow((previous) => !previous)}>{follow ? 'Following' : 'Follow output'}</Button></div>
    <div ref={scroll} className="n-log-lines" role="region" aria-label={label} tabIndex={0}
      onScroll={(event) => { const element = event.currentTarget; if (element.scrollHeight - element.scrollTop - element.clientHeight > 24) setFollow(false) }}>
      {lines.length === 0 ? <p>No output yet.</p> : lines.map((line) => <div className="n-log-line" key={line.id} data-tone={line.tone ?? 'neutral'}><span>{line.timestamp}</span><code>{line.message}</code></div>)}
    </div><span className="n-sr-only" role="status">{follow ? 'Following new output.' : 'Output following paused.'}</span>
  </div>
}
