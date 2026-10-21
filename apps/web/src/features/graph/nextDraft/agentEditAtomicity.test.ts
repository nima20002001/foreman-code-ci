import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { ApiClient } from '../../../shared/api/client'
import { coalesceAgentEdits, configureAgentOperations } from './agentEdits'
import { fixture } from './core.cases'
import { createNextDraftApi } from './transport'

describe('existing Agent edits are atomic', () => {
  it.each([false, true])('sends name and content in one revision-checked PATCH (reverse=%s)', async (reverse) => {
    const context = fixture()
    const source = context.agents[0]!
    source.agent.harnessConfiguration = DEFAULT_HARNESS_DEFAULTS.codex
    const edited = { ...source.agent, name: 'Renamed reviewer', description: 'Updated instructions' }
    const operations = configureAgentOperations(context, context.draft.graph, { [edited.id]: edited })
    if (reverse) operations.reverse()
    const original = structuredClone(operations)
    const client = new ApiClient()
    const patches: unknown[] = []
    let revision = source.metadataRevision
    vi.spyOn(client, 'listManagedAgents').mockImplementation(async () => ({
      items: [{ ...source, metadataRevision: revision }], pageInfo: { nextCursor: null },
    }))
    vi.spyOn(client, 'request').mockImplementation(async (_path, _schema, options) => {
      if (options?.method === 'PATCH') {
        const body = options.body as { expectedRevision: number }
        if (body.expectedRevision !== revision) throw new Error('AGENT_REVISION_CONFLICT')
        patches.push(body)
        revision += 1
        return { value: { ...source, agent: edited, metadataRevision: revision }, replayed: false }
      }
      return { revision: 7, workflow: context.draft.graph, currentVersionId: null }
    })
    const api = createNextDraftApi(client)
    const draft = await api.open(context.draft.workspaceId, context.draft.workflowId)
    await api.write({ kind: 'apply', executionSemanticsVersion: 3, workspaceId: draft.workspaceId,
      workflowId: draft.workflowId, draftId: draft.id, expectedRevision: draft.revision,
      commandId: 'atomic-agent-edit', operations })
    expect(patches).toEqual([expect.objectContaining({ commandId: 'atomic-agent-edit:0', name: edited.name,
      description: edited.description, configuration: edited.harnessConfiguration, expectedRevision: source.metadataRevision,
      expectedConfigurationVersionId: source.agent.configurationVersionId })])
    expect(revision).toBe(source.metadataRevision + 1)
    expect(operations).toEqual(original)
  })

  it('rejects inconsistent original revisions before dispatch', () => {
    const operations = [
      { type: 'agent.rename' as const, agentId: 'agent', expectedAgentRevision: 3, name: 'New' },
      { type: 'agent.configure' as const, agentId: 'agent', expectedAgentRevision: 4,
        configuration: DEFAULT_HARNESS_DEFAULTS.codex, prompt: {}, assignedSkills: [] },
    ]
    expect(() => coalesceAgentEdits(operations)).toThrow('same original revision')
  })
})
