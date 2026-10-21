import type { ScheduleGetInput, ScheduleOccurrence } from '@foreman-code/contracts/schedules'
import { Button } from '../../shared/ui/nocturne'
import { useLatestScheduleOccurrence } from './queries'

const rejectionMessages = new Map([
  ['schedule_authorization_denied', 'Permission to run this schedule was lost. Restore access, then save the schedule.'],
  ['schedule_authority_missing', 'Save or enable the schedule to authorize future runs.'],
  ['workflow_not_saved', 'Save the workflow before scheduling it.'],
  ['workflow_not_executable', 'Check the saved workflow and agent settings, then save the workflow.'],
])
const outcomeLabels: Record<ScheduleOccurrence['status'], string> = {
  accepted: 'Accepted', rejected: 'Rejected', missed: 'Missed', skipped: 'Skipped',
}

function outcomeReason(occurrence: ScheduleOccurrence): string | null {
  switch (occurrence.status) {
    case 'accepted': return null
    case 'rejected': return rejectionMessages.get(occurrence.reason)
      ?? 'The saved workflow could not start. Check its settings, then save the schedule again.'
    case 'missed': return occurrence.reason === 'outside_grace'
      ? 'The scheduling window passed before this attempt could start.'
      : 'A newer scheduled time replaced this attempt.'
    case 'skipped': return occurrence.reason === 'overlap'
      ? 'A previous scheduled Run was still active.'
      : 'The schedule was disabled before this attempt could start.'
  }
}

export function ScheduleLastAttempt({ scope, open }: { scope: ScheduleGetInput; open: boolean }) {
  const query = useLatestScheduleOccurrence(scope, open)
  const occurrence = !query.isError ? query.data?.items[0] : undefined
  const runHref = occurrence?.status === 'accepted'
    ? `/workspaces/${encodeURIComponent(scope.workspaceId)}?${new URLSearchParams({
      workflowId: scope.workflowId, selectedRunId: occurrence.runId,
    })}` : undefined
  let content = <p>No attempts yet.</p>
  if (query.isError) {
    content = <>
      <p>Could not load last attempt.</p>
      <Button size="sm" onClick={() => { void query.refetch() }}>Retry history</Button>
    </>
  } else if (occurrence) {
    content = <>
      <p>Scheduled for <time dateTime={occurrence.dueAt}>{new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium', timeStyle: 'medium',
      }).format(new Date(occurrence.dueAt))}</time></p>
      <p><strong>{outcomeLabels[occurrence.status]}</strong>
        {occurrence.status !== 'accepted' && <> — {outcomeReason(occurrence)}</>}</p>
      {occurrence.status === 'accepted' && <a
        href={runHref}
        target="_blank" rel="noopener noreferrer" aria-label="View Run (opens in a new tab)">View Run</a>}
    </>
  } else if (query.isPending) {
    content = <p>Loading…</p>
  }
  return <section className="schedule-last-attempt" aria-label="Last attempt" aria-live="polite">
    <h3>Last attempt</h3>
    {content}
  </section>
}
