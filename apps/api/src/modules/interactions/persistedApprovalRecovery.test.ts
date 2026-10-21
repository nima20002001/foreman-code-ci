import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type pg from 'pg'
import { expect, it } from 'vitest'
import { deliveryFixture } from '../../../test/helpers/wave25ApprovalFixture.js'
import { Wave25InteractionDeliveryRepository } from './wave25/delivery.js'
import { responseValueDigest } from './delivery.js'

function persistedApprovalFixture() {
  const { interaction, proof } = deliveryFixture()
  interaction.status = 'delivery_pending'
  interaction.deliveryState = 'uncertain'
  interaction.request = { itemId: 'command-item', turnId: 'turn', threadId: interaction.nativeSessionId,
    command: 'pwd', cwd: '/project' }
  const database = new DatabaseSync(':memory:')
  database.exec(`
    create table run_native_correlations (run_id text, execution_id text, work_kind text, work_id text,
      correlation_key text, provider text, native_session_id text, native_turn_id text,
      native_request_id text, interaction_id text, connection_id text, connection_generation integer);
    create table interaction_delivery_attempts (interaction_id text, approval_connection_generation integer,
      approval_write_started_at text);
    create table harness_native_events (execution_id text, source_sequence integer, connection_id text, record text);
  `)
  database.prepare('insert into run_native_correlations values (?,?,?,?,?,?,?,?,?,?,?,?)').run(
    interaction.runId, interaction.executionId, 'workflow', interaction.executionId, `approval:${interaction.id}`,
    'codex', interaction.nativeSessionId, 'turn', interaction.nativeRequestId, interaction.id, 'connection', 1,
  )
  database.prepare('insert into interaction_delivery_attempts values (?,?,?)')
    .run(interaction.id, 1, interaction.createdAt)
  const requestId = interaction.nativeRequestId
  const events = [
    { type: 'interaction.pending', payload: { nativeRequestId: requestId,
      nativeRequestType: interaction.nativeRequestType, turnId: 'turn' } },
    { type: 'interaction.submitting', payload: { nativeRequestId: requestId, optionId: interaction.selectedOptionId } },
    { type: 'interaction.resolved', payload: { nativeRequestId: requestId,
      submittedOptionId: interaction.selectedOptionId, evidence: 'serverRequest/resolved' } },
    { type: 'item.completed', payload: { threadId: interaction.nativeSessionId, turnId: 'turn', item: {
      id: 'command-item', type: 'commandExecution', status: 'completed', command: 'pwd', cwd: '/project', exitCode: 0,
    } } },
    { type: 'interaction.submitted', payload: { nativeRequestId: requestId, optionId: interaction.selectedOptionId,
      semantic: interaction.selectedSemantic, responseDigest: responseValueDigest(undefined) } },
  ]
  const insert = database.prepare('insert into harness_native_events values (?,?,?,?)')
  events.forEach((event, index) => insert.run(interaction.executionId, index + 1, 'connection',
    JSON.stringify({ ...event, occurredAt: interaction.createdAt })))
  // Execute the repository query so its filtering and joins determine the recovered evidence.
  const pool = { query: async (statement: string, parameters: SQLInputValue[]) => {
    const bindings = Object.fromEntries(parameters.map((value, index) => [`$${index + 1}`, value]))
    const rows = database.prepare(statement).all(bindings).map(row => ({
      ...row, record: typeof row.record === 'string' ? JSON.parse(row.record) as unknown : row.record,
    }))
    return { rows, rowCount: rows.length }
  } } as unknown as pg.Pool
  return { database, pool, interaction, proof }
}

it('recovers persisted approval delivery when resolution precedes the write callback after restart', async () => {
  const f = persistedApprovalFixture()
  try {
    const repository = new Wave25InteractionDeliveryRepository(f.pool)
    await expect(repository.persistedResponseEvidence(f.interaction))
      .resolves.toEqual({ ...f.proof, source: 'provider_history' })
  } finally {
    f.database.close()
  }
})

it.each(['reservation', 'connection', 'write-entry'] as const)(
  'keeps reordered approval delivery uncertain without its matching %s', async missing => {
    const f = persistedApprovalFixture()
    try {
      if (missing === 'reservation') f.database.prepare('delete from harness_native_events where source_sequence=?').run(2)
      if (missing === 'connection') f.database.prepare('update harness_native_events set connection_id=? where source_sequence=?')
        .run('other-connection', 2)
      if (missing === 'write-entry') f.database.exec('update interaction_delivery_attempts set approval_write_started_at=null')
      const repository = new Wave25InteractionDeliveryRepository(f.pool)
      await expect(repository.persistedResponseEvidence(f.interaction)).resolves.toBeUndefined()
    } finally {
      f.database.close()
    }
  },
)
