import type { HierarchyReport } from '@foreman-code/contracts'
import { Button, Dialog } from '../../shared/ui/nocturne'

/** The selected immutable report is already bounded; opening it never loads a transcript. */
export function ReportDetail({ report, close, showExecution, showCard }: {
  report: HierarchyReport | undefined; close(): void; showExecution(report: HierarchyReport): void
  showCard?(cardId: string, report: HierarchyReport): void
}) {
  return <Dialog open={!!report} onOpenChange={open => { if (!open) close() }} title="Team report" closeLabel="Close report">
    {report ? <ReportContents report={report} showExecution={value => { showExecution(value); close() }} showCard={showCard} /> : null}
  </Dialog>
}

export function ReportContents({ report, showExecution, showCard }: { report: HierarchyReport;
  showExecution(report: HierarchyReport): void; showCard?(cardId: string, report: HierarchyReport): void }) {
  return <section aria-label="Selected immutable report">
      <h3>{report.agent.displayName}</h3>
      <p>{report.state} · {new Date(report.updatedAt).toLocaleString()}</p>
      <p>{report.summary}</p>
      <dl>
        <dt>Run</dt><dd><code>{report.execution.runId}</code></dd>
        <dt>Saved workflow</dt><dd><code>{report.execution.workflowVersionId}</code></dd>
        <dt>Agent configuration</dt><dd><code>{report.agent.configurationVersionId}</code></dd>
        <dt>Execution</dt><dd><code>{report.execution.executionId}</code> · attempt {report.execution.attempt}</dd>
        <dt>Activation</dt><dd><code>{report.execution.activationId}</code></dd>
        <dt>Parent request</dt><dd><code>{report.parentRequestId}</code></dd>
        <dt>Source event</dt><dd><code>{report.sourceEventKey}</code></dd>
      </dl>
      {report.cardIds.length ? <section aria-label="Linked memory cards"><h4>Linked cards</h4><ul>
        {report.cardIds.map(cardId => <li key={cardId}>{showCard
          ? <Button size="sm" onClick={() => showCard(cardId, report)}>Open card {cardId}</Button>
          : <code>{cardId}</code>}</li>)}
      </ul></section> : null}
      <Button onClick={() => showExecution(report)}>Show execution</Button>
    </section>
}
