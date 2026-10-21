import { InfoHint } from '../../shared/ui/InfoHint'
import { useEffect, useRef, useState } from 'react'
import { Button, Checkbox, TextField, Icon, Alert } from '../../shared/ui/nocturne'
import { useJobLogs } from './query'
import { jobAccessLost, jobError, plainLog } from './model'
import { isTransientReadError } from '../../shared/api/readFailure'

export function JobLogs({ workspaceId, executionId, attemptId, enabled }: { workspaceId: string; executionId: string; attemptId: string; enabled: boolean }) {
  const query = useJobLogs(workspaceId, executionId, attemptId, enabled)
  const [follow, setFollow] = useState(true)
  const [search, setSearch] = useState('')
  const [copyNotice, setCopyNotice] = useState('')
  const viewport = useRef<HTMLDivElement>(null)
  const chunks = query.chunks.map(chunk => ({ ...chunk, text: plainLog(chunk.text) }))
  const filtered = chunks.filter(chunk => chunk.text.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  useEffect(() => {
    if (follow && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight
  }, [follow, query.dataUpdatedAt])
  const { isFetching, hasNextPage, fetchNextPage, refetch } = query
  const isError = query.isError
  const retryable = !query.error || isTransientReadError(query.error)
  const blocked = query.blocked
  useEffect(() => {
    if (!enabled || blocked || !retryable) return
    const timer = window.setInterval(() => {
      if (isFetching) return
      if (hasNextPage && follow && !isError) void fetchNextPage()
      else void refetch()
    }, 3000)
    return () => window.clearInterval(timer)
  }, [enabled, follow, blocked, retryable, isError, isFetching, hasNextPage, fetchNextPage, refetch])
  const pages = query.pages
  return <section aria-label="Job logs" className="job-logs">
    <h2>Logs<InfoHint label="Logs">Older chunks leave this bounded window as new pages load.</InfoHint></h2>
    <div className="job-toolbar">
      <TextField type="search" leading={<Icon name="search" size={16} />} label="Search loaded logs" value={search} onChange={event => setSearch(event.target.value)} labelHint={<InfoHint label="Search loaded logs">Searches only the loaded window, up to 250 chunks.</InfoHint>} />
      <Checkbox label="Follow tail" checked={follow} onChange={event => setFollow(event.target.checked)} />
      <Button disabled={!query.hasNextPage || query.isFetching || !enabled} onClick={() => { void query.fetchNextPage() }}>Load next log page</Button>
      <Button disabled={query.isFetching || !enabled || jobAccessLost(query.error)} onClick={() => { void query.refetch() }}>Refresh logs</Button>
      <Button disabled={!chunks.length} onClick={() => { void (navigator.clipboard?.writeText(filtered.map(chunk => `[${chunk.stream} #${chunk.sequence}] ${chunk.text}`).join('\n')) ?? Promise.reject(new Error('Copy unavailable'))).then(() => setCopyNotice('Loaded text copied.'), () => setCopyNotice('Copy unavailable. Select the log text to copy.')) }}>Copy loaded text</Button>
    </div>
    <p role="status">{copyNotice || `${chunks.length} loaded chunks.`}</p>
    {Boolean(query.error) && <Alert title={chunks.length ? "Logs refresh failed" : "Logs unavailable"} tone="warning">{jobError(query.error)}</Alert>}
    {pages.some(page => page.truncated) && <Alert title="Logs truncated" tone="warning">Logs were truncated under the accepted log policy. This is not the full output.</Alert>}
    {pages.flatMap((page, index) => page.gap ? [<Alert title="Log gap" tone="warning" key={index}>Log gap: sequences {page.gap.from}–{page.gap.to} unavailable.</Alert>] : [])}
    <div ref={viewport} className="job-log-window" tabIndex={0} aria-label="Loaded stdout and stderr" onScroll={() => {
      const element = viewport.current
      if (element && element.scrollHeight - element.scrollTop - element.clientHeight > 24) setFollow(false)
    }}>
      {filtered.map(chunk => <div key={`${chunk.attemptId}:${chunk.sequence}`} className="job-log-chunk"><span className="job-log-stream">{chunk.stream} #{chunk.sequence}</span><pre>{chunk.text}</pre></div>)}
      {!query.isError && !filtered.length && <p>{query.isPending ? 'Loading logs…' : search ? 'No match in loaded logs.' : 'No persisted output loaded.'}</p>}
    </div>
  </section>
}
