import assert from 'node:assert/strict'
import { it, vi } from 'vitest'
import type pg from 'pg'
import type { DurableInteraction } from '@foreman-code/contracts'
import { ManagementPrincipalSchema } from '@foreman-code/contracts/management'
import { DomainError } from '../src/modules/errors.js'
import { acceptRunAuthority, bindRunAuthority, currentOperatorAuthority } from '../src/modules/access/runAuthority.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import type { InteractionService } from '../src/modules/interactions/service.js'
import type { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'

function interaction(): DurableInteraction {
  return { id: 'interaction-proof', revision: 0, workspaceId: 'workspace', workflowId: 'workflow', runId: 'run',
    executionId: 'execution', requestingAgentId: 'coder', harness: 'codex', providerVersion: '0.154.0',
    nativeSessionId: 'session', nativeRequestId: 'request', nativeRequestType: 'item/commandExecution/requestApproval',
    graphThreadId: 'run', request: { command: 'test' },
    approval: { handler: 'orchestrator', designatedOrchestratorAgentId: 'reviewer' },
    responseOptions: [{ optionId: 'choice', semantic: 'approve_once', label: 'Approve once', persistence: 'request',
      affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }],
    status: 'pending', deliveryState: 'not_started', createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z' }
}
const principal = () => ManagementPrincipalSchema.parse({ id: 'worker', name: 'Reviewer', audience: 'worker', agentId: 'reviewer',
  grants: [{ actions: ['interactions:read', 'interactions:respond'], scope: { workspaceIds: ['workspace'], workflowIds: ['workflow'], runIds: ['run'] } }],
  expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null })

for (const revoked of [true, false]) it(`F03: App response forwards exact worker authority to the current decision writer; revoked=${revoked}`, async () => {
  const record = interaction(), actor = principal()
  const recordAudit = vi.fn(async () => undefined)
  const commands = { recordAudit, recordDenied: vi.fn(async () => undefined) } as unknown as PostgresCommandCoordinator
  const respond: InteractionService['respond'] = async (responder, input) => {
    assert.equal(responder.kind, 'orchestrator')
    assert.equal(responder.principal, actor)
    assert(!('beforeCommit' in responder), 'raw audit callbacks cannot join the current G1 decision transaction')
    if (responder.kind === 'orchestrator') assert.deepEqual(responder.authority,
      { agentId: actor.agentId, workspaceId: record.workspaceId, workflowId: record.workflowId })
    assert.deepEqual(input, { interactionId: record.id, optionId: 'choice', expectedRevision: 0 })
    if (revoked) throw new DomainError('AUTH_REVOKED', 'The live binding was revoked before commit.', 401)
    return { interaction: { ...record, revision: 1, selectedOptionId: 'choice', selectedSemantic: 'approve_once', nativeResponse: null,
      decidedAt: '2026-09-16T00:00:01.000Z', status: 'delivery_pending', deliveryState: 'pending' }, replayed: false }
  }
  const repository = { get: async () => structuredClone(record) } as unknown as PostgresInteractionRepository
  const app = new PostgresAppInteractionService({} as pg.Pool, repository, commands, { respond })
  const action = app.respond(actor, { interactionId: record.id, optionId: 'choice', expectedRevision: 0 })
  if (revoked) {
    await assert.rejects(action, (error: unknown) => error instanceof DomainError && error.code === 'AUTH_REVOKED')
    assert.equal(record.selectedOptionId, undefined)
    assert.equal((recordAudit.mock.calls[0] as unknown[])[4], 'failed')
  } else {
    assert.equal((await action).interaction.selectedOptionId, 'choice')
    assert.equal(recordAudit.mock.calls.length, 0, 'the decision writer owns the successful transactional audit')
  }
})

function authorityDatabase() {
  const expires = new Date(Date.now() + 3_600_000)
  const rows = new Map<string, Record<string, unknown>>([
    ['owner', { id: 'owner', name: 'Owner', audience: 'operator', revoked_at: null, delegated_from: null, expires_at: expires,
      grants: [{ actions: ['runs:start', 'workspace_locations:read', 'operator_chat:write'], scope: { workspaceIds: ['workspace'] } }] }],
    ['chat', { id: 'chat', name: 'Chat transport', audience: 'operator', revoked_at: null, delegated_from: 'owner', expires_at: expires,
      grants: [{ actions: ['runs:start', 'workspace_locations:read'], scope: { workspaceIds: ['workspace'] } }] }],
  ])
  const bindings = new Map<string, Record<string, unknown>>()
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith('select id,name,audience,grants')) return { rows: rows.has(String(values[0])) ? [rows.get(String(values[0]))!] : [], rowCount: 1 }
    if (sql.includes('from run_authority_principals')) return { rows: bindings.has(String(values[0])) ? [bindings.get(String(values[0]))!] : [], rowCount: 1 }
    if (sql.startsWith('select id from management_principals')) return { rows: [], rowCount: 0 }
    if (sql.startsWith('insert into management_principals')) {
      rows.set(String(values[0]), { id: values[0], name: values[1], audience: 'operator', revoked_at: null,
        grants: JSON.parse(String(values[3])), expires_at: new Date(String(values[4])), delegated_from: values[5] })
      assert.match(String(values[2]), /^[0-9a-f]{64}$/)
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('insert into run_authority_principals')) {
      bindings.set(String(values[0]), { owner_principal_id: values[2], caller_principal_id: values[3],
        grant_ceiling: JSON.parse(String(values[4])), accepted_expires_at: new Date(String(values[5])) })
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`Unexpected authority query: ${sql}`)
  }
  const db = { query } as unknown as pg.PoolClient
  const row = rows.get('chat')!
  const caller = ManagementPrincipalSchema.parse({ id: row.id, name: row.name, audience: row.audience, grants: row.grants,
    expiresAt: expires.toISOString(), revokedAt: null })
  return { rows, bindings, db, caller }
}

it('F04: chat release cannot revoke the Run snapshot, but human-owner revocation still can', async () => {
  const h = authorityDatabase()
  const accepted = await acceptRunAuthority(h.db, h.caller)
  assert.equal(accepted.callerId, 'chat')
  assert.equal(accepted.ownerId, 'owner')
  await bindRunAuthority(h.db, 'run', accepted)
  h.rows.get('chat')!.revoked_at = new Date()
  const current = await currentOperatorAuthority(h.db, accepted.principal.id)
  assert.equal(current.owner.id, 'owner')
  assert(current.principal.grants.some((grant) => grant.actions.includes('runs:start')))
  h.rows.get('owner')!.revoked_at = new Date()
  await assert.rejects(currentOperatorAuthority(h.db, accepted.principal.id), (error: unknown) => error instanceof DomainError && error.code === 'AUTH_REVOKED')
})

it('F04: both the accepted grant ceiling and the owner’s current narrower permissions apply', async () => {
  const h = authorityDatabase()
  const accepted = await acceptRunAuthority(h.db, h.caller)
  await bindRunAuthority(h.db, 'run', accepted)
  h.rows.get('owner')!.grants = [{ actions: ['runs:start', 'runs:stop'], scope: { workspaceIds: ['workspace', 'another'] } }]
  const current = await currentOperatorAuthority(h.db, accepted.principal.id)
  assert(!current.principal.grants.some((grant) => grant.actions.includes('workspace_locations:read') || grant.actions.includes('runs:stop')))
  assert(current.principal.grants.every((grant) => !grant.scope.workspaceIds?.includes('another')))
  assert(Date.parse(current.principal.expiresAt) <= Date.parse(accepted.principal.expiresAt))
})

it('F04: an ordinary delegated chat principal is not accepted as durable Run authority', async () => {
  const h = authorityDatabase()
  await assert.rejects(currentOperatorAuthority(h.db, 'chat'), (error: unknown) => error instanceof DomainError && error.code === 'AUTH_INVALID')
})


it('an accepted Run survives expiry of the chat token that started it', async () => {
  const h = authorityDatabase()
  const tokenExpiry = Date.now() + 60_000
  h.rows.get('chat')!.expires_at = new Date(tokenExpiry)
  h.caller.expiresAt = new Date(tokenExpiry).toISOString()
  const accepted = await acceptRunAuthority(h.db, h.caller)
  await bindRunAuthority(h.db, 'run', accepted)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(tokenExpiry + 1)
  try {
    const current = await currentOperatorAuthority(h.db, accepted.principal.id)
    assert(current.principal.grants.some(grant => grant.actions.includes('runs:start')))
    assert(Date.parse(current.principal.expiresAt) > Date.now())
  } finally {
    clock.mockRestore()
  }
})

it('an accepted Run survives root starter expiry while retaining owner revocation', async () => {
  const h = authorityDatabase()
  const owner = await currentOperatorAuthority(h.db, 'owner')
  const accepted = await acceptRunAuthority(h.db, owner.principal)
  await bindRunAuthority(h.db, 'run', accepted)
  h.rows.get('owner')!.expires_at = new Date(Date.now() - 1)
  const current = await currentOperatorAuthority(h.db, accepted.principal.id)
  assert.equal(current.owner.id, 'owner')
  await assert.rejects(currentOperatorAuthority(h.db, 'owner'),
    (error: unknown) => error instanceof DomainError && error.code === 'AUTH_EXPIRED')
  h.rows.get('owner')!.revoked_at = new Date()
  await assert.rejects(currentOperatorAuthority(h.db, accepted.principal.id),
    (error: unknown) => error instanceof DomainError && error.code === 'AUTH_REVOKED')
  await assert.rejects(currentOperatorAuthority(h.db, 'owner'),
    (error: unknown) => error instanceof DomainError && error.code === 'AUTH_REVOKED')
})
