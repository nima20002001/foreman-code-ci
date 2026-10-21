import { afterEach, describe, expect, it } from 'vitest'
import { assertOrchestratorGraphAuthority } from '../src/modules/interactions/graphAuthority.js'
import { resolveImmutableApprovalRoute } from '../src/modules/workflows/approvalRoutes.js'
import { approvalDatabase } from './helpers/wave25ApprovalDatabase.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
async function setup() {
  const f = await approvalDatabase(); cleanup.push(f.close)
  return { ...f, bound: { executionId: f.reviewer.id, principalId: f.principal.id, nativeSessionId: f.reviewer.nativeSessionId! } }
}

describe.skipIf(!postgresEnabled)('Wave 2.5 approval authority SQL consumer', { timeout: 60000 }, () => {
  it('reads the persisted exact typed assignment and pins through the real query', async () => {
    const f = await setup()
    await expect(assertOrchestratorGraphAuthority(f.pool, f.interaction, f.bound)).resolves.toMatchObject({
      requestingNodeId: f.requester.workflowNodeId, orchestratorNodeId: f.reviewer.workflowNodeId,
    })
    const stored = await f.pool.query<{ record: unknown }>('select record from workflow_versions where id=$1', [f.version.id])
    expect(stored.rows[0]!.record).toEqual(f.version)
    await expect(assertOrchestratorGraphAuthority(f.pool, f.interaction, { ...f.bound, principalId: 'not-bound' }))
      .rejects.toMatchObject({ code: 'INTERACTION_ACCESS_DENIED' })
  })

  it('observes credential revocation committed by an independent connection', async () => {
    const f = await setup()
    const reader = await f.pool.connect()
    try {
      const writer = await f.pool.connect()
      try {
        const readerPid = await reader.query<{ pid: number }>('select pg_backend_pid() as pid')
        const writerPid = await writer.query<{ pid: number }>('select pg_backend_pid() as pid')
        expect(readerPid.rows[0]!.pid).not.toBe(writerPid.rows[0]!.pid)
        await expect(assertOrchestratorGraphAuthority(reader, f.interaction, f.bound)).resolves.toBeDefined()
        await writer.query('begin')
        try {
          await writer.query('update worker_credential_bindings set revoked_at=clock_timestamp() where principal_id=$1', [f.bound.principalId])
          await writer.query('commit')
        } catch (error) {
          await writer.query('rollback')
          throw error
        }
        await expect(assertOrchestratorGraphAuthority(reader, f.interaction, f.bound))
          .rejects.toMatchObject({ code: 'INTERACTION_ACCESS_DENIED' })
      } finally { writer.release() }
    } finally { reader.release() }
  })

  it('refuses a previously captured reviewer session after a persisted owner-record change', async () => {
    const f = await setup()
    const changed = { ...f.reviewer, nativeSessionId: 'replacement-session' }
    await f.pool.query('update harness_executions set record=$2::jsonb where id=$1', [f.reviewer.id, JSON.stringify(changed)])
    try {
      await expect(assertOrchestratorGraphAuthority(f.pool, f.interaction, f.bound))
        .rejects.toMatchObject({ code: 'INTERACTION_ACCESS_DENIED' })
    } finally {
      await f.pool.query('update harness_executions set record=$2::jsonb where id=$1', [f.reviewer.id, JSON.stringify(f.reviewer)])
    }
  })

  it('rejects changes to a pinned version and does not infer approval from execution adjacency', async () => {
    const f = await setup()
    const changed = structuredClone(f.version)
    changed.definition.edges = changed.definition.edges.filter((edge) => edge.kind === 'execution')
    expect(resolveImmutableApprovalRoute(changed, f.requester.workflowNodeId, f.requester.agentId)).toBeUndefined()
    await expect(f.pool.query('update workflow_versions set record=$2::jsonb where id=$1', [changed.id, JSON.stringify(changed)]))
      .rejects.toMatchObject({ code: 'P0001', message: 'REPEAT_VERSION_IMMUTABLE' })
    const stored = await f.pool.query<{ record: unknown }>('select record from workflow_versions where id=$1', [f.version.id])
    expect(stored.rows[0]!.record).toEqual(f.version)
    await expect(assertOrchestratorGraphAuthority(f.pool, f.interaction, f.bound)).resolves.toMatchObject({
      requestingNodeId: f.requester.workflowNodeId, orchestratorNodeId: f.reviewer.workflowNodeId,
    })
  })
})
