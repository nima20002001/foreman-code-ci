import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { approvalAtomicSetup, decision } from './helpers/approvalAtomic.js'

const setup = approvalAtomicSetup()

describe.skipIf(!postgresEnabled)('approval decisions', { timeout: 60000 }, () => {
  it('concurrent exact decisions produce one effect, one mutation and one replay', async () => {
    const f = await setup(), before = (await f.pool.query('select head_sequence from run_graph_heads where run_id=$1', [f.run.id])).rows[0].head_sequence
    const results = await Promise.all([decision(f), decision(f)])
    expect(results.filter((r) => !r.replayed)).toHaveLength(1)
    expect(results.filter((r) => r.replayed)).toHaveLength(1)
    expect((await f.repository.get(f.interaction.id))?.revision).toBe(f.interaction.revision + 1)
    expect((await f.pool.query("select * from run_graph_effects where run_id=$1 and effect_kind='approval.decide'", [f.run.id])).rowCount).toBe(1)
    expect(BigInt((await f.pool.query('select head_sequence from run_graph_heads where run_id=$1', [f.run.id])).rows[0].head_sequence)).toBe(BigInt(before) + 1n)
    expect((await f.pool.query("select * from management_audit where action='interaction_respond' and principal_id=$1", [f.principal.id])).rowCount).toBe(2)
  })

  it('concurrent conflicting decisions cannot both settle', async () => {
    const f = await setup(), results = await Promise.allSettled([decision(f), decision(f, f.interaction.responseOptions.find((option) => option.semantic === 'reject')!.optionId)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    expect((await f.repository.get(f.interaction.id))?.revision).toBe(f.interaction.revision + 1)
  })

  it('revoked, read-only and stale revisions are denied without mutation', async () => {
    const f = await setup()
    await expect(f.repository.decide({ id: f.interaction.id, optionId: f.interaction.responseOptions.find((option) => option.semantic === 'approve_once')!.optionId, expectedRevision: 7,
      principal: f.principal, nativeResponse: { optionId: f.interaction.responseOptions.find((option) => option.semantic === 'approve_once')!.optionId, semantic: 'approve_once' } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await f.pool.query("update management_principals set grants=$2::jsonb where id=$1", [f.principal.id, JSON.stringify([{ actions: ['interactions:read'], scope: { workspaceIds: [f.run.workspaceId], workflowIds: [f.run.workflowId], runIds: [f.run.id] } }])])
    await expect(decision(f)).rejects.toBeDefined()
    await f.pool.query('update management_principals set revoked_at=clock_timestamp() where id=$1', [f.principal.id])
    await expect(decision(f)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    expect((await f.repository.get(f.interaction.id))?.status).toBe('pending')
  })
})
