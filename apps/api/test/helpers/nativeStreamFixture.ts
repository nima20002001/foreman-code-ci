import { randomUUID } from 'node:crypto'
import { HarnessExecutionSchema, type HarnessNativeEvent } from '@foreman-code/contracts'
import { canonicalGraphJson, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import type { currentDatabase } from './eng04CurrentDatabase.js'
import { currentRepositoryFixture } from './wave25CurrentRepository.js'
import { RunOwnership } from '../../src/modules/runs/ownership.js'
import { PostgresRunRepository } from '../../src/modules/runs/postgres.js'
import { PostgresWorkflowRepository } from '../../src/modules/workflows/postgres.js'
import { createWorkflowRepositoryServices } from '../../src/modules/runs/workflowRepositoryServices.js'
import { createWorkflowNativeCaptureChannel } from '../../src/modules/interactions/workflowNativeCapture.js'
import type { SingleWriterSessionManager, SessionWriteLease } from '../../src/modules/interactions/sessionWriter.js'
import { openWorkflowLifecycleLocked } from '../../src/modules/runs/repeatLifecycle.js'
import { canonicalRepeatEffectReceipt } from '../../src/modules/run-graph/repeatEffects.js'
import { graphSourceDigest } from '../../src/modules/run-graph/publication.js'
import type { GraphTransactionSql } from '../../src/modules/run-graph/connection.js'
import { repeatDigest, repeatExecutionIdentity, repeatId, tickSlotId } from '../../src/modules/runs/repeatResolution.js'
import { repeatLaunchClaim } from '../../src/modules/runs/repeatNativeRepository.js'
import { reserveWorkflowNativeEntryLocked, workflowNativeReservation } from '../../src/modules/runs/workflowNativeEntry.js'

export async function nativeStreamFixture(db: Awaited<ReturnType<typeof currentDatabase>>, size: number, live = false, closed = false,
  checkPhysical?: (sql: GraphTransactionSql) => Promise<void>) {
  const base = makeCurrentWorkflowFixture(randomUUID(), 'single')
  base.version.approval = { handler: 'native' }
  base.version.definition.approval = base.version.approval
  base.version.definition.nodes[0]!.interval = { everySeconds: 10 }
  base.version.definition.executionPolicy = { maxParallelism: 1, maxNodeExecutions: 2000 }
  const f = await currentRepositoryFixture({ ...db, databaseUrl: process.env.TEST_DATABASE_URL! }, base)
  const owner = await RunOwnership.acquire(db.pool, f.f.run.id, () => {})
  if (!owner) throw new Error('Fixture Run already has an owner')
  const channel = createWorkflowNativeCaptureChannel()
  const repository = new PostgresRunRepository(db.pool, new PostgresWorkflowRepository(db.pool), f.locations,
    { runtimeRoot: db.directory, ...createWorkflowRepositoryServices(channel.verify, checkPhysical) })
  const scope = f.f.scope
  const { executionId: _id, ...identity } = f.f.identities[0]!
  void _id
  const executions = Array.from({ length: size }, (_, index) => HarnessExecutionSchema.parse({
    ...identity, id: `${scope.runId}-execution-${String(index).padStart(5, '0')}`, runId: scope.runId,
    state: 'queued', createdAt: f.f.createdAt,
    input: { executionSemanticsVersion: 3, runInput: {}, occurrence: null, entry: null,
      predecessors: [], tick: { index: index + 1, everySeconds: 10 } },
  }))
  const session = { harness: 'codex' as const, nativeSessionId: `session-${randomUUID()}`, providerVersion: 'fixture' }
  const execution = executions.at(-1)!
  for (const execution of closed ? executions : live ? [executions.at(-1)!] : []) {
    execution.state = 'running'
    execution.nativeSessionId = session.nativeSessionId
    execution.startedAt = execution.createdAt
    execution.workingDirectory = db.directory
    execution.runtimeDirectory = db.directory
    if (closed) {
      execution.state = 'completed'
      execution.finishedAt = execution.createdAt
      execution.result = { outcome: 'canceled' }
    }
  }
  const laneId = `lane-${randomUUID()}`
  await owner.oneShotConnection().transaction(async sql => {
    await openWorkflowLifecycleLocked(sql, scope.runId)
    const fence = await owner.readOneShotFence(sql)
    for (const item of executions) {
      const inputJson = canonicalGraphJson(item.input)
      const inputDigest = repeatDigest(item.input)
      const index = (item.input as { tick: { index: number } }).tick.index
      const slotId = tickSlotId(scope.runId, item.workflowNodeId!, index)
      await sql.query(`insert into run_repeat_slots(slot_id,run_id,occurrence_id,workflow_node_id,input_json,input_digest,tick_index)
        values($1,$2,null,$3,$4,$5,$6)`, [slotId, scope.runId, item.workflowNodeId, inputJson, inputDigest, index])
      await sql.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record,tick_index)
        values($1,$2,$3,$4,1,$5::jsonb,$6)`,
      [item.id, scope.runId, item.workflowNodeId, item.agentId, JSON.stringify(item), index])
      await sql.query(`insert into run_repeat_executions(execution_id,run_id,slot_id,technical_attempt,identity)
        values($1,$2,$3,1,$4::jsonb)`, [item.id, scope.runId, slotId, JSON.stringify(repeatExecutionIdentity(item))])
      const reservation = workflowNativeReservation(scope, { nodeId: item.workflowNodeId!, occurrence: null }, item, inputDigest)
      await reserveWorkflowNativeEntryLocked(sql, reservation)
      const digest = graphSourceDigest({ inputDigest, id: item.id })
      const receipt = canonicalRepeatEffectReceipt(scope, { kind: 'input.bind', entityId: item.id, digest })
      const semantic = graphSourceDigest({ fixture: item.id })
      await sql.query(`insert into run_repeat_effects(run_id,effect_kind,entity_id,payload_digest,owner_id,owner_fence)
        values($1,'input.bind',$2,$3,$4,$5)`, [scope.runId, item.id, digest, fence.ownerId, fence.fence])
      await sql.query(`insert into run_graph_sources(run_id,source_kind,source_id,source_revision,source_digest,semantic_digest,first_sequence)
        values($1,$2,$3,1,$4,$5,1)`,
      [scope.runId, receipt.evidence.sourceKind, receipt.evidence.sourceId, receipt.sourceDigest, semantic])
      await sql.query(`insert into run_graph_effects(run_id,effect_kind,entity_id,effect_digest,semantic_digest,first_sequence)
        values($1,'input.bind',$2,$3,$4,1)`, [scope.runId, receipt.effect!.entityId, digest, semantic])
      if (!closed && (item !== execution || !live)) continue
      const transition = { reservation, phase: 'entered', ownerId: fence.ownerId, ownerFence: fence.fence, launchDigest: digest }
      const sourceId = `entry-${item.id}`
      const sourceDigest = repeatDigest(transition)
      await sql.query(`update workflow_native_entries set phase='prepared',transition=$2::jsonb,source_id=$3,source_digest=$4
        where execution_id=$1`, [item.id, JSON.stringify({ ...transition, phase: 'prepared' }), sourceId, sourceDigest])
      await sql.query(`update workflow_native_entries set phase='entered',transition=$2::jsonb,source_id=$3,source_digest=$4
        where execution_id=$1`, [item.id, JSON.stringify(transition), sourceId, sourceDigest])
      await sql.query(`insert into run_graph_sources(run_id,source_kind,source_id,source_revision,source_digest,semantic_digest,first_sequence)
        values($1,'execution',$2,1,$3,$4,1)`, [scope.runId, sourceId, sourceDigest, semantic])
      await sql.query(`insert into execution_native_sessions(execution_id,reference) values($1,$2::jsonb)`,
        [item.id, JSON.stringify(session)])
      const pins = { id: item.id, runId: item.runId, workflowNodeId: item.workflowNodeId,
        agentId: item.agentId, agentConfigurationVersionId: item.agentConfigurationVersionId,
        attempt: item.attempt, workingDirectory: item.workingDirectory, runtimeDirectory: item.runtimeDirectory }
      await sql.query(`insert into execution_native_closures(execution_id,execution_identity,expected_reference,closed_reference,closed_at)
        values($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::timestamptz)`,
      [item.id, JSON.stringify(pins), JSON.stringify(session), closed ? JSON.stringify(session) : null,
        closed ? item.finishedAt : null])
      const launchDigest = repeatDigest(repeatLaunchClaim(scope, { nodeId: item.workflowNodeId!, occurrence: null }, item, inputDigest))
      await sql.query(`insert into run_graph_effects(run_id,effect_kind,entity_id,effect_digest,semantic_digest,first_sequence)
        values($1,'execution.launch',$2,$3,$4,1)`, [scope.runId, item.id, launchDigest, semantic])
      await sql.query(`insert into run_graph_sources(run_id,source_kind,source_id,source_revision,source_digest,semantic_digest,first_sequence)
        values($1,'execution',$2,1,$3,$4,1)`, [scope.runId,
        repeatId('repeat-native', scope.runId, 'outside', item.id, 'launch', launchDigest), launchDigest, semantic])
      if (item !== execution || !live) continue
      await sql.query(`insert into native_session_lanes(id,harness,native_session_id,owner_agent_id,record)
        values($1,'codex',$2,$3,$4::jsonb)`, [laneId, session.nativeSessionId, item.agentId, JSON.stringify({
        connectionGeneration: 1, leaseToken: 'token', leaseOwner: 'fixture',
        leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        correlationId: `execution:${item.id}`, currentTurnOrMessageId: 'turn',
      })])
      await sql.query(`insert into run_native_correlations(run_id,execution_id,workflow_node_id,attempt,work_kind,work_id,
        correlation_key,provider,native_session_id,connection_id,connection_generation,native_turn_id,
        first_native_sequence,last_native_sequence,metadata_revision)
        values($1,$2,$3,1,'workflow',$2,$4,'codex',$5,'connection',1,'turn',0,0,0)`,
      [scope.runId, item.id, item.workflowNodeId, `execution:${item.id}`, session.nativeSessionId])

    }
  })
  const generation = live ? (await db.pool.query<{ generation: string }>(
    'select generation::text from execution_native_closures where execution_id=$1', [execution.id])).rows[0]!.generation : null
  const manager = { harness: 'codex', assertCapturedLease() {} } as unknown as SingleWriterSessionManager
  const lease = { fence: { id: laneId, token: 'token' }, previous: { connectionGeneration: 1 }, providerId: 'turn' } as SessionWriteLease
  const capture = (source: Parameters<typeof channel.capture.capture>[0]['source']) => channel.capture.capture({
    owner, execution, session, manager, lease, lifetimeGeneration: 1, closureGeneration: generation,
    kind: 'live', source, assertCurrent() {},
  })
  const event = (sequence: number): HarnessNativeEvent => ({ executionId: execution.id, connectionId: 'connection',
    sequence, type: 'native.notification', occurredAt: execution.createdAt,
    payload: { nativeMethod: 'item/agentMessage/delta', text: `frame ${sequence}` } })
  const read = async () => ({
    executions: (await db.pool.query('select record from harness_executions where run_id=$1 order by id', [scope.runId])).rows,
    events: (await db.pool.query('select record from harness_native_events where execution_id=$1 order by sequence', [execution.id])).rows,
    activities: (await db.pool.query('select kind,payload from run_activity where run_id=$1 order by sequence', [scope.runId])).rows,
  })
  return { ...f, owner, repository, scope, execution, executions, session, lease, capture, event, read }
}
