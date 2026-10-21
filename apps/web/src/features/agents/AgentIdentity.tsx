import { retiredHarnessLabel } from '../settings/settingsPresentation'
import type { Agent } from '@foreman-code/contracts'

export interface AgentIdentityProps {
  agent: Agent
}

export function AgentIdentity({ agent }: AgentIdentityProps) {
  return (
    <header>
      <p className="panel-kicker">Agent context</p>
      <h2>{agent.name}</h2>
      <p>{agent.description ?? 'No agent description is available.'}</p>
      <dl>
        <div>
          <dt>Role</dt>
          <dd>{agent.role ?? 'Unspecified'}</dd>
        </div>
        <div>
          <dt>Harness</dt>
          <dd>
            {agent.harness === 'opencode' || agent.harnessConfiguration?.harness === 'opencode'
              ? retiredHarnessLabel : agent.harnessSummary
              ? `${agent.harnessSummary.label ?? 'Harness'} · ${agent.harnessSummary.status}`
              : 'No harness details available'}
          </dd>
        </div>
      </dl>
    </header>
  )
}
