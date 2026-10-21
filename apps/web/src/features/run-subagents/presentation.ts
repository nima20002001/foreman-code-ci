import type { RunSubagent, RunSubagentTool } from '@foreman-code/contracts/subagents'
import type { Tone } from '../../shared/ui/nocturne'

export const providerNames: Record<RunSubagent['provider'], string> = { codex: 'Codex', claude: 'Claude', opencode: 'Retired harness (OpenCode): read-only' }

const statuses: Record<RunSubagent['status'], { label: string; tone: Tone }> = {
  pending: { label: 'Starting', tone: 'neutral' },
  running: { label: 'Running', tone: 'accent' },
  waiting: { label: 'Waiting', tone: 'info' },
  interrupting: { label: 'Stopping', tone: 'warning' },
  completed: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  canceled: { label: 'Stopped', tone: 'neutral' },
  unknown: { label: 'Unknown', tone: 'warning' },
}
export const subagentStatus = (status: RunSubagent['status']) => statuses[status]

const toolStatuses: Record<RunSubagentTool['status'], { label: string; tone: Tone }> = {
  pending: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'accent' },
  completed: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  canceled: { label: 'Stopped', tone: 'neutral' },
  unknown: { label: 'Unknown', tone: 'warning' },
}
export const toolStatus = (status: RunSubagentTool['status']) => toolStatuses[status]

/** Codex multi-agent children carry no name, only their spawn path (for example /root/main_shutdown). */
export const subagentName = (subagent: Pick<RunSubagent, 'name'> & { native?: Pick<RunSubagent['native'], 'agentPath'> }) =>
  subagent.name?.trim() || subagent.native?.agentPath?.split('/').filter(Boolean).pop()?.replaceAll('_', ' ') || 'Subagent'

/** Accessible chip label: name, provider and status in plain words. */
export function subagentLabel(subagent: RunSubagent) {
  const unconfirmed = subagent.evidence !== 'confirmed' ? ', status not confirmed yet' : ''
  return `${subagentName(subagent)}, ${providerNames[subagent.provider]}, ${subagentStatus(subagent.status).label}${unconfirmed}`
}

export function formatClock(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** "Started 1:00 AM · ran 2m 4s" or "Started 1:00 AM · running for 40s". */
export function subagentTiming(subagent: RunSubagent, now = Date.now()) {
  const started = subagent.startedAt ?? subagent.firstObservedAt
  const parts = [`Started ${formatClock(started)}`]
  if (subagent.finishedAt) parts.push(`ran ${formatDuration(Date.parse(subagent.finishedAt) - Date.parse(started))}`)
  else if (['running', 'waiting', 'interrupting', 'pending'].includes(subagent.status)) parts.push(`${formatDuration(now - Date.parse(started))} so far`)
  return parts.join(' · ')
}

export function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`
}
