import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { RunSubagent, SubagentAvailableActions } from '@foreman-code/contracts/subagents'
import { isAuthorized } from '../access/policy.js'
import type { SubagentControlLease } from './types.js'

export function subagentAvailableActions(child: RunSubagent, principal: ManagementPrincipal, stopped: boolean, lease?: SubagentControlLease): SubagentAvailableActions {
  if (child.provider === 'opencode') {
    return { sendInput: false, interrupt: false, blockedReason: 'SUBAGENT_CONTROL_UNAVAILABLE' }
  }
  const resource = { workspaceId: child.workspaceId, workflowId: child.workflowId, runId: child.runId }
  const qualified = (key: 'sendInput' | 'interrupt') => child.capabilities[key].support === 'supported' && child.capabilities[key].qualification === 'passed'
  const live = !stopped && Boolean(lease?.matches(child)) && child.evidence === 'confirmed'
  const idle = ['waiting', 'completed'].includes(child.status)
  const active = child.status === 'running'
  const inputTiming = child.capabilities.inputTiming
  const inputAddressed = idle ? lease?.nativeTurnId === null : active && lease?.nativeTurnId !== null
  const sendInput = child.nativeMode !== 'claude-agent' && live && inputAddressed && qualified('sendInput') && Boolean(lease?.sendInput)
    && (idle && ['idle', 'active-and-idle'].includes(inputTiming) || active && ['active', 'active-and-idle'].includes(inputTiming))
    && isAuthorized(principal, 'runs:subagents:input', resource)
  const interrupt = live && active && qualified('interrupt') && Boolean(lease?.interrupt) && isAuthorized(principal, 'runs:stop', resource)
  const respond = live && Boolean(lease?.respond && lease.pendingInteraction?.())
    && isAuthorized(principal, 'interactions:respond', resource)
  let blockedReason: SubagentAvailableActions['blockedReason'] = null
  if (!sendInput && !interrupt && !respond) {
    if (stopped) blockedReason = 'RUN_STOPPED'
    else if (!lease) blockedReason = 'SUBAGENT_CONTROL_UNAVAILABLE'
    else if (!live) blockedReason = 'SUBAGENT_LEASE_UNAVAILABLE'
    else if (!qualified('sendInput') && !qualified('interrupt')) blockedReason = 'SUBAGENT_CONTROL_UNQUALIFIED'
    else blockedReason = 'SUBAGENT_ACTION_NOT_PERMITTED'
  }
  return { sendInput, interrupt, ...(lease?.respond ? { respond } : {}), blockedReason }
}
