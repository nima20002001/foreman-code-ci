import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { HarnessMcpPlanInput, ManagementPrincipal } from '@foreman-code/contracts/management'
import { HarnessMcpPlanInputSchema } from '@foreman-code/contracts/management'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { HarnessMcpSettingsService } from '../src/modules/harnesses/mcpSettings.js'
import { NativeMcpNotSubmittedError } from '../src/modules/harnesses/nativeMcpDelivery.js'
import { applyMcpEdits, fingerprint, mcpEdits, type NativeMcpAdapter, type NativeMcpSnapshot } from '../src/modules/harnesses/nativeMcpCommon.js'

let admin: pg.Pool, pool: pg.Pool, schema: string, owner: ManagementPrincipal
let commands: PostgresCommandCoordinator, service: HarnessMcpSettingsService
let snapshots: Record<'codex', NativeMcpSnapshot>
let reads = 0, writes = 0, loseAcknowledgement = false, preWriteFailure = false
const cleanup = vi.fn(async () => {})
const endpoint = 'http://127.0.0.1:3000/mcp'
beforeEach(async () => {
  admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL! })
  schema = `pr18_mcp_${randomUUID().replaceAll('-', '')}`
  await createFixtureSchema(admin, schema)
  pool = new pg.Pool({ ...admin.options, max: 4, options: `-c search_path=${schema}` })
  await applyApplicationMigrations(pool)
  owner = (await new PostgresAccessService(pool).issue({ name: 'PR18 owner', audience: 'operator',
    grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })).principal
  reads = 0; writes = 0; loseAcknowledgement = false; preWriteFailure = false; cleanup.mockClear()
  snapshots = Object.fromEntries((['codex'] as const).map((harness) => [harness, {
    harness, revision: fingerprint({}), effective: {}, user: {}, userConfig: {}, file: `/tmp/pr18-${harness}`, version: '1',
  }])) as typeof snapshots
  const adapter = (harness: 'codex'): NativeMcpAdapter => ({
    read: async () => { reads++; return structuredClone(snapshots[harness]) },
    apply: async (snapshot, change, _signal, managed) => {
      if (preWriteFailure) throw new NativeMcpNotSubmittedError(new Error('aborted before native entry'))
      writes++
      const user = applyMcpEdits(snapshot.user, mcpEdits(snapshot, change, managed))
      snapshots[harness] = { ...snapshot, user, effective: structuredClone(user), revision: fingerprint(user),
        }
      if (loseAcknowledgement) throw new Error('response lost after successful native write')
    },
  })
  commands = new PostgresCommandCoordinator(pool)
  service = new HarnessMcpSettingsService(pool, commands, { codex: adapter('codex') }, () => {}, cleanup, endpoint)
}, 30_000)
afterEach(async () => {
  await service?.shutdown(); await pool?.end()
  await (admin ? dropFixtureSchema(admin, schema) : Promise.resolve()); await admin?.end()
})
function managed(harness: 'codex' = 'codex') {
  return { harness, commandId: randomUUID(), preset: 'graphql' as const, installed: true, expectedRevision: snapshots[harness].revision }
}
it('replays a pre-PR generic receipt without native inspection, but conflicts on changed input', async () => {
  const input: HarnessMcpPlanInput = HarnessMcpPlanInputSchema.parse({ harness: 'codex', commandId: randomUUID(),
    expectedRevision: snapshots.codex.revision, change: { kind: 'add', name: 'docs', connection: { transport: 'remote', url: 'https://example.com/mcp' } } })
  // This is the exact pre-PR operation/target/payload shape, using the unchanged real coordinator.
  const original = await commands.execute({ principal: owner, source: 'http', operation: 'harness.mcp.plan', commandId: input.commandId,
    targetKey: 'harness-mcp:codex', payload: input, perform: async () => ({ id: randomUUID(), status: 'pending', marker: 'legacy receipt' }) })
  expect(await service.plan(owner, 'http', input)).toEqual({ ...original, replayed: true })
  expect(reads).toBe(0); expect(writes).toBe(0)
  await expect(service.plan(owner, 'http', { ...input, expectedRevision: fingerprint('changed') })).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
})
it('retains one accepted plan and command after a busy decision', async () => {
  const blocker = await pool.connect()
  const input = managed()
  let id: string
  try {
    await blocker.query("select pg_advisory_lock(hashtext('graphql:harness-mcp-settings'))")
    const accepted = await service.applyManaged(owner, input)
    expect(accepted.status).toBe('pending'); id = accepted.id
    expect(writes).toBe(0)
  } finally { await blocker.query("select pg_advisory_unlock(hashtext('graphql:harness-mcp-settings'))"); blocker.release() }
  expect(await service.applyManaged(owner, input)).toMatchObject({ id, status: 'applied' })
  expect((await pool.query('select id from harness_mcp_change_plans')).rowCount).toBe(1)
  expect((await pool.query("select command_id from management_command_receipts where operation='harness.mcp.managed.plan'")).rows).toEqual([{ command_id: input.commandId }])
  expect(writes).toBe(1)
})
it('reconciles a lost acknowledgement without a second write and unblocks a different managed preset', async () => {
  const firstInput = managed()
  loseAcknowledgement = true
  const first = await service.applyManaged(owner, firstInput)
  expect(first.status).toBe('uncertain'); expect(writes).toBe(1)
  loseAcknowledgement = false
  const secondInput = { ...managed(), preset: 'linear' as const }
  expect((await service.applyManaged(owner, secondInput)).status).toBe('pending')
  expect(writes).toBe(1)
  const reconcile = { planId: first.id, commandId: randomUUID(), expectedRevision: snapshots.codex.revision, acceptObservedState: false }
  expect((await service.reconcile(owner, reconcile)).value.status).toBe('applied')
  expect((await service.reconcile(owner, reconcile)).replayed).toBe(true)
  expect(writes).toBe(1); expect(cleanup).toHaveBeenCalledTimes(1)
  expect((await service.applyManaged(owner, firstInput)).status).toBe('applied'); expect(writes).toBe(1)
  expect((await service.applyManaged(owner, secondInput)).status).toBe('applied'); expect(writes).toBe(2)
  const audit = await pool.query("select details from management_audit where action='harness.mcp.reconciliation_recorded'")
  expect(audit.rows[0]?.details).toMatchObject({ planId: first.id, matchesExpected: true, nativeWriteRepeated: false })
  // The original harness can now make a different, fresh change too.
  expect((await service.applyManaged(owner, { ...managed(), installed: false })).status).toBe('applied')
})
it('never calls the native adapter after a definite pre-write abort and does not globally block writes', async () => {
  preWriteFailure = true
  const input = managed()
  expect((await service.applyManaged(owner, input)).status).toBe('pending')
  expect(writes).toBe(0)
  preWriteFailure = false
  expect((await service.applyManaged(owner, input)).status).toBe('applied')
  expect((await service.applyManaged(owner, { ...managed(), preset: 'linear' })).status).toBe('applied')
  expect(writes).toBe(2)
})
it('requires explicit acceptance for a divergent inspected state and never calls it a confirmed write', async () => {
  loseAcknowledgement = true
  const plan = await service.applyManaged(owner, managed())
  snapshots.codex = { ...snapshots.codex, user: {}, effective: {}, revision: fingerprint('external removal') }
  const input = { planId: plan.id, commandId: randomUUID(), expectedRevision: snapshots.codex.revision, acceptObservedState: false }
  await expect(service.reconcile(owner, input)).rejects.toMatchObject({ code: 'MCP_RECONCILIATION_MISMATCH' })
  expect((await service.get(owner, plan.id)).status).toBe('uncertain')
  const settled = await service.reconcile(owner, { ...input, commandId: randomUUID(), acceptObservedState: true })
  expect(settled.value.status).toBe('reconciled'); expect(writes).toBe(1)
})
it('refuses stale inspection, failed process cleanup and revoked reconciliation', async () => {
  loseAcknowledgement = true
  const plan = await service.applyManaged(owner, managed())
  const input = { planId: plan.id, commandId: randomUUID(), expectedRevision: fingerprint('stale'), acceptObservedState: false }
  await expect(service.reconcile(owner, input)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  cleanup.mockRejectedValueOnce(new Error('native process termination unconfirmed'))
  await expect(service.reconcile(owner, { ...input, expectedRevision: snapshots.codex.revision })).rejects.toThrow('termination unconfirmed')
  await pool.query('update management_principals set revoked_at=now() where id=$1', [owner.id])
  await expect(service.reconcile(owner, { ...input, expectedRevision: snapshots.codex.revision })).rejects.toMatchObject({ code: 'PRINCIPAL_REVOKED' })
  await pool.query('update management_principals set revoked_at=null where id=$1', [owner.id])
  expect((await pool.query('select status from harness_mcp_change_plans where id=$1', [plan.id])).rows[0]?.status).toBe('uncertain')
  expect(writes).toBe(1)
})
