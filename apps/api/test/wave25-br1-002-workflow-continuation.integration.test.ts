import { describe, expect, it } from 'vitest'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { graphParity } from './helpers/wave25R1GraphParity.js'

describe.skipIf(!postgresEnabled)('Workflow native callback continuation', () => {
  it('records Worker continuation only after the checkpoint receipt and exact native terminal history', async () => {
    const f = await checkpointRuntimeFixture()
    try {
      await f.engine.start(f.f.run.id)
      const [interaction] = await f.pending()
      if (!interaction) throw new Error('Expected the native approval request')
      const option = interaction.responseOptions.find((item) => item.semantic === 'approve_once')
      if (!option) throw new Error('Expected the saved approve-once option')
      const result = await f.service.respond({ kind: 'user', principal: f.principal }, {
        interactionId: interaction.id, optionId: option.optionId, expectedRevision: interaction.revision,
      })
      expect(result.interaction.deliveryState).toBe('delivered')
      expect(await f.receipts()).toHaveLength(1)
      const resumed = (await f.db.pool.query<{ approval_native_ack_id: string | null;
        approval_native_ack_source: { sourceKind: string; sourceId: string; sourceRevision: string } | null;
        approval_native_ack_record: { acknowledgementId: string; originalProofId: string } | null }>(
        `select approval_native_ack_id,approval_native_ack_source,approval_native_ack_record
         from interaction_graph_resumes where interaction_id=$1`, [interaction.id])).rows[0]
      expect(resumed?.approval_native_ack_id).toMatch(/^native-approval-ack-/)
      expect(resumed?.approval_native_ack_source).toMatchObject({ sourceKind: 'native_event', sourceRevision: '1' })
      expect(resumed?.approval_native_ack_record?.acknowledgementId).toBe(resumed?.approval_native_ack_id)
      expect(resumed?.approval_native_ack_record?.originalProofId).toBe(resumed?.approval_native_ack_source?.sourceId)
      const batches = await f.db.pool.query<{ payload: string | null }>(
        "select payload from run_graph_batches where run_id=$1 and kind='events' order by sequence", [f.f.run.id])
      const facts = batches.rows.flatMap((row) => row.payload
        ? (JSON.parse(row.payload) as { events: { fact: { type: string; interactionId?: string;
          acknowledgementId?: string } }[] }).events.map((event) => event.fact) : [])
      expect(facts.some((fact) => fact.type === 'worker.resumed' && fact.interactionId === interaction.id
        && fact.acknowledgementId === resumed?.approval_native_ack_id)).toBe(true)
      expect(f.provider.counts.responses).toBe(1)
    } finally { await f.close() }
  }, 60000)

  it('keeps snapshot and replay equal while native approval delivery is pending and after continuation', async () => {
    const f = await checkpointRuntimeFixture(1, 1, { acknowledgeStarts: true })
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    try {
      await f.engine.start(f.f.run.id)
      const { compare } = await graphParity(f.db.pool, f.f.scope)
      await compare()
      const [interaction] = await f.pending()
      const option = interaction?.responseOptions.find((item) => item.semantic === 'approve_once')
      if (!interaction || !option) throw new Error('Expected pending approval')
      f.provider.beforeRespond = async () => { entered(); await waiting }
      const response = f.service.respond({ kind: 'user', principal: f.principal }, {
        interactionId: interaction.id, optionId: option.optionId, expectedRevision: interaction.revision,
      })
      await started
      const pending = await compare()
      expect(pending.state.run.pendingInteractionCount).toBeGreaterThan(0)
      expect(pending.state.interactions.some((item) => item.interactionId === interaction.id)).toBe(true)
      release()
      await response
      const resumed = await compare()
      expect(resumed.state.run.pendingInteractionCount).toBe(0)
      expect(resumed.state.interactions.find((item) => item.interactionId === interaction.id)).toBeUndefined()
    } finally { release(); await f.close() }
  }, 60000)
})
