import { InfoHint } from '../../shared/ui/InfoHint'
import {
  BugReportActiveStatusSchema,
  BugReportClosedStatusSchema,
  type BugReport,
  type BugReportClosedStatus,
} from '@foreman-code/contracts/management'
import { useState, type RefObject } from 'react'
import { isAccessFailure } from '../../shared/api/accessErrors'
import { sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { Alert, Badge, Button, Dialog, LoadingState, Select, TextField } from '../../shared/ui/nocturne'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { useBugReport, type BugReportChange } from './bugReportQueries'
import {
  activeStatusOptions, closedStatusOptions, severityLabels, statusLabels,
} from './bugReportPresentation'

function ReportContent({ report }: { report: BugReport }) {
  return <div className="bug-report-content">
    <div className="bug-report-badges">
      <Badge>{severityLabels[report.severity]} severity</Badge>
      <Badge>{statusLabels[report.status]}</Badge>
    </div>
    <section><h3>What they tried</h3><p><strong>{report.tried.feature}</strong></p>
      <p>{report.tried.inputsSummary}</p></section>
    <section><h3>What happened</h3>
      {report.happened.errorCode && <p><code>{report.happened.errorCode}</code></p>}
      <p>{report.happened.message}</p></section>
    <section><h3>Expected behavior</h3><p>{report.expected}</p></section>
    <dl className="bug-report-facts">
      <div><dt>Reporter</dt><dd>{report.reporter.name} ({report.reporter.audience})</dd></div>
      <div><dt>Workspace</dt><dd>{report.workspaceId}</dd></div>
      <div><dt>Harness</dt><dd>{report.harness ?? 'Not recorded'}</dd></div>
      <div><dt>First reported</dt><dd><time dateTime={report.createdAt}>
        {new Date(report.createdAt).toLocaleString()}</time></dd></div>
      <div><dt>Last reported</dt><dd><time dateTime={report.lastReportedAt}>
        {new Date(report.lastReportedAt).toLocaleString()}</time></dd></div>
      <div><dt>Occurrences</dt><dd>{report.occurrenceCount}</dd></div>
      {report.workflowId && <div><dt>Workflow</dt><dd>{report.workflowId}</dd></div>}
      {report.runId && <div><dt>Run</dt><dd>{report.runId}</dd></div>}
      {report.resolution && <>
        <div><dt>{report.status === report.resolution.status ? 'Closed as' : 'Previously closed as'}</dt>
          <dd>{statusLabels[report.resolution.status]}{' '}
            (<time dateTime={report.resolution.closedAt}>{new Date(report.resolution.closedAt).toLocaleString()}</time>)
          </dd></div>
        {report.resolution.duplicateOfId && <div><dt>Duplicate of</dt><dd>{report.resolution.duplicateOfId}</dd></div>}
        {report.resolution.note && <div><dt>Closing note</dt><dd>{report.resolution.note}</dd></div>}
      </>}
    </dl>
  </div>
}

export function BugReportDialog({ reportId, returnFocusRef, onClose }: {
  reportId: string
  returnFocusRef: RefObject<HTMLElement | null>
  onClose(): void
}) {
  const { report, update, denied, uncertain, refresh, retry } = useBugReport(reportId)
  const value = denied ? undefined : report.data
  const updateDenied = isAccessFailure(update.error)
  const [closeAs, setCloseAs] = useState<BugReportClosedStatus>('fixed')
  const [note, setNote] = useState('')
  const [duplicateOfId, setDuplicateOfId] = useState('')
  const active = value?.status === 'open' || value?.status === 'triaged'
  const locked = update.isPending || uncertain
  const invalidDuplicate = closeAs === 'duplicate' && !duplicateOfId.trim()
  const clearCloseDraft = () => {
    setCloseAs('fixed')
    setNote('')
    setDuplicateOfId('')
  }
  const closingChange = (current: BugReport): BugReportChange => ({ kind: 'close', input: {
    commandId: crypto.randomUUID(),
    reports: [{ reportId, expectedRevision: current.revision }],
    status: closeAs,
    ...(note.trim() ? { note: note.trim() } : {}),
    ...(closeAs === 'duplicate' ? { duplicateOfId: duplicateOfId.trim() } : {}),
  } })
  const leave = useUnsavedChanges({
    label: 'Bug report status',
    dirty: Boolean(active && (closeAs !== 'fixed' || note || duplicateOfId)),
    busy: update.isPending,
    uncertain,
    saveDisabled: denied || updateDenied || !value || (!uncertain && invalidDuplicate),
    error: update.isError ? update.error.message : undefined,
    save: async () => {
      if (uncertain) {
        await retry()
        if (update.variables?.kind === 'close') clearCloseDraft()
      } else if (value) {
        await update.mutateAsync(closingChange(value))
        clearCloseDraft()
      }
    },
    discard: clearCloseDraft,
  })
  const requestClose = () => { if (!locked) void leave(onClose) }
  const editDisabled = report.isError || update.isPending || update.isError || sessionIsSwitching()
  const change = (next: BugReportChange) => update.mutate(next, {
    onSuccess: () => { if (next.kind === 'close') clearCloseDraft() },
  })
  return <Dialog open title={value?.title ?? 'Bug report'} size="lg" busy={update.isPending}
    returnFocusRef={returnFocusRef}
    dismissible={!uncertain} onOpenChange={open => { if (!open) requestClose() }}
    footer={<Button disabled={locked} onClick={requestClose}>Close report</Button>}>
    {report.isPending && <LoadingState label="Reading bug report…" />}
    {report.isError && <Alert live tone="danger" title={report.error.message}
      action={<Button disabled={update.isPending} onClick={() => void refresh()}>Refresh report</Button>} />}
    {value && <>
      <ReportContent report={value} />
      <Select label="Report status"
        labelHint={active ? <InfoHint label="Report status">Status changes save immediately.</InfoHint> : undefined}
        hint={active ? undefined : 'Choose Open or Triaged to reopen this report.'}
        value={value.status}
        options={active ? activeStatusOptions
          : [{ value: value.status, label: statusLabels[value.status], disabled: true }, ...activeStatusOptions]}
        disabled={editDisabled}
        onChange={event => change({ kind: 'status', input: {
          commandId: crypto.randomUUID(),
          reportId,
          expectedRevision: value.revision,
          status: BugReportActiveStatusSchema.parse(event.target.value),
        } })} />
      {active && <form className="bug-report-close" aria-label="Close and archive report" onSubmit={event => {
        event.preventDefault()
        change(closingChange(value))
      }}>
        <Select label="Close as" value={closeAs} options={closedStatusOptions} disabled={editDisabled}
          onChange={event => setCloseAs(BugReportClosedStatusSchema.parse(event.target.value))} />
        {closeAs === 'duplicate' && <TextField label="Duplicate of report ID" required value={duplicateOfId}
          disabled={editDisabled} onChange={event => setDuplicateOfId(event.target.value)} />}
        <TextField label="Closing note" labelHint={<InfoHint label="Closing note">Optional, such as the release or commit.</InfoHint>} maxLength={1000}
          value={note} disabled={editDisabled} onChange={event => setNote(event.target.value)} />
        <Button type="submit" disabled={editDisabled || invalidDuplicate}>
          Close and archive
        </Button>
      </form>}
    </>}
    {update.isPending && <p role="status">Saving status…</p>}
    {update.isSuccess && !report.isError && <p role="status">
      {update.variables?.kind === 'close' ? 'Report closed and archived.' : 'Status saved.'}</p>}
    {update.isError && <Alert live tone="danger" title={update.error.message}>
      {updateDenied && <p>Your access does not allow status changes.</p>}
      {uncertain ? <>
        <p>The save is unconfirmed. Retry the same change before leaving.</p>
        <Button disabled={denied || updateDenied} onClick={() => update.variables && change(update.variables)}>
          Retry status save
        </Button>
      </> : <Button disabled={report.isFetching} onClick={() => void refresh()}>Refresh report</Button>}
    </Alert>}
  </Dialog>
}
