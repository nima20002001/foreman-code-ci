import { beforeEach, expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { HarnessExecution, HarnessNativeEvent } from '@foreman-code/contracts'
import type { AcceptedWorkflowRunV3 } from '@foreman-code/contracts/wave25'
import type { WorkflowNativeCapture } from '../interactions/workflowNativeCapture.js'
import { ExclusiveGraphConnection, assertGraphTransaction, beforeGraphCommit, type GraphTransactionSql } from '../run-graph/connection.js'
import type { RunOwnership } from './ownership.js'
import type { RepeatNativeEvidence } from './repeatNativeRepository.js'
import type { StoredRepeatExecution } from './repeatPostgres.js'
import type { RepeatScope } from './repeatResolution.js'
import { WorkflowNativeProofServices, type WorkflowNativeProofRecord } from './workflowNativeProof.js'
import { persistWorkflowNativeSources } from './workflowNativeSource.js'
import { appendNormalizedNativeEvents } from './nativeEventBatch.js'
import { appendWorkflowNativeGraphEventLocked } from './workflowNativeGraph.js'
vi.mock('../run-graph/publication.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../run-graph/publication.js')>(), currentRunGraphPublication: () => ({
  retainNativeSource: async () => ({ sourceDigest: 'original-proof-digest', sourceId: 'original-proof' }),
}) }))
vi.mock('../run-graph/repeatReceipts.js', () => ({ requireRepeatCanonicalReceiptBeforeCommit: vi.fn(),
  assertRepeatCanonicalReceiptsLocked: vi.fn() }))
vi.mock('./nativeEventBatch.js', () => ({
  appendNormalizedNativeEvents: vi.fn(async (_sql: GraphTransactionSql,
    frames: Parameters<typeof appendNormalizedNativeEvents>[1]) => frames.map(({ event }: { event: HarnessNativeEvent }) => ({
    inserted: true, rejected: false, sequence: String(event.sequence),
  }))),
}))
vi.mock('./workflowNativeGraph.js', () => ({ appendWorkflowNativeGraphEventLocked: vi.fn() }))
vi.mock('./workflowNativeSource.js', async importOriginal => {
  const original = await importOriginal<typeof import('./workflowNativeSource.js')>()
  return { ...original, persistWorkflowNativeSources: vi.fn(original.persistWorkflowNativeSources) }
})
beforeEach(() => vi.clearAllMocks())
function fixture(retained?: 'same' | 'missing' | 'changed' | 'lost') {
  // SQL/native validation ports are isolated here. This exercises actual proof
  // persistence ordering and G1 rollback, not database or physical ownership.
  const events: string[] = []
  let persistedProof: WorkflowNativeProofRecord | undefined
  vi.mocked(persistWorkflowNativeSources).mockImplementation(async (sql, records) => {
    const original = await vi.importActual<typeof import('./workflowNativeSource.js')>('./workflowNativeSource.js')
    const saved = await original.persistWorkflowNativeSources(sql, records)
    persistedProof = saved[0]
    events.push('proof-stored')
    return saved
  })
  const owner = { runId: 'run', assertOwned() {}, readOneShotFence: async () => ({ ownerId: 'owner', fence: '1' }) } as unknown as RunOwnership
  const execution = { id: 'execution', runId: 'run', workflowNodeId: 'node', agentId: 'agent',
    agentConfigurationVersionId: 'configuration', attempt: 1 } as HarnessExecution
  let current = true
  const at = '2026-10-02T00:00:00.000Z'
  const transcript: HarnessNativeEvent = { executionId: execution.id, connectionId: 'original-connection', sequence: 7,
    type: 'native.notification', occurredAt: at, payload: { original: 'complete transcript' } }
  const capture = { execution, owner, source: retained ? { type: 'history', history: { events: [transcript,
    { ...transcript, sequence: 8, type: 'turn.completed', payload: { turnId: 'original-turn' } }], pendingInteractions: [] } }
    : { type: 'event', event: { sequence: 1 } }, session: { harness: 'codex', nativeSessionId: 'session' },
  lifetimeGeneration: 1, closureGeneration: '1', lane: null, observedAt: at,
  assertCurrent() { if (!current) throw new Error('original lifetime lost') } } as WorkflowNativeCapture
  const raw = { query: vi.fn(async (text: string) => {
    if (text.includes('from harness_native_events n join jsonb_to_recordset')) {
      if (retained === 'lost') current = false
      return { rows: retained === 'missing' ? [] : [{ connection_id: transcript.connectionId,
        source_sequence: transcript.sequence, sequence: 31, record_matches: retained !== 'changed',
        source_digest: null, semantic_digest: null }], rowCount: 1 }
    }
    if (text === 'commit' || text === 'rollback') events.push(text)
    return { rows: [], rowCount: text.startsWith('insert') ? 1 : 0 }
  }) } as unknown as pg.ClientBase
  const connection = new ExclusiveGraphConnection(raw, () => owner.assertOwned())
  const callback = vi.fn(async (sql: GraphTransactionSql, _evidence: RepeatNativeEvidence,
    proof: WorkflowNativeProofRecord) => {
    assertGraphTransaction(sql)
    expect(persistedProof).toBeDefined()
    expect(proof).toEqual(persistedProof)
    events.push('context')
    beforeGraphCommit(sql, async () => { events.push('context-before-commit') })
  })
  const service = new WorkflowNativeProofServices({ read: () => capture }, undefined, callback)
  const validation = service as unknown as { current(): Promise<{ stored: StoredRepeatExecution; scope: RepeatScope }>; physical(): Promise<void> }
  vi.spyOn(validation, 'current').mockResolvedValue({ stored: { execution, ref: { nodeId: 'node', occurrence: null }, inputDigest: 'original-input' } as StoredRepeatExecution,
    scope: { workspaceId: 'workspace', workflowId: 'workflow', runId: 'run', workflowVersionId: 'version', executionSemanticsVersion: 3 } })
  vi.spyOn(validation, 'physical').mockResolvedValue(undefined)
  const persist = () => connection.transaction(sql => {
    return service.persistOriginalLocked(sql, { id: 'run' } as AcceptedWorkflowRunV3, {} as RepeatNativeEvidence, owner)
  })
  return { events, persist, transcript }
}
it('retains complete original history while avoiding identical committed transcript replay', async () => {
  const f = fixture('same'); await f.persist()
  const append = vi.mocked(appendWorkflowNativeGraphEventLocked)
  expect(append).toHaveBeenCalledOnce()
  expect(append.mock.calls[0]![2].type).toBe('turn.completed')
  expect(appendNormalizedNativeEvents).not.toHaveBeenCalled()
  expect(f.events).toEqual(['proof-stored', 'context', 'context-before-commit', 'commit'])
})

for (const retained of ['missing', 'changed'] as const) it(`does not skip ${retained} original transcript rows`, async () => {
  const f = fixture(retained); await f.persist()
  const append = vi.mocked(appendWorkflowNativeGraphEventLocked)
  expect(append).toHaveBeenCalledTimes(2)
  expect(append.mock.calls[0]![2]).toEqual(f.transcript)
  expect(vi.mocked(appendNormalizedNativeEvents).mock.calls[0]![1][0]!.event).toEqual(f.transcript)
})

it('rolls back if the original coordinator lifetime changes while reading retained transcript rows', async () => {
  const f = fixture('lost')
  await expect(f.persist()).rejects.toThrow('original lifetime lost')
  expect(appendWorkflowNativeGraphEventLocked).not.toHaveBeenCalled()
  expect(f.events).toEqual(['proof-stored', 'rollback'])
})
