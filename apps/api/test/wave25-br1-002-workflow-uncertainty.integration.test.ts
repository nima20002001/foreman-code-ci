import { describe, expect, it } from 'vitest'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { graphParity } from './helpers/wave25R1GraphParity.js'

describe.skipIf(!postgresEnabled)('Workflow native callback uncertainty', () => {
  it('publishes an exact transport disconnect as stale without treating it as terminal success', async () => {
    const f = await checkpointRuntimeFixture(1, 1, { acknowledgeStarts: true, disconnectAfterStart: true })
    try {
      const { compare } = await graphParity(f.db.pool, f.f.scope)
      await compare()
      await f.engine.start(f.f.run.id)
      const disconnected = await compare()
      const batches = await f.db.pool.query<{ payload: string | null }>(
        "select payload from run_graph_batches where run_id=$1 and kind='events' order by sequence", [f.f.run.id])
      const facts = batches.rows.flatMap((row) => row.payload
        ? (JSON.parse(row.payload) as { events: { fact: { type: string; activity?: { status: string } } }[] })
          .events.map((event) => event.fact) : [])
      expect(facts.some((fact) => fact.type === 'node.activity' && fact.activity?.status === 'stale')).toBe(true)
      expect((await f.runs.get(f.f.run.id))?.outcome).not.toBe('succeeded')
      expect((await compare()).asOfSequence).toBe(disconnected.asOfSequence)
      const [interaction] = await f.pending()
      const option = interaction?.responseOptions.find((item) => item.semantic === 'approve_once')
      if (!interaction || !option) throw new Error('Expected one pending approval after disconnect')
      await f.service.respond({ kind: 'user', principal: f.principal }, {
        interactionId: interaction.id, optionId: option.optionId, expectedRevision: interaction.revision,
      })
      const afterContinuation = await compare()
      expect(afterContinuation.state.run.outcome).toBe('succeeded')
      expect(afterContinuation.state.nodes.every((node) => node.activity.status !== 'stale')).toBe(true)
    } finally { await f.close() }
  }, 60000)

  it('retains the approval obligation and parity when native delivery is uncertain', async () => {
    const f = await checkpointRuntimeFixture(1, 1, { acknowledgeStarts: true })
    try {
      await f.engine.start(f.f.run.id)
      const { compare } = await graphParity(f.db.pool, f.f.scope)
      await compare()
      const [interaction] = await f.pending()
      const option = interaction?.responseOptions.find((item) => item.semantic === 'approve_once')
      if (!interaction || !option) throw new Error('Expected pending approval')
      f.provider.beforeRespond = async () => { throw new Error('deterministic delivery uncertainty') }
      await f.service.respond({ kind: 'user', principal: f.principal }, {
        interactionId: interaction.id, optionId: option.optionId, expectedRevision: interaction.revision,
      })
      const uncertain = await compare()
      expect(uncertain.state.run.pendingInteractionCount).toBeGreaterThan(0)
      expect(uncertain.state.interactions.some((item) => item.interactionId === interaction.id)).toBe(true)
      expect((await f.db.pool.query<{ approval_native_ack_id: string | null }>(
        'select approval_native_ack_id from interaction_graph_resumes where interaction_id=$1', [interaction.id]))
        .rows[0]?.approval_native_ack_id ?? null).toBeNull()
      expect(await f.receipts()).toHaveLength(0)
    } finally { await f.close() }
  }, 60000)
})
