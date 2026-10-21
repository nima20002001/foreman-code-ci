import { useCallback } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { MemoryBoardWireSchemas, type MemoryBoardScope, type MemoryCardWorkBinding } from '@foreman-code/contracts'
import { MemoryBoard } from '../memory-boards/MemoryBoard'
import { MemoryBoardDialog } from '../memory-boards/MemoryBoardDialog'
import { createMemoryBoardClient } from '../memory-boards/client'
import type { MemoryFilters, MemoryNodeOption } from '../memory-boards/ports'
import { useLocalHumanAccessQuery } from '../../shared/api/settingsExperience'
import { useManagedWorkflowQuery } from '../../shared/api/query'
import { canUseBoardAction } from './permissions'

const client = createMemoryBoardClient(MemoryBoardWireSchemas)

export function MemoryBoardSurface({ scope, scopeName, dialog }: {
  scope: MemoryBoardScope
  scopeName: string
  dialog?: { open: boolean; onOpenChange(open: boolean): void; historicalRun: boolean }
}) {
  const navigate = useNavigate()
  const search = useLocation().search
  const access = useLocalHumanAccessQuery()
  const principal = access.isError ? undefined : access.data?.principal
  const workflowId = scope.kind === 'workflow' ? scope.workflowId : ''
  const workflow = useManagedWorkflowQuery(scope.workspaceId, workflowId, scope.kind === 'workflow')
  const destination = scope.kind === 'workspace' ? '/workspaces/$workspaceId/memory' : '/workspaces/$workspaceId'
  const selected = useCallback((memoryCard: string | undefined) => {
    void navigate({ to: destination, params: { workspaceId: scope.workspaceId }, replace: true, search: previous => ({ ...previous, memoryCard }) })
  }, [navigate, destination, scope.workspaceId])
  const filtersChanged = useCallback((filters: MemoryFilters) => {
    void navigate({ to: destination, params: { workspaceId: scope.workspaceId }, replace: true, search: previous => ({ ...previous,
      memoryQuery: filters.query || undefined, memoryStatus: filters.status,
      memoryDone: filters.doneOpen || undefined, memoryCompletion: filters.completionKind,
    }) })
  }, [navigate, destination, scope.workspaceId])
  const openWork = useCallback((binding: MemoryCardWorkBinding) => {
    void navigate({ to: '/workspaces/$workspaceId', params: { workspaceId: binding.node.workspaceId }, search: {
      workflowId: binding.node.workflowId, selectedRunId: binding.work.runId, boardPanel: 'agent',
      boardNodeId: binding.node.workflowNodeId, boardAgentTab: 'details',
      ...(binding.currentExecutionId ? { boardExecutionId: binding.currentExecutionId } : {}),
    } })
  }, [navigate])
  const nodes: MemoryNodeOption[] = (workflow.data?.workflow.nodes ?? []).flatMap(node => node.kind === 'job' ? [] : [{
    node: { workspaceId: scope.workspaceId, workflowId, workflowNodeId: node.id, agentId: node.agentId },
    label: node.name ?? node.label ?? node.id, available: true, currentWork: [],
  }])
  const canWrite = Boolean(principal && Date.parse(principal.expiresAt) > Date.now()
    && canUseBoardAction(principal.grants, scope.kind === 'workspace' ? 'workspaces:update' : 'workflows:update',
      { workspaceId: scope.workspaceId, workflowId }))
  const props = { client, scope, scopeName: workflow.data?.workflow.name ?? scopeName, nodes, canWrite,
    filters: { query: search.memoryQuery ?? '', doneOpen: search.memoryDone ?? false,
      ...(search.memoryStatus ? { status: search.memoryStatus } : {}),
      ...(search.memoryCompletion ? { completionKind: search.memoryCompletion } : {}) },
    ...(search.memoryCard ? { selectedCardId: search.memoryCard } : {}),
    onSelectCard: selected, onFiltersChange: filtersChanged, onOpenWork: openWork,
  }
  return dialog ? <MemoryBoardDialog {...props} {...dialog} /> : <MemoryBoard {...props} />
}
