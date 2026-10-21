import { storeEditSnapshot } from '../graph/nextDraft/editIntentStorage'
import { useId } from 'react'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { usePlacementChoices } from '../node-placement/usePlacementChoices'
import type { SavedNodePlacement } from '@foreman-code/contracts/node-placement'
import type { AgentWorktreeSettings } from '@foreman-code/contracts/worktree-settings'
import type { NodePlacementOption } from '../node-placement/NodePlacementField'
import type { Agent, GraphqlToolOverride } from '@foreman-code/contracts'
import { Alert } from '../../shared/ui/nocturne'
import { useGraphDraftStore } from '../graph/store'
import { AgentSettingsForm } from '../graph/AgentSettingsForm'
import { changeDraftAgent, editorAgents } from '../graph/nextDraft/agentEdits'
import type { NextDraftEdit } from '../graph/nextDraft/state'
import { useWorktreeChoices } from '../../shared/api/worktreeChoices'
import { worktreeLabel } from './worktreePresentation'
import { hierarchyNodes, reparentHierarchyWorker } from '../workflow-hierarchy/authoring'
import { WorkerParentField } from '../workflow-hierarchy/WorkerParentField'

function installAgent(draftKey: string, instanceId: string, agent: Agent, nodeId?: string, prompt?: string,
  graphqlTools?: GraphqlToolOverride, placement?: SavedNodePlacement, worktree?: AgentWorktreeSettings) {
  useGraphDraftStore.getState().updateNextDraft(draftKey, (current) => {
    if (current.instanceId !== instanceId) throw new Error('The draft instance changed. Reopen these settings.')
    const graph = current.graph
    const node = nodeId ? graph.nodes.filter(item => item.kind !== 'job').find((item) => item.id === nodeId && item.agentId === agent.id) : undefined
    if (nodeId && !node) throw new Error('This Agent node is no longer in the draft.')
    const id = node?.id ?? `node-${crypto.randomUUID()}`
    const kept = node ? { ...node } : undefined
    if (kept) {
      delete kept.graphqlTools
      delete kept.placement
      delete kept.worktree
    }
    const nextNode = kept ? { ...kept, name: agent.name, initialPrompt: prompt,
      ...(graphqlTools ? { graphqlTools } : {}), ...(placement ? { placement } : {}), ...(worktree ? { worktree } : {}) } : {
      id, agentId: agent.id, name: agent.name,
    }
    const agentForms = { ...current.agentForms }; delete agentForms[id]
    const workflowForms = { ...current.workflowForms }, workerParents = { ...workflowForms.workerParents }
    const parent = workerParents[id]
    let nextGraph: NextDraftEdit['graph'] = { ...graph,
      nodes: node ? graph.nodes.map((item) => item.id === id ? nextNode : item) : [...graph.nodes, nextNode],
      entryNodeId: !graph.nodes.length ? id : graph.entryNodeId,
    }
    if (parent !== undefined) {
      if (!hierarchyNodes(current).some(item => item.role === 'orchestrator' && item.node.id === parent)) {
        throw new Error('Choose an Orchestrator for this Worker before applying.')
      }
      nextGraph = reparentHierarchyWorker(nextGraph, id, parent)
      delete workerParents[id]
      if (Object.keys(workerParents).length) workflowForms.workerParents = workerParents
      else delete workflowForms.workerParents
    }
    return changeDraftAgent({ ...current, agentForms, workflowForms }, agent, nextGraph)
  })
}

type BoardAgentSettingsProps = { draftKey: string; edit: NextDraftEdit; nodeId: string; close(): void; remove?(): void; placementOptions?: readonly NodePlacementOption[] }
export function BoardAgentSettings(props: BoardAgentSettingsProps) {
  return <BoardAgentSettingsVisit key={`${props.edit.instanceId}:${props.nodeId}`} {...props} />
}
function BoardAgentSettingsVisit({ draftKey, edit, nodeId, close, remove, placementOptions }: BoardAgentSettingsProps) {
  const node = edit.graph.nodes.filter(item => item.kind !== 'job').find((item) => item.id === nodeId)
  const agent = node && editorAgents(edit).find((item) => item.id === node.agentId)
  const visit = useId()
  const saved = edit.context.savedDraft ?? edit.context.draft
  const savedNode = node && saved.graph.nodes.filter(item => item.kind !== 'job').find((item) => item.id === node.id && item.agentId === node.agentId)
  const savedAgent = savedNode && edit.context.agents.find((item) => item.agent.id === savedNode.agentId)?.agent
  const choiceScope = savedNode && savedAgent?.configurationVersionId && !edit.agentEdits?.[savedNode.agentId]
    ? { workspaceId: edit.graph.workspaceId, workflowId: edit.graph.id, nodeId: savedNode.id, agentConfigurationVersionId: savedAgent.configurationVersionId } : undefined
  const choices = usePlacementChoices(choiceScope, `${visit}:${edit.instanceId}`)
  const worktrees = useWorktreeChoices(edit.graph.workspaceId,
    Boolean(edit.graph.defaultWorktree || node?.placement?.rootBinding))
  const roots = worktrees.isError ? [] : worktrees.data ?? []
  const options = (placementOptions ?? choices.options).map(option => {
    const root = roots.find(item => sameWorkflowValue(item.rootBinding, option.placement.rootBinding))
    return { ...option, ...(root?.commit ? { commit: root.commit } : {}) }
  })
  if (!node || !agent) return <Alert tone="warning" title="This agent’s settings aren’t available." />
  const worker = !!edit.graph.hierarchy && agent.productRole === 'coder'
  const selectedParent = edit.workflowForms?.workerParents?.[nodeId]
  const parentDirty = selectedParent !== undefined && selectedParent !== edit.graph.hierarchy?.parents.find(member => member.workflowNodeId === nodeId)?.parentNodeId
  // Re-key on the staged agent so a discard or reload never leaves stale values in the open form.
  return <>
    {!choiceScope ? <p role="status">Save this node and Agent before choosing its computer.</p> : choices.isError ? <Alert tone="warning" title="Computer choices are unavailable." /> : null}
    <AgentSettingsForm key={`${edit.instanceId}:${node.id}:${JSON.stringify(agent)}:${node.initialPrompt ?? ''}:${JSON.stringify(node.graphqlTools ?? null)}:${JSON.stringify(node.placement ?? null)}:${JSON.stringify(node.worktree ?? null)}`} embedded agent={agent} initialPrompt={node.initialPrompt}
    nodeGraphqlTools={node.graphqlTools} nodePlacement={node.placement} nodeWorktree={node.worktree}
    workflowWorktree={edit.graph.defaultWorktree}
    workflowWorktreeLabel={edit.graph.defaultWorktree ? worktreeLabel(edit.graph.defaultWorktree, roots) : undefined}
    worktreeDisabled={edit.busy || !!edit.pending}
    placementHidden={!choices.current} placementOptions={options}
    placementStage={sameWorkflowValue(node.placement, savedNode?.placement) ? 'saved' : 'draft'}
    placementOptionsState={placementOptions ? 'ready' : !choiceScope || choices.isError || choices.isPaused ? 'unavailable' : choices.isPending ? 'loading' : 'ready'}
    retainedForm={edit.agentForms?.[node.id]}
    additionalDirty={parentDirty}
    additionalFields={worker ? <WorkerParentField draftKey={draftKey} edit={edit} nodeId={node.id} /> : undefined}
    onFormChange={(form) => useGraphDraftStore.getState().updateNextDraft(draftKey, (current) => ({ ...current,
      agentForms: { ...current.agentForms, [node.id]: form } }))}
    onDiscardForm={() => useGraphDraftStore.getState().updateNextDraft(draftKey, (current) => {
      const agentForms = { ...current.agentForms }; delete agentForms[node.id]
      const workflowForms = { ...current.workflowForms }, workerParents = { ...workflowForms.workerParents }
      delete workerParents[node.id]
      if (Object.keys(workerParents).length) workflowForms.workerParents = workerParents
      else delete workflowForms.workerParents
      return { ...current, agentForms, workflowForms }
    })}
    canResume={() => {
      const current = useGraphDraftStore.getState().nextDrafts[draftKey]
      if (!current) return false
      try { storeEditSnapshot(draftKey, current); return true } catch { return false }
    }}
    workspaceId={edit.graph.workspaceId} workflowApprovalHandler={edit.graph.approval?.handler}
    designatedOrchestrator={edit.graph.approval?.handler === 'orchestrator' && edit.graph.approval.designatedOrchestratorAgentId === agent.id}
    executionPolicy={edit.graph.executionPolicy} onClose={close} onRemove={remove}
    onSave={(next, prompt, _policy, graphqlTools, placement, worktree) =>
      installAgent(draftKey, edit.instanceId, next, node.id, prompt, graphqlTools, placement, worktree)} />
  </>
}
