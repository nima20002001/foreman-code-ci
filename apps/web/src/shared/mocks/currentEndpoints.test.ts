import { nativeNode } from './nativeFixtureTypes'
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { AgentMutationResultSchema, AgentVersionResultSchema, ManagedAgentPageSchema } from '@foreman-code/contracts/management'
import { CurrentManagedWorkflowSchema, CurrentManagedWorkflowPageSchema, CurrentWorkflowReadResultSchema,
  CurrentWorkflowSaveInputSchema, CurrentWorkflowSaveResultSchema, CurrentWorkflowValidationSchema,
  CurrentWorkflowCapabilitiesSchema, GraphEditReadResultV3Schema, GraphEditStageInputV3Schema } from '@foreman-code/contracts/wave25'
import { resetTestFixtures } from './handlers'
import { setMockScenario } from './scenarios'

// Exercise the registered shared handler stack, not createCurrentBoardMock.dispatch
// in isolation. Missing /definition, /edits or Agent handlers must fail here.
const workspaceId = 'workspace-1', workflowId = 'workflow-content-pipeline'
const workspacePath = `/api/management/workspaces/${workspaceId}`
const workflowPath = `${workspacePath}/workflows/${workflowId}`
async function request(path: string, method = 'GET', body?: unknown, status = 200): Promise<unknown> {
  // Relative MSW handlers use this document's origin (including its test port).
  // Do not send these requests to a different hard-coded localhost origin.
  const url = new URL(path, document.baseURI)
  expect(url.origin).toBe(window.location.origin)
  const response = await fetch(url, { method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  const result: unknown = await response.json()
  expect(response.status, JSON.stringify(result)).toBe(status)
  return result
}
async function savedInput(commandId: string) {
  const managed = CurrentManagedWorkflowSchema.parse(await request(workflowPath))
  const saved = CurrentWorkflowReadResultSchema.parse(await request(`${workflowPath}/definition`))
  const graph = structuredClone(managed.workflow)
  nativeNode(graph.nodes[0]!).initialPrompt = `Updated by ${commandId}`
  return CurrentWorkflowSaveInputSchema.parse({ workspaceId, workflowId, commandId, executionSemanticsVersion: 3,
    expectedRevision: managed.revision, expectedWorkflowVersionId: saved.currentVersionId,
    expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
    graph })
}
beforeEach(() => { resetTestFixtures(); setMockScenario('normal') })
afterEach(() => { resetTestFixtures(); setMockScenario('normal') })

describe('current Board endpoints in the shared MSW stack', () => {
  it('reads capabilities and validates, saves, replays and reopens the complete pinned definition', async () => {
    const capabilities = CurrentWorkflowCapabilitiesSchema.parse(await request('/api/management/workflows/capabilities/v3'))
    expect(capabilities.executionSemanticsVersion).toBe(3)
    expect(capabilities.runtimeAdmission).toBe(false)
    const input = await savedInput('definition-roundtrip')
    const { commandId: _commandId, ...validation } = input
    void _commandId
    const checked = CurrentWorkflowValidationSchema.parse(await request(`${workflowPath}/definition/validate`, 'POST', validation))
    expect(checked.expectedAgentConfigurationVersionIds).toEqual(input.expectedAgentConfigurationVersionIds)
    const saved = CurrentWorkflowSaveResultSchema.parse(await request(`${workflowPath}/definition`, 'PUT', input))
    expect(saved.replayed).toBe(false)
    expect(saved.value.revision).toBe(input.expectedRevision + 1)
    expect(nativeNode(saved.value.version.definition.nodes[0]!).initialPrompt).toBe(nativeNode(input.graph.nodes[0]!).initialPrompt)
    const replay = CurrentWorkflowSaveResultSchema.parse(await request(`${workflowPath}/definition`, 'PUT', input))
    expect(replay).toEqual({ value: saved.value, replayed: true })
    const reopened = CurrentWorkflowReadResultSchema.parse(await request(`${workflowPath}/definition`))
    expect(reopened.version).toEqual(saved.value.version)
    expect(reopened.currentVersionId).toBe(saved.value.currentVersionId)
  })

  it('stages and discards the full local document through one definition journal without a server draft', async () => {
    const input = await savedInput('journal-roundtrip')
    const draftId = `board-${workflowId}`, path = `${workflowPath}/definition/edits`
    const empty = GraphEditReadResultV3Schema.parse(await request(`${path}?draftId=${draftId}`))
    expect(empty.intent).toBeNull()
    const stage = GraphEditStageInputV3Schema.parse({ ...input, draftId, action: 'stage_edits' })
    const staged = GraphEditReadResultV3Schema.parse(await request(path, 'POST', stage))
    expect(staged.intent!.stagedDraft.graph).toEqual(stage.graph)
    expect(staged.intent!.saveInput).toMatchObject({ graph: stage.graph,
      expectedRevision: stage.expectedRevision, expectedWorkflowVersionId: stage.expectedWorkflowVersionId,
      expectedAgentConfigurationVersionIds: stage.expectedAgentConfigurationVersionIds,
    })
    const replay = GraphEditReadResultV3Schema.parse(await request(path, 'POST', stage))
    expect(replay.intent!.id).toBe(staged.intent!.id)
    const discarded = GraphEditReadResultV3Schema.parse(await request(path, 'POST', {
      workspaceId, workflowId, draftId, intentId: staged.intent!.id,
      commandId: staged.intent!.discardCommandId, action: 'discard_edits',
    }))
    expect(discarded.intent!.state).toBe('discarded')
    const saved = CurrentWorkflowReadResultSchema.parse(await request(`${workflowPath}/definition`))
    expect(saved.revision).toBe(input.expectedRevision)
    expect(nativeNode(saved.version.definition.nodes[0]!).initialPrompt).not.toBe(nativeNode(stage.graph.nodes[0]!).initialPrompt)
  })

  it('keeps rename/archive, list and immutable definition reads on one revision authority', async () => {
    const before = CurrentManagedWorkflowSchema.parse(await request(workflowPath))
    const immutable = CurrentWorkflowReadResultSchema.parse(await request(`${workflowPath}/definition`))
    const result = await request(workflowPath, 'PATCH', { workspaceId, workflowId,
      commandId: 'rename-current-workflow', expectedRevision: before.revision, name: 'Review flow' })
    expect(result).toMatchObject({ value: { revision: before.revision + 1, workflow: { name: 'Review flow' } }, replayed: false })
    const renamed = CurrentManagedWorkflowSchema.parse(await request(workflowPath))
    expect(renamed.workflow.name).toBe('Review flow')
    const page = CurrentManagedWorkflowPageSchema.parse(await request(`${workspacePath}/workflows`))
    expect(page.items.find((item) => item.workflow.id === workflowId)?.workflow.name).toBe('Review flow')
    expect(CurrentWorkflowReadResultSchema.parse(await request(`${workflowPath}/definition`)).version).toEqual(immutable.version)
    await request(workflowPath, 'DELETE', { workspaceId, workflowId,
      commandId: 'archive-current-workflow', expectedRevision: renamed.revision })
    const active = CurrentManagedWorkflowPageSchema.parse(await request(`${workspacePath}/workflows`))
    expect(active.items.some((item) => item.workflow.id === workflowId)).toBe(false)
    const archived = CurrentManagedWorkflowPageSchema.parse(await request(`${workspacePath}/workflows?includeArchived=true`))
    expect(archived.items.find((item) => item.workflow.id === workflowId)?.archivedAt).not.toBeNull()
  })

  it('creates and patches Agents with exact receipts, current catalog pins and immutable configuration history', async () => {
    const path = `${workspacePath}/agents`, agentId = 'agent-endpoint-roundtrip'
    const input = { agentId, commandId: 'create-current-agent', name: 'Current Worker', productRole: 'coder',
      configuration: DEFAULT_HARNESS_DEFAULTS.codex, prompt: {}, assignedSkills: [] }
    const created = AgentMutationResultSchema.parse(await request(path, 'POST', input, 201))
    expect(created.value.metadataRevision).toBe(1)
    expect(AgentMutationResultSchema.parse(await request(path, 'POST', input, 201))).toEqual({ value: created.value, replayed: true })
    const firstPin = created.value.agent.configurationVersionId!
    const previous = AgentVersionResultSchema.parse(await request(`${path}/${agentId}/versions/${firstPin}`))
    const patch = { commandId: 'update-current-agent', expectedRevision: 1, expectedConfigurationVersionId: firstPin,
      name: 'Changed Worker', configuration: { ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'synthetic-next-model' } }
    const updated = AgentMutationResultSchema.parse(await request(`${path}/${agentId}`, 'PATCH', patch))
    expect(updated.value.metadataRevision).toBe(2)
    expect(updated.value.agent.configurationVersionId).not.toBe(firstPin)
    expect(AgentMutationResultSchema.parse(await request(`${path}/${agentId}`, 'PATCH', patch))).toEqual({ value: updated.value, replayed: true })
    const catalog = ManagedAgentPageSchema.parse(await request(`${path}?limit=100`))
    expect(catalog.items.filter((item) => item.agent.id === agentId)).toHaveLength(1)
    expect(catalog.items.find((item) => item.agent.id === agentId)).toMatchObject(updated.value)
    expect(AgentVersionResultSchema.parse(await request(`${path}/${agentId}/versions/${firstPin}`))).toEqual(previous)
    const current = AgentVersionResultSchema.parse(await request(`${path}/${agentId}/versions/${updated.value.agent.configurationVersionId}`))
    expect(current.version.harness.model).toBe('synthetic-next-model')
    expect(await request(`${path}/${agentId}`, 'PATCH', { ...patch, name: 'Changed replay payload' }, 409)).toMatchObject({ error: { code: 'COMMAND_CONFLICT' } })
    expect(await request(`${path}/${agentId}`, 'PATCH', { ...patch, commandId: 'stale-agent-revision' }, 409)).toMatchObject({ error: { code: 'REVISION_CONFLICT' } })
    expect(await request(`${path}/${agentId}`, 'PATCH', { ...patch, commandId: 'stale-agent-configuration', expectedRevision: 2 }, 409)).toMatchObject({ error: { code: 'CONFIGURATION_CONFLICT' } })
  })
})
