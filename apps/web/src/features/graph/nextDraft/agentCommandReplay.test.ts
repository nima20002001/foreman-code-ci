import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { describe, expect, it, vi } from 'vitest'
import { ApiClient } from '../../../shared/api/client'
import { fixture } from './core.cases'
import { createNextDraftApi } from './transport'
import type { DraftRequest } from './state'

const response = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json' },
})

describe('pending Board Agent commands', () => {
  it.each(['patch-response', 'catalog-refresh'].flatMap((failure) =>
    ['configure', 'rename-first', 'configure-first'].map((order) => ({ failure, order }))))(
    'replays immutable input after losing $failure with $order', async ({ failure, order }) => {
    const context = fixture()
    const original = context.agents[0]!
    const committed = { metadataRevision: original.metadataRevision + 1,
      agent: { ...original.agent, configurationVersionId: 'configuration-after-commit', description: 'Updated' } }
    let receipt: string | undefined
    let lost = false
    const events: string[] = []
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      if (init?.method === 'PATCH') {
        events.push('patch')
        const body = String(init.body)
        if (receipt !== undefined) expect(body).toBe(receipt)
        else receipt = body
        if (failure === 'patch-response' && !lost) {
          lost = true
          throw new TypeError('Response lost after commit')
        }
        return response({ value: committed, replayed: lost })
      }
      if (String(_url).split('?')[0]!.endsWith('/agents')) {
        events.push('catalog')
        if (receipt && failure === 'catalog-refresh' && !lost) {
          lost = true
          throw new TypeError('Catalog refresh failed')
        }
        return response({ items: [receipt ? committed : original], pageInfo: { nextCursor: null } })
      }
      return response({ workflow: context.draft.graph, revision: 7, currentVersionId: null, archivedAt: null })
    })
    const api = createNextDraftApi(new ApiClient({ fetch }))
    const draft = await api.open('workspace', 'workflow')
    const request: DraftRequest = { kind: 'apply', executionSemanticsVersion: 3, workspaceId: 'workspace', workflowId: 'workflow',
      draftId: draft.id, commandId: 'immutable-agent-command', expectedRevision: draft.revision,
      operations: [{ type: 'agent.configure', agentId: original.agent.id, expectedAgentRevision: original.metadataRevision,
        configuration: DEFAULT_HARNESS_DEFAULTS.codex, prompt: {}, assignedSkills: [], description: 'Updated' }] }
    if (order !== 'configure') {
      const rename = { type: 'agent.rename' as const, agentId: original.agent.id,
        expectedAgentRevision: original.metadataRevision, name: 'Renamed' }
      request.operations = order === 'rename-first' ? [rename, ...request.operations!] : [...request.operations!, rename]
    }
    await expect(api.write(request)).rejects.toThrow()
    const retryStart = events.length
    const result = await api.write(request)
    expect(events.slice(retryStart)).toEqual(['patch', 'catalog'])
    expect(JSON.parse(receipt!)).toMatchObject({ commandId: 'immutable-agent-command:0',
      expectedRevision: original.metadataRevision, expectedConfigurationVersionId: original.agent.configurationVersionId })
    if (order !== 'configure') expect(JSON.parse(receipt!)).toMatchObject({ name: 'Renamed', description: 'Updated',
      configuration: DEFAULT_HARNESS_DEFAULTS.codex, prompt: {}, assignedSkills: [] })
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(2)
    expect(result.agents).toEqual([committed])
    expect(result.draft.revision).toBe(draft.revision + 1)
  })
})
