import { Link } from '@tanstack/react-router'

import { useAgentsQuery } from '../../shared/api/query'
import './agents.css'

export interface AgentNavigationProps {
  workspaceId: string
  /** URL-owned selection; undefined means no agent is selected in the URL. */
  activeAgentId?: string
}

/**
 * The nested agent submenu for one workspace. The list comes from the
 * server-shaped agents query; the selected agent stays in the URL `agentId`.
 */
export function AgentNavigation({ workspaceId, activeAgentId }: AgentNavigationProps) {
  const agentsQuery = useAgentsQuery(workspaceId)
  const agents = agentsQuery.data?.agents ?? []

  return (
    <section className="agent-navigation" data-testid="agent-navigation" aria-label="Workspace agents">
      {agents.length > 0 ? (
        <ul className="nav-submenu agent-navigation-list">
          {agents.map((agent) => {
            const active = agent.id === activeAgentId
            return (
              <li key={agent.id}>
                <Link
                  to="/workspaces/$workspaceId/agents"
                  params={{ workspaceId }}
                  search={(previous) => ({ ...previous, agentId: agent.id })}
                  className={`nav-item agent-navigation-item${active ? ' nav-item-active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  title={agent.name}
                >
                  <span className="nav-item-label">{agent.name}</span>
                </Link>
              </li>
            )
          })}
        </ul>
      ) : agentsQuery.isPending ? (
        <p className="agent-navigation-state" role="status">
          Loading agents…
        </p>
      ) : agentsQuery.isError ? (
        <p
          className="agent-navigation-state agent-navigation-state-error"
          data-testid="agent-navigation-error"
          role="alert"
        >
          Agents unavailable
        </p>
      ) : (
        <p className="agent-navigation-state" data-testid="agent-navigation-empty">
          No agents yet
        </p>
      )}

      {agents.length > 0 && agentsQuery.isPending ? (
        <p className="agent-navigation-state" role="status">Loading workspace agents…</p>
      ) : null}
      {agents.length > 0 && agentsQuery.isError ? (
        <p
          className="agent-navigation-state agent-navigation-state-error"
          data-testid="agent-navigation-error"
          role="alert"
        >
          Workspace agents unavailable
        </p>
      ) : null}
    </section>
  )
}
