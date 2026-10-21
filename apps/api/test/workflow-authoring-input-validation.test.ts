import { expect, it } from 'vitest'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { CurrentWorkflowAuthoring } from '../src/modules/workflows/currentAuthoring.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'

const pool = {} as pg.Pool
const authoring = new CurrentWorkflowAuthoring(pool, new PostgresCommandCoordinator(pool))
const principal: ManagementPrincipal = {
  id: 'operator', name: 'Operator', audience: 'operator', expiresAt: '2099-01-01T00:00:00.000Z',
  revokedAt: null, grants: [],
}

it.each(['save', 'validate', 'stage'] as const)('returns graph-relative issues for invalid %s input', async (operation) => {
  const fixture = makeCurrentWorkflowFixture('input-validation', 'repeat')
  const input = {
    workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId,
    commandId: 'save-command', executionSemanticsVersion: 3,
    expectedRevision: 1, expectedWorkflowVersionId: fixture.version.id,
    expectedAgentConfigurationVersionIds: fixture.version.agentConfigurationVersionIds,
    graph: { ...fixture.version.definition, handoffs: { contractVersion: 1 } },
  }
  const invoke = (): Promise<unknown> => {
    if (operation === 'save') return authoring.save(principal, 'mcp', input)
    if (operation === 'validate') {
      const { commandId, ...validation } = input
      void commandId
      return authoring.validate(principal, validation)
    }
    return authoring.mutateEdits(principal, 'mcp', { ...input, action: 'stage_edits', draftId: 'draft' })
  }
  await expect(Promise.resolve().then(invoke)).rejects.toMatchObject({
    code: 'GRAPH_INVALID', status: 409,
    details: { issues: [{ code: 'custom', path: ['handoffs'], message: 'HANDOFF_REPEAT_POLICY_CONFLICT' }] },
  })
})

it.each(['read', 'readEdits', 'mutateEdits'] as const)('returns a request error for malformed %s input', async (operation) => {
  const invoke = (): Promise<unknown> => operation === 'mutateEdits'
    ? authoring.mutateEdits(principal, 'mcp', {})
    : authoring[operation](principal, {})
  await expect(Promise.resolve().then(invoke)).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
})
