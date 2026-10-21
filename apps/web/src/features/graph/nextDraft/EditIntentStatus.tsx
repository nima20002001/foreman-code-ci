import type { GraphEditReadResultV3 } from '@foreman-code/contracts/wave25'
import { Alert } from '../../../shared/ui/nocturne'

/** Progress of a save that waits for affected Runs to stop. Recovery stays on the board, never in a second Run page. */
export function EditIntentStatus({ data }: { data: GraphEditReadResultV3 }) {
  const intent = data.intent
  if (!intent) return null
  const waiting = data.current.filter((item) => !item.settled).length
  const tone = intent.state === 'saved' ? 'success' : intent.error || data.affectedSetChanged ? 'danger' : intent.state === 'discarded' ? 'neutral' : 'warning'
  const title = intent.state === 'saved' ? 'Changes saved.' : intent.state === 'discarded' ? 'The pending save was discarded.'
    : intent.state === 'staged' ? 'Edits staged. Stop has not been requested.' : intent.state === 'blocked' || intent.state === 'uncertain' ? 'Save is not confirmed.'
    : waiting ? `Saving once ${waiting} ${waiting === 1 ? 'run stops' : 'runs stop'}.` : 'Finishing the save…'
  return <Alert tone={tone} title={title}>
    <div className="board-edit-intent" aria-label="Retained edits and affected Runs">
      {intent.state === 'saved' ? <p>Stopped runs were not restarted.</p>
        : intent.state === 'discarded' ? null
          : <p>Your changes are kept until every affected run has fully stopped and cleaned up.</p>}
      {intent.error ? <p role="alert">{intent.error.message}</p> : null}
      {data.affectedSetChanged ? <p role="alert">New runs started with these agents. Discard this save and try again.</p> : null}
      {!data.canStop && data.current.some((item) => !item.settled) ? <p role="alert">You don’t have permission to stop every affected run.</p> : null}
      {data.current.length ? <details><summary>Affected runs ({data.current.length})</summary>
        <ul>{data.current.map((item) => <li key={item.pin.runId}><code>{item.pin.runId.slice(-8)}</code>{' · '}
          {item.settled ? 'Stopped' : item.terminal ? 'Cleaning up' : 'Still running'}
          {item.pin.workflowId !== intent.workflowId ? ' · another workflow' : ''}</li>)}</ul>
      </details> : null}
      <details><summary>Technical details</summary>
        <pre>{JSON.stringify({ intent: intent.id, state: intent.state, revision: intent.expectedRevision, version: intent.expectedWorkflowVersionId,
          stageCommandId: intent.stageCommandId, advanceCommandId: intent.advanceCommandId, discardCommandId: intent.discardCommandId,
          stops: intent.stops, affected: data.current.map((item) => item.pin) }, null, 2)}</pre>
      </details>
    </div>
  </Alert>
}
