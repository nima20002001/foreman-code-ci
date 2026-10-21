import { asRecord } from '../../../shared/records.js'
import type { ReviewNativeCapture } from '../reviewNativeCapture.js'
import { ReviewNativeProofServices, reviewSourceEvents, reviewSourceReadiness } from '../reviewNativeProof.js'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { HarnessExecutionSchema, ReviewJobSchema, type HarnessNativeEvent, type NativeHarnessEvent, type ReviewJob } from '@foreman-code/contracts'
import { type NativeGraphObservation, type NativeGraphProjectionKey } from '@foreman-code/contracts/wave25'
import type pg from 'pg'
import type { WriterFence } from '../coordination.js'
import { transact } from './transaction.js'
import { fail, identity, requireLeaseAtCommit, runFor } from './context.js'
import { appendNormalizedNativeEvent } from '../../runs/nativeEvents.js'
import { nativeDisconnectObservation, normalizeNativeProducerEvent } from '../../run-graph/nativeProducerNormalization.js'
import { appendNativeGraphEvent, claudeNativeGraphObservation, nativeGraphSource } from '../../run-graph/nativeIngestion.js'
import { nativeProjectionId } from '../../run-graph/nativeProjection.js'
import { readNativeGraphCorrelation, type NativeGraphProjectionGuard } from '../../run-graph/records.js'
import { PostgresNativeGraphProjectionWriter } from '../../run-graph/nativeWriter.js'
import { recordReviewObservation } from './nativeEvidence.js'


/** Native terminal evidence needs both the exact provider turn and the
 * dispatcher's post-event pending/settlement observation. An idle echo, outer
 * history correlation or an unrelated turn cannot satisfy this boundary. */
function observationFor(job: ReviewJob, event: HarnessNativeEvent, scope: NativeGraphObservation['scope'],
  work: NativeGraphProjectionKey, generation: string, terminalReady: boolean): NativeGraphObservation | undefined {
  const providerId = job.providerTurnOrMessageId
  if (!providerId || !job.submittedAt) return undefined
  if (job.provider === 'claude') return claudeNativeGraphObservation(scope, work, event, {
    nativeSessionId: job.nativeSessionId, nativeMessageId: providerId, clientCorrelationId: job.correlationId,
    connectionGeneration: generation, terminalReady })
  const payload = event.payload, turn = asRecord(payload.turn), info = asRecord(payload.info)
  const turnId = typeof payload.turnId === 'string' ? payload.turnId : typeof turn.id === 'string' ? turn.id : undefined
  const source = nativeGraphSource(event)
  const base = { scope, work, source,
    sourceStreamId: nativeProjectionId('stream', event.executionId, event.connectionId ?? null),
    sourcePosition: String(event.sequence), connectionGeneration: generation, observedAt: event.occurredAt,
    submissionId: providerId }
  const sessions = [payload.threadId, payload.sessionID, info.sessionID].filter((value) => value !== undefined)
  if (!sessions.length || sessions.some((value) => value !== job.nativeSessionId)) return undefined
  const codexStart = job.provider === 'codex' && ['turn.started', 'turn/started'].includes(event.type) && turnId === providerId
    && (payload.clientCorrelationId === undefined || payload.clientCorrelationId === job.correlationId)
  const codexEnd = job.provider === 'codex' && ['turn.completed', 'turn/completed'].includes(event.type) && turnId === providerId
    && (payload.clientCorrelationId === undefined || payload.clientCorrelationId === job.correlationId)
  if (terminalReady && codexEnd) {
    const status = typeof payload.status === 'string' ? payload.status : turn.status
    if (!['completed', 'failed', 'interrupted'].includes(String(status))) return undefined
    const failed = status !== 'completed' || !!turn.error
    return { ...base, kind: 'terminal', terminal: { outcome: failed ? 'failed' : 'succeeded',
      evidenceKind: 'provider_terminal', evidenceId: source.sourceId, nativeSettled: true } }
  }
  return codexStart ? { ...base, kind: 'submission', state: 'acknowledged' } : undefined
}

/** Called only from the existing reviewer writer lease. It retains the raw
 * native sequence while connecting the same source to graph and review facts. */
export async function appendReviewNativeGraphEvent(pool: pg.Pool, supplied: ReviewJob, input: NativeHarnessEvent,
  writer: WriterFence, originals: ReviewNativeProofServices, nativeCapture: ReviewNativeCapture): Promise<void> {
  return appendReviewNativeGraphHistory(pool, supplied, [input], writer, originals, nativeCapture)
}

export async function appendReviewNativeGraphHistory(pool: pg.Pool, supplied: ReviewJob,
  inputs: readonly NativeHarnessEvent[], writer: WriterFence, originals: ReviewNativeProofServices,
  nativeCapture: ReviewNativeCapture): Promise<void> {
  if (!inputs.length) return
  const runId = await runFor(pool, 'review', supplied.id)
  const executionId = (await pool.query<{ execution_id: string }>(
    'select execution_id from review_jobs where id=$1', [supplied.id])).rows[0]?.execution_id
  if (!executionId) return fail('REVIEW_JOB_CONTEXT_MISSING')
  const normalizedEvents = inputs.map(input => normalizeNativeProducerEvent({ ...input, executionId }))
  await transact(pool, runId, async (publication) => {
    const sql = publication.sql
    const row = (await sql.query<{ record: unknown; execution_id: string; lease_fence: string; lease_expires_at: Date | null;
      live: boolean; generation: string | null; provider_version: string }>(`select record,execution_id,lease_fence::text,lease_expires_at,provider_version,
        coalesce(lease_expires_at>clock_timestamp(),false) as live,
        approval_connection_generation::text as generation from review_jobs where id=$1 for update`, [supplied.id])).rows[0]
    const job = ReviewJobSchema.parse(row?.record)
    if (!row?.live || job.leaseToken !== supplied.leaseToken || job.provider !== supplied.provider
      || job.nativeSessionId !== supplied.nativeSessionId || job.correlationId !== supplied.correlationId) {
      return fail('REVIEW_JOB_LEASE_LOST')
    }
    if (!row.lease_expires_at) return fail('REVIEW_JOB_LEASE_LOST')
    requireLeaseAtCommit(sql, row.lease_expires_at, 'REVIEW_JOB_LEASE_LOST')
    const host = HarnessExecutionSchema.parse((await sql.query<{ record: unknown }>(
      'select record from harness_executions where id=$1 and run_id=$2 for update', [row.execution_id, runId])).rows[0]?.record)
    if (host.id !== executionId) return fail('REVIEW_JOB_IDENTITY_CONFLICT')
    const key: NativeGraphProjectionKey = { execution: identity(host), workKind: 'review', workId: job.id }
    const lane = (await sql.query<{ record: { leaseToken?: string; leaseExpiresAt?: string;
      connectionGeneration: number; correlationId?: string }; harness: string; native_session_id: string; owner_agent_id: string }>(
      'select record,harness,native_session_id,owner_agent_id from native_session_lanes where id=$1 for update', [writer.id])).rows[0]
    if (!lane || lane.record.leaseToken !== writer.token || !lane.record.leaseExpiresAt
      || Date.parse(lane.record.leaseExpiresAt) <= Date.now() || lane.native_session_id !== job.nativeSessionId
      || lane.owner_agent_id !== job.reviewerAgentId || lane.harness !== job.provider
      || lane.record.correlationId !== job.correlationId || row.generation !== String(lane.record.connectionGeneration)) {
      return fail('SESSION_LANE_LEASE_LOST')
    }
    requireLeaseAtCommit(sql, new Date(lane.record.leaseExpiresAt), 'SESSION_LANE_LEASE_LOST')
    const guard: NativeGraphProjectionGuard = { expected: { scope: publication.scope, key,
      ownerId: job.leaseToken!, fence: row.lease_fence, connectionGeneration: row.generation },
    readCurrentLocked: async (transaction) => {
      const currentRow = (await transaction.query<{ record: unknown; execution_id: string; lease_fence: string;
        live: boolean; generation: string | null }>(`select record,execution_id,lease_fence::text,
          coalesce(lease_expires_at>clock_timestamp(),false) as live,
          approval_connection_generation::text as generation from review_jobs where id=$1 for update`, [job.id])).rows[0]
      if (!currentRow) return fail('REVIEW_JOB_LEASE_LOST')
      const currentJob = ReviewJobSchema.parse(currentRow?.record)
      const currentHost = HarnessExecutionSchema.parse((await transaction.query<{ record: unknown }>(
        'select record from harness_executions where id=$1 and run_id=$2 for update', [currentRow.execution_id, runId])).rows[0]?.record)
      const currentLane = (await transaction.query<{ record: { leaseToken?: string; leaseExpiresAt?: string;
        connectionGeneration: number; correlationId?: string }; native_session_id: string; owner_agent_id: string }>(
        'select record,native_session_id,owner_agent_id from native_session_lanes where id=$1 for update', [writer.id])).rows[0]
      const held = currentRow.live && currentJob.leaseToken === supplied.leaseToken
        && currentLane?.record.leaseToken === writer.token && !!currentLane.record.leaseExpiresAt
        && Date.parse(currentLane.record.leaseExpiresAt) > Date.now()
        && currentLane.record.correlationId === currentJob.correlationId
        && currentLane.native_session_id === currentJob.nativeSessionId
        && currentLane.owner_agent_id === currentJob.reviewerAgentId
      return { scope: publication.scope, key: { execution: identity(currentHost), workKind: 'review', workId: currentJob.id },
        ownerId: currentJob.leaseToken ?? 'lost', fence: currentRow.lease_fence,
        connectionGeneration: currentRow.generation ?? '0', ownership: held ? 'held' : 'lost',
        access: held ? 'project' : 'observe' }
    } }
    const original = await originals.persistLocked(publication, job, nativeCapture)
    const sourceEvents = new Set(reviewSourceEvents(original).map(event => canonicalGraphJson(event)))
    const { live, terminalReady } = reviewSourceReadiness(original, job.providerTurnOrMessageId)
    for (const normalized of normalizedEvents) {
      const event = normalized.event
      if (!sourceEvents.has(canonicalGraphJson(event))) {
        return fail('REVIEW_ORIGINAL_SOURCE_CONFLICT')
      }
      const raw = await appendNormalizedNativeEvent(sql, { ...normalized, event })
      if (raw.rejected || !job.submittedAt) continue
      const observation = observationFor(job, event, publication.scope, key, row.generation!, terminalReady)
      const correlation = await readNativeGraphCorrelation(sql, publication.scope, key, job.correlationId)
      // A crash can lose the live callback after submission. Original provider
      // history can establish that same review without submitting another turn.
      if (!correlation && !live && !observation) continue
      if (correlation && (correlation.connectionId !== (event.connectionId ?? null)
        || String(correlation.connectionGeneration) !== row.generation)) continue
      if (!correlation) await new PostgresNativeGraphProjectionWriter().persistCorrelation(sql, publication.scope, null, {
        key, correlationKey: job.correlationId, provider: job.provider, nativeSessionId: job.nativeSessionId,
        connectionId: event.connectionId ?? null, connectionGeneration: lane.record.connectionGeneration,
        nativeTurnId: job.providerTurnOrMessageId ?? null, nativeRequestId: null,
        interactionId: job.interactionId, reviewJobId: job.id, firstNativeSequence: String(event.sequence),
        lastNativeSequence: String(event.sequence), terminalNativeSequence: null, metadataRevision: '0',
      }, guard)
      const transport = nativeDisconnectObservation(publication.scope, key, event, row.generation!)
      await appendNativeGraphEvent(publication, event, [{ guard, correlationKey: job.correlationId,
        ...(transport ? { observation: transport } : {}) }])
      if (observation) await recordReviewObservation(publication, observation, guard, original.proofId)
    }
  })
}
