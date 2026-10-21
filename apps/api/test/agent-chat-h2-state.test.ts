import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { AgentChatStateSchema } from '@foreman-code/contracts/agent-chat'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'

const principal: ManagementPrincipal = { id: 'h2-reader', name: 'Reader', audience: 'operator', revokedAt: null,
  expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['agent_chat:read'], scope: {} }] }
/** Scripted authority read only; no native process or Run access. */
function service() {
  type Ports = ConstructorParameters<typeof AgentChatService>
  const forbidden = () => { throw new Error('Unexpected I/O while describing an unopened chat.') }
  return new AgentChatService({ query: async (sql: string) => {
    if (!sql.startsWith('select id,name,audience,grants,expires_at,revoked_at,delegated_from from management_principals')) forbidden()
    return { rows: [{ id: principal.id, name: principal.name, audience: principal.audience, grants: principal.grants,
      expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }] }
  } } as unknown as Ports[0], {} as Ports[1], {} as Ports[2],
    { getSavedVersion: forbidden, getCurrentSavedVersion: forbidden, getAgentConfiguration: forbidden },
    { getForWorkspace: forbidden, executionPages: forbidden, getExecution: forbidden }, forbidden, '/h2-not-used')
}

describe('H2 A-R01: truthful chat availability without changing the frozen contract', () => {
  for (const harness of ['codex'] as const) {
    it(`${harness}: an unopened chat states its scoped capabilities without blocking ordinary chat`, async () => {
      const fixture = makeCurrentWorkflowFixture('h2-state', 'single')
      const configuration = structuredClone(fixture.configurations[0]!)

      const context = { workspaceId: configuration.workspaceId, workflowId: fixture.scope.workflowId,
        workflowNodeId: fixture.version.definition.nodes[0]!.id, agentId: configuration.agentId }
      const chat = service()
      try {
        const state = await chat['state']({ context, configuration }, principal)
        assert.equal(AgentChatStateSchema.safeParse(state).success, true)
        assert.equal(state.availability.canSend, true)
        assert.match(state.availability.message!, /accepted configuration and scoped workflow capabilities/)
        assert.equal(state.availability.reason, undefined)
        assert.equal(state.capabilities.harness, harness)
        assert.equal(state.capabilities.resume, true)
        assert.equal(state.capabilities.steer, 'unavailable', 'an unopened chat has no live turn to steer')
        assert.equal(state.conversation, null)
        assert.equal(state.sessionState, 'none')
        const blocked = await chat['state']({ context, configuration, blocked: { reason: 'run_active', message: 'The Run is still active.' } }, principal)
        assert.deepEqual(blocked.availability, { canSend: false, reason: 'run_active', message: 'The Run is still active.' })
      } finally { await chat.shutdown() }
    })
  }
})
