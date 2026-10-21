import type { WorkflowExecutionPolicy } from '@foreman-code/contracts'
import { MAX_AGENT_ACTIVE_TIMEOUT_MS } from '@foreman-code/contracts/wave25'
import { TextField } from '../../../shared/ui/nocturne'
import { InfoHint } from '../../../shared/ui'

export function AgentActiveTimeField({ policy, defaultMs, onChange }: {
  policy: WorkflowExecutionPolicy
  defaultMs: number | undefined
  onChange(policy: WorkflowExecutionPolicy): void
}) {
  const hint = defaultMs === undefined
    ? 'Per Agent execution; approval waits are excluded. Leave blank to use the server default.'
    : `Per Agent execution; approval waits are excluded. Leave blank to use the server default (${defaultMs / 1000} seconds).`
  return <TextField data-save-field="active-time" label="Agent active-time budget (seconds)"
    labelHint={<InfoHint label="Agent active-time budget (seconds)">{hint}</InfoHint>}
    type="number" min={0.001} max={MAX_AGENT_ACTIVE_TIMEOUT_MS / 1000} step={0.001}
    placeholder="Use server default"
    value={policy.agentActiveTimeoutMs === undefined || !Number.isFinite(policy.agentActiveTimeoutMs)
      ? '' : policy.agentActiveTimeoutMs / 1000}
    onChange={(event) => {
      const next = { ...policy }
      if (event.target.value === '') delete next.agentActiveTimeoutMs
      else next.agentActiveTimeoutMs = Math.round(event.target.valueAsNumber * 1000)
      onChange(next)
    }} />
}
