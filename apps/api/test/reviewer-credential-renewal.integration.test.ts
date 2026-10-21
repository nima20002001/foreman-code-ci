import { afterEach, expect, it, vi } from 'vitest'
import { WorkerCredentialService } from '../src/modules/access/workerCredentials.js'
import { routedApprovalFixture } from './helpers/routedApprovalFixture.js'

afterEach(() => vi.restoreAllMocks())

it('renews only the bound reviewer principal and execution and persists the same token', async () => {
  const f = await routedApprovalFixture()
  try {
    const service = new WorkerCredentialService(f.db.pool, f.access, 60_000)
    const credential = await f.credentials.issueForReviewer(f.reviewer.id)
    const other = await f.credentials.issueForExecution(f.requester.id)
    const token = credential.environment.variables.GRAPHQL_MCP_TOKEN!
    const read = async () => (await f.db.pool.query(
      'select expires_at,token_hash,revoked_at from management_principals where id=$1',
      [credential.principalId])).rows[0]!
    const before = await read()
    await expect(service.renewForExecution(f.requester.id, credential))
      .rejects.toMatchObject({ code: 'WORKER_CREDENTIAL_NOT_RENEWABLE' })
    await expect(service.renewForExecution(f.reviewer.id, other))
      .rejects.toMatchObject({ code: 'WORKER_CREDENTIAL_NOT_RENEWABLE' })
    await expect(service.renewForExecution(f.reviewer.id, { principalId: 'unbound-principal' }))
      .rejects.toMatchObject({ code: 'WORKER_CREDENTIAL_NOT_RENEWABLE' })
    expect(await read()).toEqual(before)
    const expiry = await service.renewForExecution(f.reviewer.id, credential)
    const after = await read()
    expect(after.expires_at.toISOString()).toBe(expiry)
    expect(after.expires_at.getTime()).toBeGreaterThanOrEqual(before.expires_at.getTime())
    expect(after.token_hash).toBe(before.token_hash)
    expect(after.revoked_at).toBeNull()
    expect(await f.access.authenticate(token, 'worker')).toMatchObject({
      id: credential.principalId,
      expiresAt: expiry,
    })
    expect(credential.renewalDeadline).toBeGreaterThan(performance.now())
  } finally { await f.close() }
}, 60_000)

it('keeps the saved reviewer and its renewable credential after rejecting a reviewer pin change', async () => {
  const f = await routedApprovalFixture()
  try {
    const service = new WorkerCredentialService(f.db.pool, f.access, 60_000)
    const credential = await f.credentials.issueForReviewer(f.reviewer.id)
    await expect(f.db.pool.query(`update runs set record=jsonb_set(record,
      '{approval,designatedOrchestratorAgentId}',to_jsonb($2::text)) where id=$1`,
    [f.run.id, f.requester.agentId])).rejects.toMatchObject({ code: 'P0001' })
    expect((await f.runs.get(f.run.id))?.approval).toEqual(f.run.approval)
    await expect(service.renewForExecution(f.reviewer.id, credential)).resolves.toEqual(expect.any(String))
    expect((await f.access.authenticate(credential.environment.variables.GRAPHQL_MCP_TOKEN!, 'worker')).agentId)
      .toBe(f.reviewer.agentId)
  } finally { await f.close() }
}, 60_000)

it.each([
  'expired',
  'principal revoked',
  'binding revoked',
  'reviewer identity changed',
  'binding identity changed',
  'session not finalized',
  'run closed',
])(
  'refuses reviewer renewal when %s and leaves persisted expiry unchanged', async condition => {
    const f = await routedApprovalFixture()
    try {
      const service = new WorkerCredentialService(f.db.pool, f.access, 60_000)
      const credential = await f.credentials.issueForReviewer(f.reviewer.id)
      const token = credential.environment.variables.GRAPHQL_MCP_TOKEN!
      expect(await f.access.authenticate(token, 'worker')).toMatchObject({
        id: credential.principalId,
        agentId: f.reviewer.agentId,
      })
      const deadline = credential.renewalDeadline
      if (condition === 'expired') {
        await f.db.pool.query("update management_principals set expires_at=clock_timestamp()-interval '1 second' where id=$1",
          [credential.principalId])
      } else if (condition === 'principal revoked') {
        await f.db.pool.query('update management_principals set revoked_at=clock_timestamp() where id=$1',
          [credential.principalId])
      } else if (condition === 'binding revoked') {
        await f.db.pool.query('update worker_credential_bindings set revoked_at=clock_timestamp() where principal_id=$1',
          [credential.principalId])
      } else if (condition === 'reviewer identity changed') {
        await f.db.pool.query('update management_principals set agent_id=$2 where id=$1',
          [credential.principalId, f.requester.agentId])
      } else if (condition === 'binding identity changed') {
        await f.db.pool.query('update worker_credential_bindings set agent_id=$2 where principal_id=$1',
          [credential.principalId, f.requester.agentId])
      } else if (condition === 'session not finalized') {
        await f.db.pool.query('update execution_native_sessions set workflow_finalized_at=null where execution_id=$1',
          [f.reviewer.id])
      } else {
        await f.db.pool.query('update runs set worker_credentials_closed_at=clock_timestamp() where id=$1', [f.run.id])
      }
      expect((await f.runs.get(f.run.id))?.approval).toEqual(f.run.approval)
      const readExpiry = async () => (await f.db.pool.query(
        'select expires_at from management_principals where id=$1', [credential.principalId])).rows[0]!.expires_at
      const before = await readExpiry()
      await expect(service.renewForExecution(f.reviewer.id, credential))
        .rejects.toMatchObject({ code: 'WORKER_CREDENTIAL_NOT_RENEWABLE' })
      expect(await readExpiry()).toEqual(before)
      expect(credential.renewalDeadline).toBe(deadline)
      await expect(f.access.authenticate(credential.environment.variables.GRAPHQL_MCP_TOKEN!, 'worker'))
        .rejects.toMatchObject({ status: 401 })
    } finally { await f.close() }
  }, 60_000,
)
