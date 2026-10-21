import { useState } from 'react'
import type { AgentIdentity, HierarchyReport, WorkflowHierarchyReadInput } from '@foreman-code/contracts'
import { Alert, Button, Dialog } from '../../shared/ui/nocturne'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { useHierarchyReportHistory } from './queries'
import { ReportContents } from './ReportDetail'

/** Mounted only after an explicit history action. No transcript is fetched here. */
export function HierarchyReportHistory({ scope, agent, initialReport, close, showExecution, showCard, visible = true }: {
  scope: WorkflowHierarchyReadInput; agent: AgentIdentity; initialReport?: HierarchyReport; close(): void
  showExecution(report: HierarchyReport): void; showCard?(cardId: string, report: HierarchyReport): void; visible?: boolean
}) {
  const history = useHierarchyReportHistory(scope, agent.workflowNodeId, { enabled: visible })
  const denied = useProtectedAccessError({ ...history,
    isSuccess: history.isSuccess && !history.refresh.isPending && !history.refresh.isError,
  }, history.refresh.error)
  const [selected, setSelected] = useState(initialReport)
  const byId = new Map<string, HierarchyReport>()
  for (const page of history.data?.pages ?? []) {
    for (const report of page.items) if (!byId.has(report.id)) byId.set(report.id, report)
  }
  const reports = [...byId.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
  const failure = history.error ?? history.refresh.error
  const refresh = <Button disabled={history.isFetching || history.refresh.isPending}
    onClick={() => history.refresh.mutate()}>Refresh reports</Button>
  return <Dialog open={visible} onOpenChange={open => { if (!open) close() }} title={`${agent.displayName} · Report history`} closeLabel="Close report history">
    {denied ? <Alert tone="warning" title="Report history is no longer available with your access.">{refresh}</Alert> : <>
      <p>Selected Run · {scope.runId}. Each report keeps its original business request, execution and attempt.</p>
      {refresh}
      {history.isLoading ? <p role="status">Loading report history…</p> : null}
      {failure ? <Alert tone="warning" title="Couldn’t refresh report history.">{failure.message}</Alert> : null}
      <ol className="hierarchy-report-history-rounds" aria-label="Report rounds">{reports.map(report => <li key={report.id}>
        <Button size="sm" aria-pressed={selected?.id === report.id} onClick={() => setSelected(report)}>
          {report.state} · {new Date(report.updatedAt).toLocaleString()} · {report.parentRequestId} · attempt {report.execution.attempt}
        </Button><p>{report.summary}</p>
      </li>)}</ol>
      {history.isSuccess && !reports.length ? <p>No reports yet</p> : null}
      {history.hasNextPage ? <Button disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>Load earlier reports</Button> : null}
      {selected ? <ReportContents report={selected} showCard={showCard} showExecution={report => { showExecution(report); close() }} /> : null}
    </>}
  </Dialog>
}
