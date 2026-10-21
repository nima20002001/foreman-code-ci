import { afterEach, expect, it, vi } from 'vitest'
import type { GraphEditIntentV3 } from '@foreman-code/contracts/wave25'
import { fixture } from './core.cases'
import { newNextDraft, nextDraftKey } from './state'
import { stageAgentEdits } from './agentEdits'
import { acknowledgeEditIntentSnapshot } from './useGraphEditIntent'
import * as storage from './editIntentStorage'

const key = nextDraftKey('workspace', 'workflow')
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear() })
function form() {
  const edit = newNextDraft(fixture(), 'agent-staging')
  const agent = { ...edit.context.agents[0]!.agent, name: 'Private renamed Agent' }
  edit.agentEdits = { [agent.id]: agent }
  return { edit, agent }
}
it('stages the displayed Agent configuration and metadata revision, including a new Agent without a head', () => {
  const { edit, agent } = form()
  const created = { id: 'new-agent', name: 'New Agent', productRole: 'coder' as const }
  edit.agentEdits![created.id] = created
  edit.graph = { ...edit.graph, nodes: [...edit.graph.nodes, { id: 'new-node', agentId: created.id, name: created.name }] }
  expect(stageAgentEdits(edit)).toEqual([{ agent, baseRevision: 3 }, { agent: created, baseRevision: null }])
  expect(edit.context.agents[0]?.agent.name).toBe('Agent 0')
})
it('refuses an existing configuration without its displayed metadata revision', () => {
  const { edit, agent } = form()
  edit.context = { ...edit.context, agents: [] }
  expect(agent.configurationVersionId).toBeDefined()
  expect(() => stageAgentEdits(edit)).toThrow('Reload the Agent revision')
})
function savedIntent(includeAgents: boolean) {
  const { edit, agent } = form()
  const persisted = { agent: { ...agent, configurationVersionId: 'configuration-result' }, metadataRevision: 4 }
  const request = { action: 'stage_edits' as const, workspaceId: 'workspace', workflowId: 'workflow', draftId: 'draft',
    commandId: 'stage-agent', expectedRevision: 7, expectedWorkflowVersionId: 'workflow-version-1',
    executionSemanticsVersion: 3 as const, expectedAgentConfigurationVersionIds: { 'agent-0': 'configuration-0', 'agent-1': 'configuration-1' },
    graph: edit.graph }
  vi.spyOn(storage, 'readEditSubmission').mockReturnValue({ request, target: edit.graph, agentTarget: edit.agentEdits })
  vi.spyOn(storage, 'editSnapshotAcknowledged').mockReturnValue(false)
  vi.spyOn(storage, 'editSnapshotSubmitted').mockReturnValue(true)
  vi.spyOn(storage, 'storeEditSnapshot').mockImplementation(() => undefined)
  // Authenticated journal result fixture. The shared schema/atomic backend is
  // covered by the B contract suite; this exercises local acknowledgement only.
  const intent = { workspaceId: 'workspace', workflowId: 'workflow', draftId: 'draft', expectedRevision: 7,
    expectedWorkflowVersionId: 'workflow-version-1', stageCommandId: 'stage-agent', state: 'saved',
    stagedDraft: { graph: edit.graph, stagedAgents: [{ agent, baseRevision: 3 }] },
    result: { revision: 8, currentVersionId: 'workflow-version-2', version: { definition: { ...edit.graph, version: 2 }, agentConfigurationVersionIds: { 'agent-0': 'configuration-result', 'agent-1': 'configuration-1' } },
      ...(includeAgents ? { agents: [persisted] } : {}) } } as unknown as GraphEditIntentV3
  return { edit, intent, persisted }
}
it('acknowledges Agent edits using only the exact persisted publication snapshot', () => {
  const { edit, intent, persisted } = savedIntent(true)
  const acknowledged = acknowledgeEditIntentSnapshot(key, edit, intent)
  expect(acknowledged.context.agents[0]).toEqual(persisted)
  expect(acknowledged.agentEdits).toEqual({})
  expect(acknowledged.context.draft.revision).toBe(8)
})
it('retains the Agent form when the publication result omits its exact Agent snapshots', () => {
  const { edit, intent } = savedIntent(false)
  expect(acknowledgeEditIntentSnapshot(key, edit, intent)).toBe(edit)
})
it('preserves newer Agent typing while moving its base to the acknowledged configuration', () => {
  const { edit, intent, persisted } = savedIntent(true)
  const newer = { ...edit, agentEdits: { 'agent-0': { ...edit.agentEdits!['agent-0']!, name: 'Typed after Stage' } } }
  const acknowledged = acknowledgeEditIntentSnapshot(key, newer, intent)
  expect(acknowledged.agentEdits?.['agent-0']).toMatchObject({ name: 'Typed after Stage', configurationVersionId: persisted.agent.configurationVersionId })
  expect(acknowledged.context.agents[0]).toEqual(persisted)
})
