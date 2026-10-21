import { describe, expect, it } from 'vitest'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { graphParity } from './helpers/wave25R1GraphParity.js'

describe.skipIf(!postgresEnabled)('Workflow native callback history', () => {
  it('persists raw history, exact correlation and graph source from the real coordinator callback', async () => {
    const f = await checkpointRuntimeFixture()
    try {
      await f.engine.start(f.f.run.id)
      const raw = await f.db.pool.query<{ execution_id: string; sequence: string }>(
        `select n.execution_id,n.sequence::text from harness_native_events n
         join harness_executions e on e.id=n.execution_id where e.run_id=$1 order by n.execution_id,n.sequence`, [f.f.run.id])
      const correlations = await f.db.pool.query<{ execution_id: string; work_kind: string; native_session_id: string }>(
        'select execution_id,work_kind,native_session_id from run_native_correlations where run_id=$1 order by execution_id', [f.f.run.id])
      const sources = await f.db.pool.query<{ source_id: string; first_sequence: string }>(
        "select source_id,first_sequence::text from run_graph_sources where run_id=$1 and source_kind='native_event' order by source_id", [f.f.run.id])
      expect(raw.rows.length).toBeGreaterThan(0)
      expect(correlations.rows.length).toBeGreaterThan(0)
      expect(correlations.rows.every((row) => row.work_kind === 'workflow')).toBe(true)
      const approvals = await f.db.pool.query<{ interaction_id: string; native_request_id: string;
        native_session_id: string; proof: { session: { nativeSessionId: string };
          original: { type: string; history: { pendingInteractions: { turn: { nativeRequestId: string } }[] } } } }>(
        `select i.id as interaction_id,i.record->>'nativeRequestId' as native_request_id,
           c.native_session_id,p.record as proof from durable_interactions i
         join run_native_correlations c on c.run_id=i.run_id and c.execution_id=i.execution_id
           and c.work_kind='workflow' and c.native_session_id=i.record->>'nativeSessionId'
         join workflow_native_proofs p on p.proof_id=i.approval_native_request_proof_id
           and p.run_id=i.run_id and p.execution_id=i.execution_id
         where i.run_id=$1`, [f.f.run.id])
      expect(approvals.rows.length).toBeGreaterThan(0)
      expect(approvals.rows.every((row) => row.proof.session.nativeSessionId === row.native_session_id
        && row.proof.original.type === 'history'
        && row.proof.original.history.pendingInteractions.some((request) =>
          request.turn.nativeRequestId === row.native_request_id))).toBe(true)
      expect(sources.rows.length).toBeGreaterThan(0)
      const batches = await f.db.pool.query<{ payload: string }>(
        'select payload from run_graph_batches where run_id=$1 and sequence=any($2::bigint[]) and kind=\'events\'',
        [f.f.run.id, sources.rows.map((row) => row.first_sequence)])
      const facts = batches.rows.flatMap((row) => (JSON.parse(row.payload) as { events: { fact: { type: string;
        state?: { lifecycle: string } } }[] }).events.map((event) => event.fact))
      // The initial queued state is uncertain until the provider's explicit
      // submission acknowledgement promotes this exact turn to running.
      expect(facts.some((fact) => fact.type === 'node.state' && fact.state?.lifecycle === 'unknown')).toBe(true)
      expect(facts.some((fact) => fact.type === 'node.state' && fact.state?.lifecycle === 'running')).toBe(true)
    } finally { await f.close() }
  }, 60000)

  it('publishes native acknowledgement as running while fresh snapshots and complete replay agree', async () => {
    const f = await checkpointRuntimeFixture(1, 1, { acknowledgeStarts: true })
    try {
      const { compare } = await graphParity(f.db.pool, f.f.scope)
      await compare()
      await f.engine.start(f.f.run.id)
      await compare()
      const batches = await f.db.pool.query<{ payload: string | null }>(
        "select payload from run_graph_batches where run_id=$1 and kind='events' order by sequence", [f.f.run.id])
      const facts = batches.rows.flatMap((row) => row.payload
        ? (JSON.parse(row.payload) as { events: { fact: { type: string; state?: { lifecycle: string } } }[] })
          .events.map((event) => event.fact) : [])
      expect(facts.some((fact) => fact.type === 'node.state' && fact.state?.lifecycle === 'running')).toBe(true)
    } finally { await f.close() }
  }, 60000)
})
