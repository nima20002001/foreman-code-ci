import { useState } from 'react'
import type { RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { Alert, Badge, Button } from '../../shared/ui/nocturne'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { repeatGraphClient, type RepeatGraphClient } from './canonicalClient'
import { useCurrentRunQuery } from '../workflow-board/currentRunQuery'
import { RepeatResultDetails } from './RepeatResultDetails'
import './repeats.css'

const reasonLabel = (reason: 'repeat' | 'early_exit' | 'limit_exit') => reason === 'repeat' ? 'Repeat decided'
  : reason === 'early_exit' ? 'Early exit' : 'Limit exit'

/** Only a complete canonical cut supplies status. Private result pages are not a
 * fallback for an unqualified graph reader, nor evidence that a Run is active. */
export function RepeatStatus({ scope, live = true, client = repeatGraphClient }: {
  scope: RepeatGraphScopeV3; live?: boolean; client?: RepeatGraphClient
}) {
  const [resultsOpen, setResultsOpen] = useState(false)
  const query = useCurrentRunQuery(scope, live, client)
  const denied = useProtectedAccessError(query)
  const retry = <Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>Retry</Button>
  if (denied || query.isError) return <section className="repeat-status" role="alert" aria-label="Repeat state unavailable">
    <Alert tone="warning" title="Repeat state is unavailable.">
      {denied ? 'Access to this Run is unavailable.' : 'The canonical v3 read could not be verified. It may not be qualified on this deployment.'}
      {' '}No occurrence, retry, early-exit, or limit state was guessed from timing. Earlier cached facts are not presented as current.
    </Alert>{retry}
  </section>
  if (!query.data) return <section className="repeat-status" role="status">Loading repeat occurrences…</section>
  const snapshot = query.data
  const repeat = snapshot.topology.repeat
  if (!repeat) return null
  const decisions = new Map(snapshot.state.decisions.map((decision) => [decision.occurrence.identity.occurrenceId, decision]))
  const historical = snapshot.state.run.executionState === 'completed'
  const occurrences = [...snapshot.state.occurrences].sort((a, b) =>
    a.identity.blockId.localeCompare(b.identity.blockId) || a.identity.occurrenceIndex - b.identity.occurrenceIndex)
  return <section className="repeat-status" aria-label="Repeat occurrences">
    <header><div><h3>Business occurrences</h3><p>Run <code>{scope.runId}</code> · version <code>{scope.workflowVersionId}</code></p></div>
      <Badge tone={historical ? 'neutral' : 'warning'} dot>{historical ? 'Historical Run' : 'Current Run'}</Badge></header>
    <p className="repeat-muted">Occurrence numbers count business repetition. A technical attempt is separate and never consumes the repeat cap.</p>
    <p role="status">Recorded Run state: {snapshot.state.run.executionState} · {snapshot.state.run.outcome}.
      {' '}Complete cut {snapshot.asOfSequence}.{snapshot.state.run.stopRequested ? ' Stop requested; this is not proof of native cleanup.' : ''}
      {query.isFetching ? ' Refreshing the same Run/version…' : ''}</p>
    {!occurrences.length ? <p className="repeat-empty">No durable repeat occurrence has been recorded in this complete cut.</p> : <ol className="repeat-occurrences">
      {occurrences.map((occurrence) => {
        const identity = occurrence.identity, decision = decisions.get(identity.occurrenceId)
        const block = repeat.blocks.find((item) => item.id === identity.blockId)!
        const executions = snapshot.state.executions.filter((item) => item.identity.occurrence?.occurrenceId === identity.occurrenceId)
          .sort((a, b) => a.identity.workflowNodeId.localeCompare(b.identity.workflowNodeId) || a.identity.attempt - b.identity.attempt)
        return <li key={identity.occurrenceId} className="repeat-occurrence">
          <div className="repeat-occurrence-line"><strong>{identity.blockId} · business occurrence {identity.occurrenceIndex} of {block.maxOccurrences}</strong>
            <Badge tone={decision?.reason === 'limit_exit' ? 'warning' : 'neutral'}>{decision ? reasonLabel(decision.reason) : 'Occurrence recorded'}</Badge></div>
          <dl><div><dt>Occurrence ID</dt><dd><code>{identity.occurrenceId}</code></dd></div>
            <div><dt>Input binding</dt><dd><code>{occurrence.input.bindingId}</code></dd></div><div><dt>Exact occurrence input provenance</dt><dd><pre>{JSON.stringify(occurrence.input, null, 2)}</pre></dd></div>
            {decision ? <><div><dt>Exit technical attempt</dt><dd>{decision.exitExecution.attempt} <span className="repeat-muted">(same business occurrence)</span></dd></div>
              <div><dt>Outcome</dt><dd><code>{decision.outcome}</code> · {reasonLabel(decision.reason)}</dd></div>
              <div><dt>Accepted result digest</dt><dd><code>{decision.acceptedResultDigest}</code></dd></div>
              {decision.reason === 'repeat' && decision.target.kind === 'next_occurrence' ? <div><dt>Next occurrence</dt><dd>
                Requested occurrence {decision.target.occurrenceIndex}. A decision alone is not evidence of activation.</dd></div> : null}
            </> : <div><dt>Decision</dt><dd>Not recorded yet.</dd></div>}
          </dl>
          {executions.length ? <ul aria-label={`Technical attempts for ${identity.blockId} occurrence ${identity.occurrenceIndex}`}>
            {executions.map(({ identity: execution, state, resultOutcome }) => <li key={execution.executionId}>
              <code>{execution.workflowNodeId}</code> · technical attempt {execution.attempt} · {state}{resultOutcome ? ` · ${resultOutcome}` : ''}
              {' '}<code>{execution.executionId}</code>
            </li>)}
          </ul> : <p className="repeat-muted">No execution is recorded for this occurrence.</p>}
        </li>
      })}
    </ol>}
    <p className="repeat-muted">This view contains canonical metadata only. Result digests do not disclose deliverables or remaining findings.</p>
    <Button size="sm" variant="ghost" aria-expanded={resultsOpen} onClick={() => setResultsOpen((value) => !value)}>
      {resultsOpen ? 'Hide accepted results' : 'Read accepted results'}</Button>
    {resultsOpen ? <RepeatResultDetails snapshot={snapshot} /> : null}
    <Button size="sm" variant="secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh repeat state</Button>
  </section>
}
