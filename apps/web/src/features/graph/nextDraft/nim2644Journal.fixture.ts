import { GraphEditIntentV3Schema, type GraphEditIntentV3, type GraphEditStageInputV3 } from '@foreman-code/contracts/wave25'
import type { NextDraftEdit } from './state'
import type { NextDraftContext } from './model'

const hash = 'sha256:' + '1'.repeat(64), now = '2026-09-24T00:00:00Z'
export function journalRequest(edit: NextDraftEdit, commandId: string): GraphEditStageInputV3 {
  const { draft, agents } = edit.context
  if (draft.publishedRevision == null) throw new Error('The journal fixture requires an exact saved revision.')
  const stagedAgents = Object.values(edit.agentEdits ?? {}).filter((agent) => edit.graph.nodes.some((node) => node.kind!=='job' && node.agentId === agent.id))
    .map((agent) => ({ agent: { ...agent, prompt: agent.prompt ?? {}, assignedSkills: agent.assignedSkills ?? [] },
      baseRevision: agents.find((item) => item.agent.id === agent.id)?.metadataRevision ?? null }))
  return { action: 'stage_edits', workspaceId: draft.workspaceId, workflowId: draft.workflowId, draftId: draft.id,
    commandId, expectedRevision: draft.publishedRevision, expectedWorkflowVersionId: draft.baseWorkflowVersionId,
    executionSemanticsVersion: 3, graph: edit.graph,
    expectedAgentConfigurationVersionIds: Object.fromEntries(edit.graph.nodes.flatMap((node) => {
      if(node.kind==='job')return []
      const agent = edit.agentEdits?.[node.agentId] ?? agents.find((item) => item.agent.id === node.agentId)?.agent
      return agent?.configurationVersionId ? [[node.agentId, agent.configurationVersionId]] : []
    })), ...(stagedAgents.length ? { stagedAgents } : {}) }
}
export function journalIntent(request: GraphEditStageInputV3, context: NextDraftContext,
  affected: GraphEditIntentV3['affected'] = []): GraphEditIntentV3 {
  const { draftId } = request
  const save = { workspaceId: request.workspaceId, workflowId: request.workflowId, expectedRevision: request.expectedRevision,
    expectedWorkflowVersionId: request.expectedWorkflowVersionId, executionSemanticsVersion: request.executionSemanticsVersion,
    graph: request.graph, expectedAgentConfigurationVersionIds: request.expectedAgentConfigurationVersionIds,
    stagedAgents: request.stagedAgents }
  const saveCommandId = `save-${request.commandId}`
  const resultant = { ...request.expectedAgentConfigurationVersionIds,
    ...Object.fromEntries((request.stagedAgents ?? []).map(({ agent }) => [agent.id, `saved-${agent.id}`])) }
  return GraphEditIntentV3Schema.parse({ kind: 'current', id: `intent-${request.commandId}`, ownerPrincipalId: 'fixture',
    workspaceId: request.workspaceId, workflowId: request.workflowId, draftId,
    stageCommandId: request.commandId, stageInputHash: hash,
    advanceCommandId: `advance-${request.commandId}`, advanceInputHash: hash,
    discardCommandId: `discard-${request.commandId}`, discardInputHash: hash,
    expectedRevision: request.expectedRevision, expectedWorkflowVersionId: request.expectedWorkflowVersionId,
    savedWorkflowRevision: request.expectedRevision,
    stagedDraft: { id: draftId, workspaceId: request.workspaceId, workflowId: request.workflowId,
      revision: request.expectedRevision, baseWorkflowVersionId: request.expectedWorkflowVersionId, graph: request.graph,
      agentConfigurationVersionIds: request.expectedAgentConfigurationVersionIds, stagedAgents: request.stagedAgents,
      saveCommandId, resultantAgentConfigurationVersionIds: resultant,
    },
    saveInput: { ...save, commandId: saveCommandId, resultantAgentConfigurationVersionIds: resultant }, saveInputHash: hash,
    agentPins: request.graph.nodes.filter(node=>node.kind!=='job').map(({ agentId }) => ({ agentId,
      metadataRevision: context.agents.find((item) => item.agent.id === agentId)?.metadataRevision ?? null,
      configurationVersionId: request.expectedAgentConfigurationVersionIds[agentId] ?? null })),
    affected, stops: affected.map(({ runId }) => ({ input: { workspaceId: request.workspaceId, runId,
      commandId: `stop-${runId}-${request.commandId}` } })),
    state: 'staged', saveAttempted: false, createdAt: now, updatedAt: now })
}
export function savedJournal(intent: GraphEditIntentV3, version = 2): GraphEditIntentV3 {
  const graph = { ...intent.stagedDraft.graph, version }, versionId = `version-${version}`
  return GraphEditIntentV3Schema.parse({ ...intent, state: 'saved', saveAttempted: true,
    result: { workspaceId: intent.workspaceId, workflowId: intent.workflowId, revision: intent.expectedRevision + 1,
      currentVersionId: versionId,
      agents: (intent.stagedDraft.stagedAgents ?? []).map(({ agent, baseRevision }) => ({ metadataRevision: (baseRevision ?? 0) + 1,
        // Model publication normalization, not mutation of the private Stage payload.
        agent: { ...agent, prompt: agent.prompt ?? {}, assignedSkills: agent.assignedSkills ?? [],
          configurationVersionId: intent.stagedDraft.resultantAgentConfigurationVersionIds![agent.id], createdAt: now, updatedAt: now } })),
      version: { id: versionId, workspaceId: intent.workspaceId, workflowId: intent.workflowId, version,
        executionSemanticsVersion: 3, definition: graph, entryNodeId: graph.entryNodeId, approval: graph.approval,
        agentConfigurationVersionIds: intent.stagedDraft.resultantAgentConfigurationVersionIds,
        contentHash: hash, createdAt: now } } })
}
