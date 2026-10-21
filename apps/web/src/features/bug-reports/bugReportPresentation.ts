import type { BugReportSeverity, BugReportStatus } from '@foreman-code/contracts/management'

export const statusLabels: Record<BugReportStatus, string> = {
  open: 'Open',
  triaged: 'Triaged',
  fixed: 'Fixed',
  'wont-fix': "Won’t fix",
  duplicate: 'Duplicate',
}
export const severityLabels: Record<BugReportSeverity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
}
export const activeStatuses = ['open', 'triaged'] as const satisfies readonly BugReportStatus[]
export const closedStatuses = ['fixed', 'wont-fix', 'duplicate'] as const satisfies readonly BugReportStatus[]
const options = (statuses: readonly BugReportStatus[]) => statuses.map(value => ({ value, label: statusLabels[value] }))
export const activeStatusOptions = options(activeStatuses)
export const closedStatusOptions = options(closedStatuses)
export const severityOptions = Object.entries(severityLabels).map(([value, label]) => ({ value, label }))
