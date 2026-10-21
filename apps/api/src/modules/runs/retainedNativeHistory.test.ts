import { expect, it } from 'vitest'
import type pg from 'pg'
import type { HarnessNativeEvent } from '@foreman-code/contracts'
import type { WorkflowNativeCapture } from '../interactions/workflowNativeCapture.js'
import { beforeGraphCommit, ExclusiveGraphConnection } from '../run-graph/connection.js'
import { graphSourceDigest } from '../run-graph/publication.js'
import { retainedNativeHistoryEvents } from './retainedNativeHistory.js'
import type { RepeatScope } from './repeatResolution.js'

function fixture(harness: 'codex' | 'claude' = 'codex', type = 'message.submitted') {
  const scope: RepeatScope = { workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: 'version',
    runId: 'run', executionSemanticsVersion: 3 }
  const event: HarnessNativeEvent = { executionId: 'execution', connectionId: 'connection', sequence: 7,
    type: harness === 'claude' ? type : 'turn.started', occurredAt: '2026-10-05T00:00:00.000Z',
    payload: harness === 'claude' ? { nativeSessionId: 'session', nativeMessageId: 'turn',
      clientCorrelationId: 'execution:execution', result: { outcome: 'succeeded', output: 'done' } }
      : { threadId: 'session', turn: { id: 'turn', status: 'inProgress' } } }
  const sourceDigest = graphSourceDigest(event)
  const semanticDigest = graphSourceDigest({ facts: [] })
  const state = { missing: false, changed: false, published: true, wrongDigest: false,
    sessionId: 'session', current: true, projectionRevision: '0' }
  const capture = { execution: { id: 'execution', workflowNodeId: 'node', agentId: 'agent',
    agentConfigurationVersionId: 'configuration', attempt: 1 },
  session: { harness, nativeSessionId: 'session' },
  lane: { connectionGeneration: 1, providerId: 'turn' },
  assertCurrent() { if (!state.current) throw new Error('native lifetime changed') } } as WorkflowNativeCapture
  const client = { async query(_text: string, values?: unknown[]) {
    if (!values) return { rows: [], rowCount: 0 }
    if (values[0] === 'execution' && values.length === 3) return { rows: state.missing ? [] : [{
      connection_id: event.connectionId, source_sequence: event.sequence, sequence: 31,
      record_matches: !state.changed,
      record: { ...event, sequence: 31, payload: state.changed ? { different: true } : event.payload },
      source_digest: state.published ? sourceDigest : null, semantic_digest: state.published ? semanticDigest : null,
    }], rowCount: state.missing ? 0 : 1 }
    if (values[0] === 'execution') return { rows: [{}], rowCount: 1 }
    if (values[1] === 'execution') return { rows: [{ provider: harness, native_session_id: state.sessionId,
      connection_id: 'connection', connection_generation: 1, native_turn_id: 'turn',
      native_request_id: null, interaction_id: null, review_job_id: null, first_native_sequence: '1',
      last_native_sequence: '10', terminal_native_sequence: null, metadata_revision: state.projectionRevision }], rowCount: 1 }
    return { rows: [{ workspace_id: 'workspace', workflow_id: 'workflow', workflow_version_id: 'version',
      execution_semantics_version: 3, protocol_version: 1, head_sequence: '12', source_sequence: '4',
      source_digest: state.wrongDigest ? graphSourceDigest('different') : sourceDigest,
      source_semantic_digest: semanticDigest, effect_digest: null, effect_semantic_digest: null, effect_sequence: null }], rowCount: 1 }
  } } as unknown as pg.ClientBase
  const connection = new ExclusiveGraphConnection(client, () => {})
  const read = (beforeCommit?: () => Promise<void>) => connection.transaction(async sql => {
    if (beforeCommit) beforeGraphCommit(sql, beforeCommit)
    return retainedNativeHistoryEvents(sql, scope, [event], capture)
  })
  return { state, event, read, close: () => connection.close() }
}

it('recognizes a byte-identical semantic frame only with its committed receipt and current binding', async () => {
  const f = fixture()
  try { expect(await f.read()).toEqual(new Set([f.event])) } finally { await f.close() }
})

for (const field of ['missing', 'changed'] as const) it(`retains no ${field} raw frame by assumption`, async () => {
  const f = fixture()
  f.state[field] = true
  try { expect(await f.read()).toEqual(new Set()) } finally { await f.close() }
})

it('requires normal ingestion when the semantic receipt has not been published', async () => {
  const f = fixture()
  f.state.published = false
  try { expect(await f.read()).toEqual(new Set()) } finally { await f.close() }
})

it('requires normal ingestion for a different current native session', async () => {
  const f = fixture()
  f.state.sessionId = 'replacement'
  try { expect(await f.read()).toEqual(new Set()) } finally { await f.close() }
})

it('rejects a changed canonical source digest before commit', async () => {
  const f = fixture()
  try {
    await expect(f.read(async () => { f.state.wrongDigest = true })).rejects.toMatchObject({ code: 'REPEAT_PUBLICATION_RECEIPT_CONFLICT' })
  } finally { await f.close() }
})

it('rejects a native binding change before commit', async () => {
  const f = fixture()
  try {
    await expect(f.read(async () => { f.state.sessionId = 'replacement' })).rejects.toMatchObject({ code: 'NATIVE_SOURCE_IDENTITY_CONFLICT' })
  } finally { await f.close() }
})

it('permits projection progress within the same immutable native binding', async () => {
  const f = fixture()
  try {
    expect(await f.read(async () => { f.state.projectionRevision = '1' })).toEqual(new Set([f.event]))
  } finally { await f.close() }
})

it('rejects a lost native lifetime before commit', async () => {
  const f = fixture()
  try {
    await expect(f.read(async () => { f.state.current = false })).rejects.toThrow('native lifetime changed')
  } finally { await f.close() }
})

for (const type of ['message.submitted', 'turn.completed', 'claude.result']) {
  it(`replays a retained Claude ${type} frame through its public history reader`, async () => {
    const f = fixture('claude', type)
    if (type === 'claude.result') f.state.published = false
    try { expect(await f.read()).toEqual(new Set([f.event])) } finally { await f.close() }
  })
}

it('requires ingestion when a retained Claude message belongs to another native binding', async () => {
  const f = fixture('claude')
  f.state.sessionId = 'replacement'
  try { expect(await f.read()).toEqual(new Set()) } finally { await f.close() }
})
