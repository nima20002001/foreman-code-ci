import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { ExclusiveGraphConnection } from '../run-graph/connection.js'
import type { RunOwnership } from '../runs/ownership.js'
import { readExecutionPlacement } from '../placement/persistence.js'
import { recoveryExecution, recoveryIdentity } from '../../../test/helpers/eng06Recovery.testSupport.js'
import { readRemoteWorkflowContinuation, readWorkflowClosure } from './workflowClosure.js'

vi.mock('../placement/persistence.js', () => ({ readExecutionPlacement: vi.fn() }))

function fixture(detached: boolean, executionState: 'running' | 'waiting' = 'waiting') {
  const execution = recoveryExecution(executionState)
  const session = { harness: 'codex' as const, providerVersion: '1.0.0',
    nativeSessionId: execution.nativeSessionId! }
  const digest = 'a'.repeat(64)
  const mainId = randomUUID()
  const receipt = RemoteOperationReceiptSchema.parse({ schemaVersion: 1,
    intent: { schemaVersion: 1, protocolVersion: 1, mainId, runId: execution.runId,
      nodeId: execution.workflowNodeId, executionId: execution.id, occurrenceId: null,
      occurrenceIndex: 0, technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation',
      bindingHash: digest, inputDigest: `sha256:${digest}`, owner: { grantId: 'grant', epoch: '1' } },
    connection: { mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(),
      bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 },
    workerIncarnationId: randomUUID(), sequence: 1, phase: 'running', entryAttempted: true,
    turnEntryAttempted: true, stopFence: false, controls: [],
    native: { sessionId: session.nativeSessionId, turnId: 'original-turn', processIdentityDigest: digest },
  })
  vi.mocked(readExecutionPlacement).mockResolvedValue({ hostRef: { kind: 'device' },
    payload: { kind: 'agent', driverId: session.harness }, bindingHash: digest } as
    NonNullable<Awaited<ReturnType<typeof readExecutionPlacement>>>)
  const state = { principal: true, lifetime: { generation: '1', execution_identity: recoveryIdentity(execution),
    expected_reference: session, closed_reference: null, closed: false, detached,
    detached_reference: detached ? session : null, prior_unclosed: false, closed_without_session: false } }
  const result = (rows: unknown[]) => ({ rows, rowCount: rows.length })
  const raw = { async query(statement: string) {
    const text = statement.replace(/\s+/g, ' ').trim()
    if (text.startsWith('begin') || text === 'commit' || text === 'rollback') return result([])
    if (text.startsWith('select e.record,s.reference,r.receipt')) {
      return result([{ record: execution, reference: session, receipt }])
    }
    if (text.startsWith('select generation::text')) return result([state.lifetime])
    if (text.startsWith('select b.principal_id')) return result(state.principal ? [{ principal_id: 'original-principal' }] : [])
    if (text.includes('join lateral (select * from execution_native_closures')) {
      return result([{ ...state.lifetime, record: execution, reference: session }])
    }
    if (text.includes('from execution_native_recoveries p')) return result([])
    throw new Error('Unexpected continuation query')
  } } as unknown as pg.ClientBase
  const connection = new ExclusiveGraphConnection(raw, () => undefined)
  const owner = { runId: execution.runId, assertOwned() {}, oneShotConnection: () => connection } as RunOwnership
  return { execution, session, receipt, state, connection, owner }
}

describe('original remote workflow continuation', () => {
  it('keeps a detached Worker session available for reattachment without treating it as closed', async () => {
    const f = fixture(true)
    try {
      expect(await readWorkflowClosure(f.connection, f.execution)).toBeUndefined()
      expect(await readRemoteWorkflowContinuation(f.owner, f.execution)).toMatchObject({
        session: f.session, generation: '1', principalId: 'original-principal', detached: true,
      })
      expect(f.state.lifetime.closed).toBe(false)
      expect(f.state.lifetime.detached).toBe(true)
    } finally {
      await f.connection.close()
    }
  })

  it.each([
    { state: 'running' as const, detached: false },
    { state: 'running' as const, detached: true },
    { state: 'waiting' as const, detached: false },
    { state: 'waiting' as const, detached: true },
  ])('keeps the original session, principal and generation when $state with detached=$detached', async ({ state, detached }) => {
    const f = fixture(detached, state)
    try {
      expect(await readRemoteWorkflowContinuation(f.owner, f.execution)).toEqual({
        session: f.session, generation: '1', principalId: 'original-principal', detached,
      })
      expect(f.state.lifetime.detached).toBe(detached)
    } finally { await f.connection.close() }
  })

  it.each(['closed', 'prior_unclosed', 'closed_without_session'] as const)(
    'does not recover a %s lifetime', async field => {
      const f = fixture(true)
      f.state.lifetime[field] = true
      try {
        expect(await readRemoteWorkflowContinuation(f.owner, f.execution)).toBeUndefined()
      } finally { await f.connection.close() }
    },
  )

  it('rejects a detached reference belonging to another session', async () => {
    const f = fixture(true)
    f.state.lifetime.detached_reference = { ...f.session, nativeSessionId: 'replacement-session' }
    try {
      await expect(readRemoteWorkflowContinuation(f.owner, f.execution))
        .rejects.toMatchObject({ code: 'NATIVE_WORKFLOW_CLOSURE_CONFLICT' })
    } finally { await f.connection.close() }
  })

  it('does not recover without the original live process principal', async () => {
    const f = fixture(true)
    f.state.principal = false
    try {
      expect(await readRemoteWorkflowContinuation(f.owner, f.execution)).toBeUndefined()
    } finally { await f.connection.close() }
  })
})
