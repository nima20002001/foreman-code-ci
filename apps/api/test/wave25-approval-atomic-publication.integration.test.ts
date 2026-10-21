import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { approvalAtomicSetup } from './helpers/approvalAtomic.js'
import { readContext } from '../src/modules/interactions/wave25/context.js'
import { transact } from '../src/modules/interactions/wave25/transaction.js'
import { interactionFact, nextInteraction, writeInteraction } from '../src/modules/interactions/wave25/publication.js'
import { graphSourceDigest } from '../src/modules/run-graph/publication.js'

const setup = approvalAtomicSetup()

describe.skipIf(!postgresEnabled)('approval publication transactions', { timeout: 60000 }, () => {
  it('a rollback removes both the domain write and the publication', async () => {
    const f = await setup(), before = (await f.pool.query('select head_sequence from run_graph_heads where run_id=$1', [f.run.id])).rows[0].head_sequence
    await expect(transact(f.pool, f.run.id, async (publication) => {
      const next = nextInteraction(f.interaction, { graphInterruptId: 'fault-injected-interrupt' })
      const context = await readContext(publication.sql, f.interaction)
      await publication.source({ evidence: { sourceKind: 'interaction', sourceId: next.id, sourceRevision: String(next.revision) },
        sourceDigest: graphSourceDigest(next), facts: [interactionFact(context, next)] }, (sql) => writeInteraction(sql, f.interaction, next))
      throw new Error('rollback-fault')
    })).rejects.toThrow('rollback-fault')
    expect((await f.repository.get(f.interaction.id))?.graphInterruptId).toBe(f.interaction.graphInterruptId)
    expect((await f.pool.query('select head_sequence from run_graph_heads where run_id=$1', [f.run.id])).rows[0].head_sequence).toBe(before)
  })

  it('raw writers cannot commit without the same-transaction G1 receipt', async () => {
    const f = await setup()
    await expect(f.pool.query(`update durable_interactions set revision=revision+1,
      record=jsonb_set(record,'{revision}',to_jsonb(revision+1)) where id=$1`, [f.interaction.id])).rejects.toMatchObject({ code: 'PGA03' })
    await expect(f.pool.query('update durable_interactions set revision=revision+1 where id=$1',
      [f.interaction.id])).rejects.toMatchObject({ code: 'PGA03' })
    expect((await f.repository.get(f.interaction.id))?.revision).toBe(f.interaction.revision)
  })
})
