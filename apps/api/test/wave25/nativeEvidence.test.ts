import { describe, expect, it } from 'vitest'
import { selectNativeGraphEvidence } from '../../src/modules/run-graph/nativeEvidence.js'
import { parseNativeCheckpoint } from '../../src/modules/run-graph/nativeCheckpoint.js'
import { emptyNativeProjection, type ProjectionBinding } from '../../src/modules/run-graph/nativeProjection.js'

const binding: ProjectionBinding = { key: { execution: { workflowNodeId: 'node', executionId: 'exec', agentId: 'agent',
  agentConfigurationVersionId: 'cfg', attempt: 1 }, workKind: 'workflow', workId: 'exec' }, provider: 'codex',
  nativeSessionId: 'session', nativeTurnId: 'turn', connectionGeneration: '1', interactionId: null, closed: false }

describe('bounded structured native evidence', () => {
  it('keeps capacity attempts from closing workflow activity until the retry budget is exhausted', () => {
    const failed = { threadId: 'session', turnId: 'turn', status: 'failed' }
    expect(selectNativeGraphEvidence('turn.completed', { ...failed, willRetry: true })).toEqual({ kind: 'ignored' })
    expect(selectNativeGraphEvidence('turn.completed', failed)).toMatchObject({ kind: 'evidence' })
    expect(selectNativeGraphEvidence('turn.completed', { ...failed, status: 'completed', willRetry: true }))
      .toMatchObject({ kind: 'evidence' })
  })
  it('drops arguments, output, prose, command strings, paths and error bodies instead of truncating JSON', () => {
    const result = selectNativeGraphEvidence('item.started', { threadId: 'session', turnId: 'turn', prose: 'SECRET-PROBE', item: {
      id: 'tool', type: 'commandExecution', status: 'inProgress', arguments: { path: '/private/SECRET-PROBE' }, output: 'SECRET-PROBE',
      command: ['SECRET-PROBE'], error: { message: 'SECRET-PROBE' }, commandActions: [{ type: 'read', path: '/private/SECRET-PROBE' }],
    } })
    expect(result).toEqual({ kind: 'evidence', type: 'item.started', payload: { threadId: 'session', turnId: 'turn', item: {
      id: 'tool', type: 'commandExecution', status: 'inProgress', error: true, commandActions: [{ type: 'read' }],
    } } })
    expect(JSON.stringify(result)).not.toContain('SECRET-PROBE')
  })
  it('ignores routine transport and output without traversing their bodies', () => {
    const hostile: Record<string, unknown> = {}
    Object.defineProperty(hostile, 'item', { get() { throw new Error('Unexpected body traversal') } })
    for (const type of ['ping', 'keepalive', 'connection.open', 'connection.closed', 'message.delta']) {
      expect(selectNativeGraphEvidence(type, hostile)).toEqual({ kind: 'ignored' })
    }
  })
  it('keeps the actual Codex top-level turn identity and terminal status without importing output', () => {
    expect(selectNativeGraphEvidence('turn.started', { threadId: 'session', turnId: 'turn',
      clientCorrelationId: 'execution:exec', privateOutput: 'SECRET-PROBE' })).toEqual({
      kind: 'evidence', type: 'turn.started', payload: { threadId: 'session', turnId: 'turn',
        turn: { id: 'turn', status: 'inProgress' } },
    })
    expect(selectNativeGraphEvidence('turn.completed', { threadId: 'session', turnId: 'turn', status: 'failed',
      privateOutput: 'SECRET-PROBE' })).toEqual({ kind: 'evidence', type: 'turn.completed',
      payload: { threadId: 'session', turnId: 'turn', turn: { id: 'turn', status: 'failed' } } })
  })
  it('rejects oversize complete evidence and an over-capacity actions array, then accepts the next valid event', () => {
    expect(selectNativeGraphEvidence('item.started', { item: { id: 'tool', server: 'x'.repeat(40000) } })).toMatchObject({ kind: 'invalid', code: 'GRAPH_EVIDENCE_TOO_LARGE' })
    expect(selectNativeGraphEvidence('item.started', { item: { commandActions: Array.from({ length: 129 }, () => ({ type: 'read' })) } })).toMatchObject({ kind: 'invalid' })
    expect(selectNativeGraphEvidence('item.started', { item: { id: 'tool', type: 'fileChange', status: 'inProgress' } })).toMatchObject({ kind: 'evidence' })
  })
  it('rejects malformed structured retained values rather than stringifying a partial payload', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    expect(selectNativeGraphEvidence('message.updated', { info: { id: cyclic } })).toMatchObject({ kind: 'invalid' })
    expect(selectNativeGraphEvidence('item.started', { item: { id: 1n } })).toMatchObject({ kind: 'invalid' })
  })
  it('round-trips the bounded checkpoint and rejects unknown fields or invalid decimal positions', () => {
    const initial = emptyNativeProjection(binding)
    expect(parseNativeCheckpoint(initial)).toEqual(initial)
    expect(() => parseNativeCheckpoint({ ...initial, rawNativeRequest: 'SECRET-PROBE' })).toThrow()
    expect(() => parseNativeCheckpoint({ ...initial, lastNativeSequence: '01' })).toThrow()
  })
})
