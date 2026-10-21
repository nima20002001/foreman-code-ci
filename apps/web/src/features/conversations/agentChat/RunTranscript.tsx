import { Button } from '../../../shared/ui/nocturne'
import { AgentChatMessage } from './AgentChatMessage'
import { AgentChatActivity } from './AgentChatActivity'
import { executionIsLive, type useExecutionActivity } from './executionActivity'

const states: Record<string, string> = {
  queued: 'Queued', starting: 'Starting', running: 'Working', completed: 'Completed', failed: 'Failed', canceled: 'Stopped', interrupted: 'Interrupted',
}

/** Live public activity of the selected Run Agent's executions, including interval checks and retries. */
export function RunTranscript({ feed, name, onBrowse }: {
  feed: ReturnType<typeof useExecutionActivity>; name: string; onBrowse(): void
}) {
  const data = feed.query.data
  if (!data) return feed.query.isError ? <p className="agent-chat-note" role="alert">Execution activity could not be loaded.</p> : null
  const labelled = data.executions.length > 1 || data.executions.some(execution => execution.label !== 'Execution')
  return <section aria-label="Workflow execution transcript">
    {data.hasEarlierExecutions ? <p className="agent-chat-note">Newest 20 executions</p> : null}
    {data.executions.map(execution => {
      const history = data.history?.executionId === execution.executionId ? data.history : undefined
      const items = history?.items ?? data.items.filter(item => item.executionId === execution.executionId)
      const hasEarlierItems = history?.hasEarlierItems ?? execution.hasEarlierItems
      const historyRead = feed.readState(execution.executionId)
      const label = `${execution.label} · ${states[execution.state] ?? execution.state}`
      return <section key={execution.executionId} className="agent-chat-execution" aria-label={label}>
        {labelled ? <p className="agent-chat-execution-label" role="heading" aria-level={3}>{label}</p> : null}
        {history ? <p className="agent-chat-note">Earlier activity <Button size="sm" variant="ghost"
          onClick={() => { onBrowse(); feed.backToLatest() }}>Back to latest activity</Button></p> : null}
        {hasEarlierItems ? <Button size="sm" variant="ghost" disabled={historyRead.pending}
          onClick={() => { onBrowse(); feed.loadEarlier(execution.executionId) }}>
          {historyRead.pending ? 'Loading earlier activity…' : 'Load earlier activity'}
        </Button> : null}
        {historyRead.failed ? <p role="alert">Earlier activity could not be loaded.{' '}
          <Button size="sm" variant="ghost" onClick={() => { onBrowse(); feed.loadEarlier(execution.executionId) }}>
            Retry earlier activity
          </Button>
        </p> : null}
        {!items.length && executionIsLive(execution) ? <p className="agent-chat-note">Waiting for the first activity…</p> : null}
        <ol className="agent-chat-messages" aria-label="Execution activity">
          {items.map(item => <li key={item.id}>{item.entry.kind === 'message'
            ? <AgentChatMessage message={item.entry.message} name={name}
              onExpand={() => { onBrowse(); return feed.expand(item.executionId, item.id) }} />
            : <AgentChatActivity entry={item.entry.activity} onBrowse={onBrowse}
              expandState={feed.readState(item.executionId, item.id)}
              onExpand={() => feed.expand(item.executionId, item.id)} />}</li>)}
        </ol>
      </section>
    })}
  </section>
}
