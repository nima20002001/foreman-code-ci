import { expect, it } from 'vitest'
import type pg from 'pg'
import { ExclusiveGraphConnection } from '../run-graph/connection.js'
import type { WorkflowNativeCapture } from '../interactions/workflowNativeCapture.js'
import type { StoredRepeatExecution } from './repeatPostgres.js'
import type { WorkflowNativeProofRecord } from './workflowNativeProof.js'
import { persistWorkflowNativeSources, workflowNativeSourceRecord } from './workflowNativeSource.js'

function fixture(payloadLength: number) {
  const history = { events: [{ sequence: 1, type: 'native.notification', occurredAt: '2026-10-05T00:00:00.000Z',
    payload: { text: 'x'.repeat(payloadLength) } }], pendingInteractions: [] }
  const capture = { session: { harness: 'codex', nativeSessionId: 'session' },
    source: { type: 'history', history }, observedAt: '2026-10-05T00:00:00.000Z', lifetimeGeneration: 1,
    closureGeneration: '1', lane: null } as unknown as WorkflowNativeCapture
  const stored = { execution: { id: 'execution', workflowNodeId: 'node', agentId: 'agent',
    agentConfigurationVersionId: 'configuration', attempt: 1 }, ref: { nodeId: 'node', occurrence: null },
  inputDigest: 'input' } as StoredRepeatExecution
  const record = workflowNativeSourceRecord(capture, stored, { workspaceId: 'workspace', workflowId: 'workflow',
    workflowVersionId: 'version', runId: 'run', executionSemanticsVersion: 3 }, { ownerId: 'owner', fence: '1' })
  const rows: { record: WorkflowNativeProofRecord; source_digest: string; identity_digest: string }[] = []
  let readOnly = false
  // Model PostgreSQL's read-only transaction boundary, including row locks.
  const client = { async query(text: string, values?: unknown[]) {
    if (text.startsWith('begin')) readOnly = text.includes('read only')
    if (readOnly && /\b(insert|update|delete)\b|for share/i.test(text)) {
      throw Object.assign(new Error('Read-only transactions cannot write or lock rows'), { code: '25006' })
    }
    if (typeof values?.[0] === 'string') {
      for (const source of JSON.parse(values[0])) rows.push({ ...source, record: JSON.parse(source.record) })
      return { rows: [] }
    }
    return { rows: values ? rows : [] }
  } } as unknown as pg.ClientBase
  const connection = new ExclusiveGraphConnection(client, () => {})
  return { connection, rows, record }
}

it('retains and replays native history larger than the ordinary graph JSON limit', async () => {
  const { connection, rows, record } = fixture(5 * 1024 * 1024)
  try {
    expect(await connection.transaction(sql => persistWorkflowNativeSources(sql, [record]))).toEqual([record])
    expect(await connection.transaction(sql => persistWorkflowNativeSources(sql, [record]))).toEqual([record])
    expect(rows).toHaveLength(1)
    const changed: WorkflowNativeProofRecord = { ...record,
      original: { type: 'history', history: { events: [], pendingInteractions: [] } } }
    await expect(connection.transaction(sql => persistWorkflowNativeSources(sql, [changed])))
      .rejects.toMatchObject({ code: 'NATIVE_SOURCE_CONFLICT' })
  } finally { await connection.close() }
})

it('replays immutable native sources without requiring a writable transaction', async () => {
  const { connection, rows, record } = fixture(16)
  try {
    await connection.transaction(sql => persistWorkflowNativeSources(sql, [record]))
    expect(await connection.transaction(sql => persistWorkflowNativeSources(sql, [record]), true)).toEqual([record])
    expect(rows).toHaveLength(1)
  } finally { await connection.close() }
})
