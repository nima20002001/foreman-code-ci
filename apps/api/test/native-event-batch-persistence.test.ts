import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema, type HarnessNativeEvent } from '@foreman-code/contracts'
import type { AcceptedWorkflowRunV3 } from '@foreman-code/contracts/wave25'
import { ExclusiveGraphConnection, beforeGraphCommit } from '../src/modules/run-graph/connection.js'
import * as snapshots from '../src/modules/runs/repeatStartRead.js'
import * as executions from '../src/modules/runs/repeatPostgres.js'
import { workflowNativeReservation } from '../src/modules/runs/workflowNativeEntry.js'
import { repeatDigest } from '../src/modules/runs/repeatResolution.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import { WorkflowNativeProofServices } from '../src/modules/runs/workflowNativeProof.js'
import type { WorkflowNativeProofRecord } from '../src/modules/runs/workflowNativeProof.js'
import { createWorkflowNativeCaptureChannel } from '../src/modules/interactions/workflowNativeCapture.js'
import type { SingleWriterSessionManager, SessionWriteLease } from '../src/modules/interactions/sessionWriter.js'
import { createProductionRemoteWorkflow } from '../src/modules/placement/productionRemoteWorkflow.js'
import { unavailableRuntime } from './eng04-runtime-repository-fixture.js'

afterEach(() => vi.restoreAllMocks())

// A transaction adapter isolates database I/O; the repository, capture channel,
// source persistence, event allocation, and commit guards run unchanged.
function fixture() {
  const at = '2026-10-01T00:00:00.000Z'
  const execution = HarnessExecutionSchema.parse({ id: 'execution', runId: 'run', workflowNodeId: 'node',
    agentId: 'agent', agentConfigurationVersionId: 'configuration', attempt: 1, input: { task: 'stream' },
    state: 'running', nativeSessionId: 'session', createdAt: at, startedAt: at })
  const session = { harness: 'codex' as const, nativeSessionId: 'session', providerVersion: 'fixture' }
  const scope = { workspaceId: 'workspace', workflowId: 'workflow', runId: 'run',
    workflowVersionId: 'version', executionSemanticsVersion: 3 as const }
  const stored = { execution, ref: { nodeId: 'node', occurrence: null },
    inputDigest: repeatDigest(execution.input) } as executions.StoredRepeatExecution
  const run = { id: 'run', workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: 'version' } as AcceptedWorkflowRunV3
  const readSnapshot = vi.spyOn(snapshots, 'readAcceptedRepeatRunLocked').mockResolvedValue({ run } as
    Awaited<ReturnType<typeof snapshots.readAcceptedRepeatRunLocked>>)
  vi.spyOn(executions, 'readRepeatExecutionLocked').mockResolvedValue(stored)
  const reservation = workflowNativeReservation(scope, stored.ref, execution, stored.inputDigest)
  const digest = `sha256:${'a'.repeat(64)}`
  const entry = { phase: 'entered', reservation, reservation_digest: repeatDigest(reservation),
    transition: { phase: 'entered' }, source_id: 'entry', source_digest: digest }
  const receipt = { workspace_id: 'workspace', workflow_id: 'workflow', workflow_version_id: 'version',
    execution_semantics_version: 3, protocol_version: 1, head_sequence: '1', source_digest: digest,
    source_semantic_digest: digest, source_sequence: '1', effect_digest: null,
    effect_semantic_digest: null, effect_sequence: null }
  const lane = { owner_agent_id: 'agent', harness: 'codex', native_session_id: 'session',
    generation: '1', token: 'token', correlation: 'execution:execution', provider_id: 'turn', held: true,
    lease_owner: 'owner', lease_ms: 30_000, expires_at: '2099-01-01T00:00:00.000Z' }
  const state = { proofs: [] as { record: WorkflowNativeProofRecord; source_digest: string; identity_digest: string }[],
    sources: [] as { source_id: string; source_digest: string; semantic_digest: string }[],
    events: [] as { execution_id: string; sequence: number; connection_id: string; source_sequence: number;
      record: HarnessNativeEvent }[], next: '0' }
  let backup = structuredClone(state)
  let statements = 0
  let revokeAtCommit: (() => void) | undefined
  const raw = { query: async (text: string, values: unknown[] = []) => {
    statements++
    let rows: unknown[] = []
    if (text.startsWith('begin')) backup = structuredClone(state)
    else if (text === 'rollback') Object.assign(state, backup)
    else if (text === 'commit') return { rows, rowCount: 0 }
    else if (text.startsWith('with current_entry')) rows = [{ entry, entry_receipts: [receipt],
      session: { reference: session }, configuration: { harness: 'codex' },
      closure: { generation: '1', expected_reference: session, closed: false }, lane }]
    else if (text.startsWith('update native_session_lanes')) rows = [{ expires_at: lane.expires_at }]
    else if (text.includes('from native_session_lanes l join lateral')) rows = [{ connection_id: 'connection',
      connection_generation: 1, native_turn_id: 'turn', native_session_id: 'session', provider: 'codex' }]
    else if (text.includes('from workflow_native_proofs')) rows = state.proofs
      .filter(row => (values[0] as string[]).includes(row.record.proofId))
    else if (text.startsWith('insert into workflow_native_proofs')) {
      const inserts = JSON.parse(String(values[0])) as { record: string; source_digest: string; identity_digest: string }[]
      state.proofs.push(...inserts.map(row => ({ ...row, record: JSON.parse(row.record) as WorkflowNativeProofRecord })))
    } else if (text.startsWith('insert into run_graph_sources')) {
      for (const source of JSON.parse(String(values[1])) as typeof state.sources) {
        if (!state.sources.some(row => row.source_id === source.source_id)) state.sources.push(source)
      }
    } else if (text.includes('as receipts')) {
      rows = (JSON.parse(String(values[0])) as { ordinal: number; source_id: string }[]).map(input => {
        const source = state.sources.find(row => row.source_id === input.source_id)
        return { ordinal: input.ordinal, receipts: source ? [{ ...receipt, source_digest: source.source_digest,
          source_semantic_digest: source.semantic_digest }] : [] }
      })
    } else if (text.includes('from runs r join workflow_versions')) {
      const source = state.sources.find(row => row.source_id === values[2])
      rows = source ? [{ ...receipt, source_digest: source.source_digest,
        source_semantic_digest: source.semantic_digest }] : []
    } else if (text.includes('read_harness_native_event_batch')) {
      const inputs = JSON.parse(String(values[0])) as typeof state.events
      const events = state.events.filter(row => inputs.some(input => input.execution_id === row.execution_id
        && input.connection_id === row.connection_id && input.source_sequence === row.source_sequence))
      rows = [{ allocators: [{ id: 'execution', next_sequence: state.next }], events }]
    } else if (text.startsWith('with proposed as materialized')) {
      state.next = (JSON.parse(String(values[0])) as { next_sequence: string }[])[0]!.next_sequence
      state.events.push(...JSON.parse(String(values[1])) as typeof state.events)
    } else if (!text.includes('run_node_placements') && !text.startsWith('with locked_head')
      && !text.startsWith('select run_id from run_graph_heads')
      && !text.startsWith('select id from harness_executions')) throw new Error(`Unexpected adapter query: ${text}`)
    return { rows: structuredClone(rows), rowCount: rows.length }
  } } as unknown as pg.ClientBase
  const connection = new ExclusiveGraphConnection(raw, () => {})
  const owner = { runId: 'run', assertOwned() {}, readOneShotFence: async () => ({ ownerId: 'owner', fence: '1' }),
    oneShotConnection: () => connection } as unknown as RunOwnership
  const remote = createProductionRemoteWorkflow({} as Parameters<typeof createProductionRemoteWorkflow>[0])
  const channel = createWorkflowNativeCaptureChannel()
  const native = new WorkflowNativeProofServices(channel.verify, async (sql, currentOwner, capture) => {
    await remote.assertPhysical(sql, currentOwner, capture)
    if (revokeAtCommit) {
      const revoke = revokeAtCommit
      revokeAtCommit = undefined
      beforeGraphCommit(sql, async () => revoke())
    }
  })
  const repository = new PostgresRunRepository({} as pg.Pool,
    {} as ConstructorParameters<typeof PostgresRunRepository>[1],
    { revalidateRunAuthorization: async () => {} } as unknown as ConstructorParameters<typeof PostgresRunRepository>[2],
    { ...unavailableRuntime(), native })
  const lease = { fence: { id: 'lane', token: 'token' }, previous: { connectionGeneration: 1 }, providerId: 'turn' } as SessionWriteLease
  const manager = { harness: 'codex', assertCapturedLease() {} } as unknown as SingleWriterSessionManager
  const live = Array.from({ length: 16 }, () => true)
  const frames = live.map((_, sequence) => {
    const event: HarnessNativeEvent = { executionId: 'execution', connectionId: 'connection', sequence,
      type: 'native.notification', occurredAt: at, payload: { nativeMethod: 'item/agentMessage/delta', text: `frame ${sequence}` } }
    const evidence = channel.capture.capture({ owner, execution, session, manager, lease, kind: 'live',
      source: { type: 'event', event }, lifetimeGeneration: 1, closureGeneration: '1',
      assertCurrent() { if (!live[sequence]) throw new Error('capture expired') } })
    return { event, evidence }
  })
  const append = async (batch = frames) => {
    statements = 0
    readSnapshot.mockClear()
    await repository.appendNativeEvents(batch, owner, { ...lease.fence, live: true, providerId: 'turn' })
    return statements
  }
  return { append, frames, state, readSnapshot, expireAtCommit() { revokeAtCommit = () => { live[15] = false } } }
}

it.each([1, 8, 16])('appends %s captured frames within a fixed transaction statement budget', async count => {
  const f = fixture()
  const statements = await f.append(f.frames.slice(0, count))
  expect(f.state.events.map(row => row.record)).toEqual(f.frames.slice(0, count).map(frame => frame.event))
  expect(statements).toBeLessThanOrEqual(20)
  expect(f.readSnapshot).toHaveBeenCalledTimes(1)
})

it('persists a full event batch and its immutable sources with bounded reads and unchanged replay', async () => {
  const single = fixture()
  const first = await single.append(single.frames.slice(0, 1))
  const f = fixture()
  const batch = await f.append()
  expect(f.state.events.map(row => row.record)).toEqual(f.frames.map(frame => frame.event))
  expect(f.state.proofs.map(row => row.record.original)).toEqual(f.frames.map(frame => ({ type: 'event', event: frame.event })))
  expect(f.state.sources).toHaveLength(16)
  expect(f.state.next).toBe('16')
  const saved = structuredClone(f.state)
  await f.append()
  expect(f.state).toEqual(saved)
  expect(batch).toBeLessThanOrEqual(first + 2)
})

it('rolls back every persisted frame if the final capture expires before commit', async () => {
  const f = fixture()
  const before = structuredClone(f.state)
  f.expireAtCommit()
  await expect(f.append()).rejects.toThrow('capture expired')
  expect(f.state).toEqual(before)
})
