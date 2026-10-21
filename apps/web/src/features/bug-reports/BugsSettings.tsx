import { InfoHint } from '../../shared/ui/InfoHint'
import {
  BugReportSeveritySchema,
  BugReportStatusSchema,
  BugReportViewSchema,
  type BugReport,
  type BugsSettingsSearch,
} from '@foreman-code/contracts/management'
import { useRef } from 'react'
import { useAccessFailureLatch } from '../../shared/api/useAccessFailureLatch'
import { LoadMore } from '../../shared/ui/LoadMore'
import { Alert, Button, EmptyState, Icon, LoadingState, Select } from '../../shared/ui/nocturne'
import { BugReportDialog } from './BugReportDialog'
import { useBugReports } from './bugReportQueries'
import {
  activeStatusOptions, closedStatusOptions, severityLabels, severityOptions, statusLabels,
} from './bugReportPresentation'
import '../settings/settingsExperience.css'
import './bugsSettings.css'

function ReportCard({ report, onSelect }: { report: BugReport; onSelect(): void }) {
  return <li className="settings-choice">
    <button className="settings-choice-open" type="button" onClick={onSelect} aria-label={`Read ${report.title}`}>
      <span className="settings-choice-heading">
        <span className="settings-choice-icon"><Icon name="warning" size={21} /></span>
        <span><strong>{report.title}</strong><small>{report.tried.feature}</small></span>
        <Icon name="chevron" size={17} />
      </span>
      <span className="settings-choice-summary">
        <span className="settings-summary-row"><span>Status</span><strong>{statusLabels[report.status]}</strong></span>
        <span className="settings-summary-row"><span>Severity</span><strong>{severityLabels[report.severity]}</strong></span>
        <span className="settings-summary-row"><span>Reporter</span><strong>{report.reporter.name}</strong></span>
        <span className="settings-summary-row"><span>Reported</span><strong><time dateTime={report.createdAt}>
          {new Date(report.createdAt).toLocaleString()}</time></strong></span>
        {report.resolution && <span className="settings-summary-row"><span>Closed</span><strong>
          <time dateTime={report.resolution.closedAt}>{new Date(report.resolution.closedAt).toLocaleString()}</time>
        </strong></span>}
      </span>
    </button>
  </li>
}

export function BugsSettings({ search, onSearchChange }: {
  search: BugsSettingsSearch
  onSearchChange(search: BugsSettingsSearch): void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  const reports = useBugReports(search)
  const denied = useAccessFailureLatch(reports)
  const items = denied ? [] : reports.data?.pages.flatMap(page => page.items) ?? []
  const filters = { ...search }
  delete filters.reportId
  const history = search.view === 'history'
  return <section className="settings-editor-page" aria-label="Bug reports">
    <header className="settings-experience-heading"><h1 ref={heading} tabIndex={-1}>Bugs</h1><InfoHint label="Bugs">Reports submitted by Agents appear here. Closed reports are in history.</InfoHint></header>
    <div className="bug-report-filters">
      <Select label="Show reports" value={search.view ?? 'active'}
        options={[{ value: 'active', label: 'Active' }, { value: 'history', label: 'History' }]}
        onChange={event => {
          const next = { ...filters }
          delete next.status
          if (event.target.value === 'history') next.view = BugReportViewSchema.parse(event.target.value)
          else delete next.view
          onSearchChange(next)
        }} />
      <Select label="Filter by status" value={search.status ?? ''}
        options={[{ value: '', label: 'All statuses' }, ...(history ? closedStatusOptions : activeStatusOptions)]}
        onChange={event => {
          const next = { ...filters }
          if (event.target.value) next.status = BugReportStatusSchema.parse(event.target.value)
          else delete next.status
          onSearchChange(next)
        }} />
      <Select label="Filter by severity" value={search.severity ?? ''}
        options={[{ value: '', label: 'All severities' }, ...severityOptions]}
        onChange={event => {
          const next = { ...filters }
          if (event.target.value) next.severity = BugReportSeveritySchema.parse(event.target.value)
          else delete next.severity
          onSearchChange(next)
        }} />
    </div>
    {reports.isPending && <LoadingState label="Reading bug reports…" />}
    {reports.isError && <Alert live tone="danger" title={reports.error.message}
      action={<Button disabled={reports.isFetching} onClick={() => void reports.refetch()}>Refresh bug reports</Button>} />}
    {!reports.isPending && !reports.isError && !items.length && <EmptyState
      title={history ? 'No closed bug reports' : 'No active bug reports'} />}
    {items.length > 0 && <ul className="settings-choice-grid bug-report-list" aria-label="Bug reports, newest first">
      {items.map(report => <ReportCard key={report.id} report={report}
        onSelect={() => onSearchChange({ ...filters, reportId: report.id })} />)}
    </ul>}
    {!denied && <LoadMore label="bug reports" query={reports} />}
    {search.reportId && <BugReportDialog key={search.reportId} reportId={search.reportId}
      returnFocusRef={heading}
      onClose={() => onSearchChange(filters)} />}
  </section>
}
