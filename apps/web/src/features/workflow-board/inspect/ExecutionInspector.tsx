import { InfoHint } from '../../../shared/ui/InfoHint'
import { useMemo } from 'react'
import { ExecutionBranch } from './ExecutionBranch'
import { useQueryClient } from '@tanstack/react-query'
import {
  readRunInspectionKey, runInspectionKey, type RepeatGraphScopeV3, type RunExecutionDetail,
  type RunExecutionSummary, type WorkflowVersionV3, type WorkspaceBoardExecutionSelection,
} from '@foreman-code/contracts/wave25'
import { Alert, Button, Select } from '../../../shared/ui/nocturne'
import { useProtectedAccessError } from '../../../shared/api/useProtectedAccessError'
import { JobRunResult } from '../../jobs/JobRunResult'
import { useWorkflowBoard } from '../context'
import { assertExecutionVersion } from '../runDetailsClient'
import { useBindingPages, useExecutionPages, useExecutionQuery, executionPagesKey, bindingsPagesKey, refreshFirstInspectionPage } from './queries'
import { useInspectionPresentation } from './presentation'
import { JsonValue, JsonDisclosure } from './JsonValue'
import './inspection.css'

export function ExecutionInspector({ scope, version }: { scope: RepeatGraphScopeV3; version: WorkflowVersionV3 }) {
  const board = useWorkflowBoard(), cache = useQueryClient()
  const inspection = board?.inspection ?? {}
  const selection = readRunInspectionKey(inspection.runExchangeKey)
  const relationship = version.definition.edges.find((edge) => edge.id === inspection.runRelationshipId)
  const nodeId = inspection.runNodeId ?? relationship?.target
  const node = version.definition.nodes.find((item) => item.id === nodeId)
  const unavailable = !!nodeId && !node || !!inspection.runRelationshipId && !relationship
    || !!selection.occurrenceId && !version.definition.repeat
  const filters = { workflowNodeId: nodeId, occurrenceId: selection.occurrenceId }
  const pages = useExecutionPages(scope, filters, !unavailable)
  const denied = useProtectedAccessError(pages)
  const verifiedPage = useMemo(() => {
    if (denied || unavailable) return { items: [], invalid: false }
    const unique = new Map<string, RunExecutionSummary>()
    try {
      for (const page of pages.data?.pages ?? []) for (const execution of page.items) {
        assertExecutionVersion(version, execution)
        unique.set(execution.executionId, execution)
      }
      return { items: [...unique.values()], invalid: false }
    } catch { return { items: [], invalid: true } }
  }, [pages.data, denied, unavailable, version])
  const listed = verifiedPage.items
  const select = (next: WorkspaceBoardExecutionSelection) => board?.selectInspection({
    ...(inspection.runNodeId ? { runNodeId: inspection.runNodeId } : {}),
    ...(inspection.runRelationshipId ? { runRelationshipId: inspection.runRelationshipId } : {}),
    ...(runInspectionKey(next) ? { runExchangeKey: runInspectionKey(next) } : {}),
  })
  const occurrences = new Map(listed.flatMap((execution) => execution.occurrence
    ? [[execution.occurrence.occurrenceId, execution.occurrence] as const] : []))
  return <section aria-label="Exact execution inputs and results" className="run-execution-inspector">
    <header><h3>Execution inputs and accepted results<InfoHint label="Execution history">History is a recorded read, not a live status feed. It changes only when you load or refresh it. Only the five most recently loaded pages are retained. Refresh returns to the first page.</InfoHint></h3>
      {(nodeId || inspection.runRelationshipId || inspection.runExchangeKey) ? <Button size="sm" onClick={() => board?.selectInspection({})}>Clear detail filter</Button> : null}
    </header>
    <Select label="Run node" value={inspection.runNodeId ?? ''} onChange={(event) =>
      board?.selectInspection(event.target.value ? { runNodeId: event.target.value } : {})} options={[
      { value: '', label: 'All nodes in this saved version' },
      ...(inspection.runNodeId && !node ? [{ value: inspection.runNodeId, label: `${inspection.runNodeId} — not in this Run` }] : []),
      ...version.definition.nodes.map((item) => ({ value: item.id, label: `${item.name ?? item.label ?? item.id} · ${item.id}` })),
    ]} />
    {unavailable ? <Alert tone="warning" title="This selection is not in the Run’s saved version.">
      A node or repetition in the current draft is not historical evidence. Clear the filter to inspect this exact version.
    </Alert> : <>
      {relationship ? <p>Relationship <code>{relationship.id}</code>: inspecting recipient <code>{relationship.target}</code>.</p> : null}
      {node ? <JsonDisclosure disclosureKey={JSON.stringify([scope, node.id, 'saved-node'])}
        summary="Saved node configuration (this Run)" label={`Saved Run node ${node.id}`}
        value={node.kind==='job'?{node,jobDefinitionVersionId:node.jobDefinitionVersionId}:{node,agentConfigurationVersionId:version.agentConfigurationVersionIds[node.agentId]}} /> : null}
      {version.definition.repeat ? <div className="run-occurrence-picker">
        <Select label="Business repetition" labelHint={<InfoHint label="Business repetition">Options come from loaded execution pages only. Load more executions to discover older or later repetitions. An attempt is not a repetition.</InfoHint>} value={selection.occurrenceId ?? ''} onChange={(event) => select(event.target.value ? { occurrenceId: event.target.value } : {})} options={[
          { value: '', label: 'All recorded repetitions' },
          ...(selection.occurrenceId && !occurrences.has(selection.occurrenceId) ? [{ value: selection.occurrenceId, label: `Requested occurrence ${selection.occurrenceId}` }] : []),
          ...[...occurrences.values()].sort((x, y) => x.blockId.localeCompare(y.blockId) || x.occurrenceIndex - y.occurrenceIndex)
            .map((item) => ({ value: item.occurrenceId, label: `${item.blockId} · repetition ${item.occurrenceIndex} · ${item.occurrenceId}` })),
        ]} />
      </div> : <p>This saved version has no repeat blocks.</p>}
      {denied ? <Alert tone="warning" title="Execution history access is unavailable." /> : pages.isError ? <Alert tone="warning" title="Execution history could not be refreshed.">
        Previously loaded executions stay listed. <Button size="sm" onClick={() => void refreshFirstInspectionPage(cache, executionPagesKey(scope, filters))}>Retry executions</Button>
      </Alert> : null}
      {verifiedPage.invalid ? <Alert tone="warning" title="Execution history does not match the immutable version.">No mismatched execution is displayed.</Alert> : null}
      {pages.isPaused ? <p role="status">Execution history refresh is paused. Loaded pages remain recorded history, not current state.</p>
        : pages.isPending && !denied ? <p role="status">Loading the first execution page…</p> : null}
      {!pages.isPending && !pages.isError && !denied && !verifiedPage.invalid && !listed.length ? <p>No execution is recorded for this selection.</p> : null}
      <ol className="run-execution-list">{listed.map((execution) => <li key={execution.executionId}>
        <Button size="sm" aria-pressed={selection.executionId === execution.executionId}
          onClick={() => select({ ...selection, executionId: execution.executionId })}>
          {execution.workflowNodeId} · technical attempt {execution.attempt} · {execution.executionId}
        </Button>
        <p>Recorded {execution.state}. {execution.acceptedResultAvailable ? 'An accepted result is available.' : 'No accepted result reported by this page.'}</p>
        {execution.occurrence ? <p>{execution.occurrence.blockId} · business occurrence {execution.occurrence.occurrenceIndex} · <code>{execution.occurrence.occurrenceId}</code></p> : null}
        <ExecutionBranch execution={execution} />
      </li>)}</ol>
      <div className="n-actions">
        {pages.hasNextPage && !pages.isError && !denied ? <Button size="sm" disabled={pages.isFetching}
          onClick={() => void pages.fetchNextPage()}>Load more executions</Button> : null}
        <Button size="sm" variant="ghost" disabled={pages.isFetching || !!denied}
          onClick={() => void refreshFirstInspectionPage(cache, executionPagesKey(scope, filters))}>Refresh executions</Button>
      </div>
      {selection.executionId && !denied ? <ExactExecution key={JSON.stringify([scope, selection.executionId])}
        scope={scope} version={version} executionId={selection.executionId} nodeId={nodeId}
        occurrenceId={selection.occurrenceId} relationshipId={inspection.runRelationshipId} /> : null}
    </>}
  </section>
}

function ExactExecution({ scope, version, executionId, nodeId, occurrenceId, relationshipId }: {
  scope: RepeatGraphScopeV3; version: WorkflowVersionV3; executionId: string
  nodeId?: string; occurrenceId?: string; relationshipId?: string
}) {
  const query = useExecutionQuery(scope, executionId)
  const denied = useProtectedAccessError(query)
  const checked = useMemo(() => {
    if (!query.data || denied) return undefined
    try {
      assertExecutionVersion(version, query.data.execution)
      if (nodeId && query.data.execution.workflowNodeId !== nodeId
        || occurrenceId && query.data.execution.occurrence?.occurrenceId !== occurrenceId) return undefined
      return query.data
    } catch { return undefined }
  }, [query.data, denied, version, nodeId, occurrenceId])
  if (query.isPending) return <p role="status">{query.isPaused ? 'Exact execution read is paused. No substitute result is shown.'
    : 'Reading this exact execution, accepted input and result…'}</p>
  if (!checked) return <Alert tone="warning" title="This exact execution is unavailable.">
    {denied ? 'Access was denied.' : 'The read failed or its node, occurrence, configuration or result identity did not match. No substitute result is displayed.'}
    {!denied ? <Button size="sm" onClick={() => void query.refetch()}>Retry exact execution</Button> : null}
  </Alert>
  const execution = checked.execution, occurrence = execution.occurrence
  return <article aria-label={`Execution ${executionId}`} className="run-exact-execution">
    <h4>{execution.workflowNodeId} · technical attempt {execution.attempt}</h4>
    {query.isPaused ? <p role="status">Refresh is paused. These are previously verified recorded execution facts.</p> : null}
    <dl><dt>Execution identity</dt><dd><code>{execution.executionId}</code></dd>
      <dt>Immutable configuration</dt><dd><code>{execution.kind==='job'?execution.jobDefinitionVersionId:execution.agentConfigurationVersionId}</code></dd>
      <dt>Business occurrence</dt><dd>{occurrence
        ? <>{occurrence.blockId} · {occurrence.occurrenceIndex} · <code>{occurrence.occurrenceId}</code></> : 'None — ordinary execution outside a configured repeat block'}</dd>
      <dt>Recorded state</dt><dd>{execution.state}</dd></dl>
    {execution.kind === 'job' ? <section aria-label={`Job result for execution ${executionId}`}>
      <JobRunResult key={executionId} definitionVersionId={execution.jobDefinitionVersionId} reference={{ kind: 'job',
        workspaceId: scope.workspaceId, workflowId: scope.workflowId, runId: scope.runId, workflowVersionId: scope.workflowVersionId,
        nodeId: execution.workflowNodeId, nodeExecutionId: execution.executionId,
        occurrenceId: occurrence?.occurrenceId ?? null, occurrenceIndex: occurrence?.occurrenceIndex ?? 0 }} />
    </section> : null}
    <p>Accepted input digest <code>{checked.acceptedInput.digest}</code></p>
    <JsonValue label={`Input ${executionId}`} value={checked.acceptedInput.value} />
    {checked.acceptedResult.status === 'accepted' ? <>
      <p>Accepted result digest <code>{checked.acceptedResult.digest}</code></p>
      <JsonValue label={`Accepted result ${executionId}`} value={checked.acceptedResult.value} />
    </> : <p>No accepted result is recorded for this exact execution. <InfoHint label="Accepted result">A native terminal report is not an accepted predecessor result.</InfoHint></p>}
    {checked.reportedResult ? <JsonDisclosure disclosureKey={JSON.stringify([scope, executionId, 'native-report'])}
      summary="Recorded execution result (not proof of acceptance)" label={`Reported result ${executionId}`} value={checked.reportedResult} /> : null}
    <Button size="sm" variant="ghost" disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh exact execution</Button>
    <ExecutionBindings scope={scope} detail={checked} relationshipId={relationshipId} />
  </article>
}

function ExecutionBindings({ scope, detail, relationshipId }: { scope: RepeatGraphScopeV3; detail: RunExecutionDetail; relationshipId?: string }) {
  const cache = useQueryClient()
  const disclosure = JSON.stringify([scope, detail.execution.executionId, 'bindings'])
  const open = useInspectionPresentation((state) => !!state.open[disclosure])
  const query = useBindingPages(scope, detail, open)
  const denied = useProtectedAccessError(query)
  const bindings = denied ? [] : [...new Map(
    (query.data?.pages.flatMap((page) => page.items) ?? []).map((binding) => [binding.bindingId, binding]),
  ).values()]
  const visible = relationshipId ? bindings.filter((binding) => binding.kind !== 'carry' && binding.source.relationshipId === relationshipId) : bindings
  return <details open={open} onToggle={(event) => useInspectionPresentation.getState().setOpen(disclosure, event.currentTarget.open)}>
    <summary>Exact predecessor/result bindings</summary>
    {open ? <>
      {query.isPaused ? <p role="status">Input binding refresh is paused.</p> : query.isPending ? <p role="status">Loading input bindings…</p> : null}
      {query.isError || denied ? <Alert tone="warning" title="Input bindings are unavailable.">
        {bindings.length ? 'Previously loaded bindings stay listed. ' : 'No stale bindings are substituted. '}{!denied ? <Button size="sm" onClick={() => void refreshFirstInspectionPage(cache, bindingsPagesKey(scope, detail))}>Retry bindings</Button> : null}
      </Alert> : null}
      <ol>{visible.map((binding) => <li key={binding.bindingId}><p>{binding.kind} · ordinal {binding.ordinal} · <code>{binding.bindingId}</code></p>
        <JsonValue label={`Binding ${binding.bindingId}`} value={binding} /></li>)}</ol>
      {query.data && !query.isError && !denied && !visible.length ? <p>No matching bindings in the loaded pages.</p> : null}
      {query.hasNextPage && !query.isError && !denied ? <Button size="sm" disabled={query.isFetching}
        onClick={() => void query.fetchNextPage()}>Load more bindings</Button> : null}
      <Button size="sm" variant="ghost" disabled={query.isFetching || !!denied}
        onClick={() => void refreshFirstInspectionPage(cache, bindingsPagesKey(scope, detail))}>Refresh bindings</Button>
    </> : null}
  </details>
}
