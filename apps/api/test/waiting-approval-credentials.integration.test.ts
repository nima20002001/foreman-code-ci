import { readUntil } from './helpers/observableCondition.js'
import { expect, it, vi } from 'vitest'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { approvalResponse } from './helpers/eng06ApprovalFaults.js'
import { renewOwnedLeases } from '../src/modules/leases/ownerLeases.js'
import { Wave25WorkerCredentialService } from '../src/modules/interactions/wave25/credentials.js'
import { APP_MCP_TOKEN_ENVIRONMENT_VARIABLE, WORKER_CREDENTIAL_RENEWAL_WINDOW_MS } from '../src/modules/access/workerCredentials.js'

it('issues and renews against database time despite API clock offsets and jumps', async () => {
  const f = await currentOperatorIntegration()
  const wallNow = Date.now.bind(Date)
  let now: { mockRestore(): void } | undefined
  let stop: (() => Promise<void>) | undefined
  try {
    await f.engine.start(f.f.run.id)
    const [pending] = (await f.pending()).filter(item => item.status === 'pending')
    if (!pending?.executionId) throw new Error('Expected a pending requester')
    const service = new Wave25WorkerCredentialService(f.db.pool, f.access, 60_000)
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => wallNow() - 120_000)
    now = clock
    const credential = await service.issueForExecution(pending.executionId)
    const lease = async () => (await f.db.pool.query<{ remaining_ms: number; expires_at: Date }>(
      `select (extract(epoch from (expires_at-clock_timestamp()))*1000)::float8 as remaining_ms,expires_at
       from management_principals where id=$1 and revoked_at is null`, [credential.principalId])).rows[0]!
    expect((await lease()).remaining_ms).toBeGreaterThan(30_000)
    expect((await lease()).remaining_ms).toBeLessThanOrEqual(60_000)
    const failures: Error[] = []
    const lifetime = credential as typeof credential & { renewalDeadline?: number }
    const remainingMs = () => lifetime.renewalDeadline === undefined
      ? Date.parse(credential.expiresAt) - Date.now() : lifetime.renewalDeadline - performance.now()
    stop = renewOwnedLeases({ signal: new AbortController().signal, onFailure: error => failures.push(error),
      leases: [{ name: 'execution credential', renewWithinMs: WORKER_CREDENTIAL_RENEWAL_WINDOW_MS, remainingMs,
        renew: async () => { credential.expiresAt = await service.renewForExecution(pending.executionId!, credential) } }],
    })
    for (const offset of [120_000, -180_000, 0]) {
      clock.mockImplementation(() => wallNow() + offset)
      const before = await lease()
      const after = await readUntil(lease, value => value.expires_at.getTime() > before.expires_at.getTime(),
        { timeoutMs: 10_000, description: 'credential renewal after API clock change' })
      expect(after.expires_at.getTime()).toBeGreaterThan(before.expires_at.getTime())
      expect(after.remaining_ms).toBeGreaterThan(30_000)
      expect(failures).toEqual([])
    }
    await stop()
    stop = undefined
    clock.mockRestore()
    expect((await f.access.authenticate(credential.environment.variables[APP_MCP_TOKEN_ENVIRONMENT_VARIABLE], 'worker')).id)
      .toBe(credential.principalId)
    await service.revoke(credential)
    const response = await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(pending))
    expect(response.interaction.deliveryState).toBe('delivered')
  } finally {
    await stop?.()
    now?.mockRestore()
    await f.close()
  }
}, 60_000)

it('stops renewing the waiting requester after its accepted Run authority is revoked', async () => {
  const f = await currentOperatorIntegration({ credentialTtlMs: 60_000 })
  try {
    await f.engine.start(f.f.run.id)
    const [pending] = (await f.pending()).filter(item => item.status === 'pending')
    if (!pending?.executionId) throw new Error('Expected a pending requester')
    expect((await f.native.inspectInteractionActivity(pending)).response)
      .toMatchObject({ qualified: true, usable: true })
    await f.access.revoke(f.authorizationPrincipalId)
    const inactive = await readUntil(() => f.native.inspectInteractionActivity(pending),
      activity => !activity.response.usable, {
        timeoutMs: 10_000, description: 'waiting requester losing revoked Run authority',
      })
    expect(inactive.response)
      .toMatchObject({ qualified: false, usable: false, path: null })
    const readExpiry = async () => (await f.db.pool.query<{ expires_at: Date }>(
      'select p.expires_at from management_principals p join worker_credential_bindings b on b.principal_id=p.id where b.execution_id=$1',
      [pending.executionId])).rows[0]!.expires_at.toISOString()
    const stopped = await readExpiry()
    // eslint-disable-next-line no-restricted-syntax -- Proves no further renewal occurs after authority loss.
    await new Promise<void>(resolve => setTimeout(resolve, 2_000))
    expect(await readExpiry()).toBe(stopped)
    expect(await f.repository.get(pending.id)).toMatchObject({ status: 'pending', deliveryState: 'not_started' })
    expect(f.provider.counts.responses).toBe(0)
    expect(f.provider.counts.starts).toBe(2)
  } finally { await f.close() }
}, 60_000)
