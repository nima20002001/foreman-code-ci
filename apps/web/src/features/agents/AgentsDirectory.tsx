import { errorMessage } from '../../shared/errorMessage'
import type { WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { useState } from 'react'
import type { Agent } from '@foreman-code/contracts'
import { Link } from '@tanstack/react-router'

import { useWorkspaceDetailsQuery } from '../../shared/api/query'
import {
  Button, Card, CardHeader, EmptyState, Icon, LoadingState, PageHeader,
} from '../../shared/ui/nocturne'
import { ResourceActionsMenu } from '../../shared/ui/ResourceCard'
import { useGraphDraftStore } from '../graph/store'
import { nextDraftKey } from '../graph/nextDraft/state'
import { useAgentDirectoryStore } from './agentDirectoryStore'
import { useReorderableAgents, type AgentReorderCardProps } from './useReorderableAgents'
import './agents.css'

function executionLabel(agent: Agent): string {
  const value = agent.executionState ?? agent.status
  if (!value) return 'No execution state'
  return value.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase())
}

function AgentCard({
  agent,
  reorderProps,
  workspaceId,
  blockers,
}: {
  agent: Agent
  reorderProps?: AgentReorderCardProps
  workspaceId: string
  blockers: readonly Pick<WorkflowDefinitionV3, 'id' | 'name'>[]
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const role = agent.role ?? 'Agent'
  const status = executionLabel(agent)
  const { ref: reorderRef, ...reorderAttributes } = reorderProps ?? {}
  return <div
      ref={reorderRef}
      className="agent-directory-card-shell"
      tabIndex={0}
      aria-label={`${agent.name}, ${role}, ${status}`}
      {...reorderAttributes}
    >
      <Card className="agent-directory-card">
        <CardHeader title={agent.name} description={`${role} · ${status}`} />
      </Card>
    <ResourceActionsMenu name={agent.name} className="agent-directory-card-more" open={menuOpen} onOpenChange={setMenuOpen}>
      <div role="note">
        <p>Standalone agent editing is read-only in Operator mode. Open a workflow board to change this agent and Save graph.</p>
        {blockers.map((workflow) => <Link key={workflow.id} to="/workspaces/$workspaceId"
          params={{ workspaceId }} search={{ workflowId: workflow.id }}>{workflow.name}</Link>)}
      </div>
      <Button variant="ghost" onClick={() => setMenuOpen(false)}>Close</Button>
    </ResourceActionsMenu>
  </div>
}

export function AgentsDirectoryContent({
  workspaceId,
  agents,
  workflows = [],
}: {
  workspaceId: string
  agents: readonly Agent[]
  workflows?: readonly WorkflowDefinitionV3[]
}) {
  const graphDrafts = useGraphDraftStore((state) => state.nextDrafts)
  const announcement = useAgentDirectoryStore((state) => state.announcement)
  const reorder = useReorderableAgents(
    workspaceId,
    agents.map((agent) => ({ id: agent.id, label: agent.name })),
  )
  const agentById = new Map(agents.map((agent) => [agent.id, agent]))
  const orderedAgents = reorder.orderedIds
    .map((agentId) => agentById.get(agentId))
    .filter((agent): agent is Agent => Boolean(agent))
  const workspaceWorkflows = workflows.map((workflow) => graphDrafts[nextDraftKey(workspaceId, workflow.id)]?.graph ?? workflow)
  return (
    <div className="agents-directory" data-testid="agents-directory">
      <PageHeader
        eyebrow="Workspace directory"
        title="Agents"
      />

      {agents.length > 0 ? (
        <div className="agent-directory-grid" aria-label="Agents" {...reorder.containerProps}>
          {orderedAgents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              reorderProps={reorder.getCardProps(agent.id)}
              workspaceId={workspaceId}
              blockers={workspaceWorkflows.filter((workflow) => (
                workflow.nodes.some((node) => (node.kind!=='job'?node.agentId:undefined) === agent.id)
              ))}
            />
          ))}
        </div>
      ) : (
        <div>
          <EmptyState
            icon="bot"
            title="No agents yet"
            description="Add agents from a workflow graph, then save the workflow to make them available here."
          />
        </div>
      )}

      <p
        key={announcement?.nonce ?? 0}
        className="visually-hidden"
        role="status"
        aria-live="polite"
      >
        {announcement?.message ?? ''}
      </p>

    </div>
  )
}

export function AgentsDirectory({
  workspaceId,
}: {
  workspaceId: string
  selectedAgentId?: string
  onClearAgent?: () => void
}) {
  const agentsQuery = useWorkspaceDetailsQuery(workspaceId)

  if (agentsQuery.isPending) {
    return <div data-testid="agents-loading"><LoadingState label="Loading agents…" /></div>
  }

  if (agentsQuery.isError || !agentsQuery.data) {
    return (
      <div data-testid="agents-error" role="alert">
        <EmptyState
          icon="warning"
          title="Agents unavailable"
          description={errorMessage(agentsQuery.error, 'The agents directory could not be loaded.')}
          action={<Button onClick={() => void agentsQuery.refetch()} leading={<Icon name="refresh" size={16} />}>Retry</Button>}
        />
      </div>
    )
  }

  return (
    <AgentsDirectoryContent
      key={workspaceId}
      workspaceId={workspaceId}
      agents={agentsQuery.data.agents}
      workflows={agentsQuery.data.workflows}
    />
  )
}
