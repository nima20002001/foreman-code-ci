import type { ComposerSessionControls } from './useSessionControls'

export function CompactionActivity({ controls }: { controls: ComposerSessionControls }) {
  const saved = controls.state?.compactions ?? []
  const current = controls.state?.compaction
  const updated = saved.map(entry => current && entry.requestId === current.requestId ? current : entry)
  const entries = current && !saved.some(entry => entry.requestId === current.requestId) ? [...updated, current] : updated
  if (!entries.length) return null
  return <div aria-label="Context compaction activity" className="session-compaction-activity">
    {entries.map(entry => <p key={entry.requestId} role="status">Context · {entry.message}</p>)}
  </div>
}
