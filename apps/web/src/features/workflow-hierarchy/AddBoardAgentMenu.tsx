import { agentTemplateForRole, newAgentGraphqlTools, type Agent, type AgentDefaults,
  type WorkflowAgentProductRole } from '@foreman-code/contracts'
import { ActionMenu } from '../../shared/ui/nocturne'
import { useAgentDefaultsQuery } from '../../shared/api/query'
import { defaultAgentForHarness } from '../agents/agentSettings'
import { useGraphDraftStore } from '../graph/store'
import { editorAgents } from '../graph/nextDraft/agentEdits'
import type { NextDraftEdit } from '../graph/nextDraft/state'
import { hierarchyNodes, stageHierarchyAgent } from './authoring'

const roles = [['master', 'Master'], ['orchestrator', 'Orchestrator'], ['coder', 'Worker']] as const

/** A new Agent from the role's profile in Settings, numbered after the same-role Agents on this Board. */
export function newBoardAgent(edit: NextDraftEdit, defaults: AgentDefaults, role: WorkflowAgentProductRole, label: string): Agent {
  const template = agentTemplateForRole(defaults, role)
  if (template.harness.harness !== 'codex' && template.harness.harness !== 'claude') {
    throw new Error(`The ${label} profile in Settings needs a Codex or Claude harness.`)
  }
  const agents = new Map(editorAgents(edit).map(agent => [agent.id, agent]))
  const same = edit.graph.nodes.filter(node => node.kind !== 'job' && agents.get(node.agentId)?.productRole === role).length
  return { ...defaultAgentForHarness(template.harness.harness, `agent-${crypto.randomUUID()}`,
    same ? `${label} ${same + 1}` : label, template.harness, role),
  ...(template.nativeTools ? { nativeTools: structuredClone(template.nativeTools) } : {}),
  ...(template.harnessProfileSelection ? { harnessProfileSelection: structuredClone(template.harnessProfileSelection) } : {}),
  graphqlTools: [...(template.graphqlTools ?? newAgentGraphqlTools(role))] }
}

/** The Board's plus: one click on a role stages a new Agent; Save creates it. */
export function AddBoardAgentMenu({ draftKey, edit, disabled, report }: {
  draftKey: string; edit: NextDraftEdit; disabled?: boolean; report(error: unknown): void
}) {
  const defaults = useAgentDefaultsQuery()
  const hasMaster = !!edit.graph.hierarchy || hierarchyNodes(edit).some(item => item.role === 'master')
  const add = (role: WorkflowAgentProductRole, label: string) => {
    try {
      if (!defaults.data) throw new Error('Agent profiles from Settings are still loading.')
      const value = defaults.data.value
      useGraphDraftStore.getState().updateNextDraft(draftKey, current => {
        const parent = role === 'coder' && current.graph.hierarchy
          ? hierarchyNodes(current).find(item => item.role === 'orchestrator')?.node.id : undefined
        if (role === 'coder' && current.graph.hierarchy && !parent) throw new Error('Add an Orchestrator for the Worker to report to.')
        return stageHierarchyAgent(current, newBoardAgent(current, value, role, label), `node-${crypto.randomUUID()}`, parent)
      })
    } catch (error) { report(error) }
  }
  return <ActionMenu label="Add agent" icon="plus" width={200} disabled={disabled}
    items={roles.map(([role, label]) => ({ id: role, label,
      disabled: !defaults.data || role === 'master' && hasMaster,
      ...(defaults.isError ? { description: 'Agent profiles are unavailable.' }
        : role === 'master' && hasMaster ? { description: 'This workflow already has a Master.' } : {}),
      onSelect: () => add(role, label) }))} />
}
