import type { CiActivity } from '@foreman-code/contracts'
import type { AgentNodeState } from '../../shared/ui/nocturne/Canvas'

const states: Record<CiActivity['state'], AgentNodeState> = {
  queued: 'queued', starting: 'running', running: 'running', passed: 'completed',
  failed: 'failed', canceled: 'idle', lost: 'unavailable',
}

export function ciNodePresentation(ci: CiActivity) {
  const partition = ci.partition ? ` ${ci.partition.index + 1}/${ci.partition.count}` : ''
  return { label: `CI ${ci.part ?? ci.suite}${partition} · ${ci.state}`, state: states[ci.state] }
}
