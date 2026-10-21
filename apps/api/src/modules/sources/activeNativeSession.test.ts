import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { NativeSessionLane, HarnessExecution } from '@foreman-code/contracts'
import type { DispatchIntent, NativeExecutionPlacement } from '@foreman-code/contracts/node-placement'
import type { SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { readAcceptedPlacement, readDispatchIntent, readNativePlacement } from '../placement/persistence.js'
import { readReconciledDispatchIntent } from '../runs/remote/persistence.js'
import { readNativeExecutionBinding } from '../placement/executionBinding.js'
import { repeatExecutionIdentity } from '../runs/repeatResolution.js'
import { readSourceActiveNativeSession, readSourceCurrentNativeSession, type SourceOwnedNativeSession } from './activeNativeSession.js'
vi.mock('../placement/persistence.js', () => ({ readAcceptedPlacement: vi.fn(), readDispatchIntent: vi.fn(), readNativePlacement: vi.fn() }))
vi.mock('../runs/remote/persistence.js', () => ({ readReconciledDispatchIntent: vi.fn() }))
vi.mock('../placement/executionBinding.js', () => ({ readNativeExecutionBinding: vi.fn() }))
function fixture() {
  const execution: HarnessExecution = { id: 'execution-original', runId: 'run-original', workflowNodeId: 'node-original', agentId: 'agent-original',
    agentConfigurationVersionId: 'configuration-original', attempt: 4, nativeSessionId: 'native-original', input: {}, state: 'running', createdAt: '2026-10-01T00:00:00Z' }
  const capture: SourceOwnedNativeSession = { execution, session: { harness: 'codex', nativeSessionId: 'native-original', providerVersion: 'installed-version' },
    generation: 6, writer: { id: 'lane-original', token: 'private-original-writer-token', connectionGeneration: 2 }, signal: new AbortController().signal, assertCurrent: vi.fn() }
  const record = { receipt: { executionId: execution.id, attemptId: 'attempt-original', materializationId: randomUUID(), placementHash: 'a'.repeat(64),
    binding: { accessMode: 'exclusive-write' } }, sourceBindingHash: 'a'.repeat(64), finalDispatchBindingHash: 'b'.repeat(64), operationId: 'operation-original',
    rootPolicyId: 'policy-original', rootPolicyRevision: '1', reservationId: randomUUID(), state: 'prepared' } as SourceMaterializationRecord
  const intent = { executionId: execution.id, runId: execution.runId, nodeId: execution.workflowNodeId, technicalAttempt: execution.attempt,
    attemptId: record.receipt.attemptId, operationId: record.operationId, bindingHash: 'c'.repeat(64), owner: { grantId: 'grant-original', epoch: '8' } } as DispatchIntent
  vi.mocked(readDispatchIntent).mockResolvedValue(intent); vi.mocked(readReconciledDispatchIntent).mockResolvedValue(intent)
  vi.mocked(readAcceptedPlacement).mockResolvedValue({} as never); vi.mocked(readNativePlacement).mockResolvedValue({} as never)
  const cwdAttestation = { version: 1 as const, materializationId: record.receipt.materializationId, executionId: execution.id,
    attemptId: record.receipt.attemptId, operationId: record.operationId, sourceBindingHash: record.sourceBindingHash, relativeCwd: 'src', canonicalCwd: '/private/tree/src',
    filesystem: { device: '1', inode: '2', mountId: '3' }, directoryIdentityHash: 'f'.repeat(64), accessMode: 'exclusive-write' as const, attestationDigest: 'f'.repeat(64) }
  vi.mocked(readNativeExecutionBinding).mockReturnValue({ bindingHash: record.finalDispatchBindingHash, materialization: record,
    workingTree: { cwdAttestation } } as NativeExecutionPlacement)
  const reservation = { execution: repeatExecutionIdentity(execution), scope: { runId: execution.runId } }
  const entry = { phase: 'entered', reservation, transition: { phase: 'entered', reservation, launchDigest: `sha256:${'d'.repeat(64)}` },
    source_id: 'source-original', source_digest: `sha256:${'e'.repeat(64)}` }
  const lane: NativeSessionLane = { id: capture.writer.id, harness: capture.session.harness, nativeSessionId: capture.session.nativeSessionId,
    ownerAgentId: execution.agentId, revision: 7, connectionGeneration: 2, leaseOwner: 'runner-original', leaseToken: capture.writer.token,
    leaseExpiresAt: '2099-01-01T00:00:00Z', observedAt: '2026-10-01T00:00:00Z', observedStatus: 'busy' }
  const session = { reference: capture.session, finalized: false }, grant = { rowCount: 1 }
  const query = vi.fn(async (text: string) => {
    if (text.includes('harness_executions')) return { rows: [{ record: execution, accepted: false }] }
    if (text.includes('workflow_native_entries')) return { rows: [entry] }
    if (text.includes('execution_native_sessions')) return { rows: [session] }
    if (text.includes('native_session_lanes')) return { rows: [{ id: lane.id, revision: lane.revision, record: lane }] }
    if (text.includes('execution_dispatch_owner_grants')) return { rows: [], ...grant }
    throw new Error(`unexpected SQL: ${text}`)
  })
  return { execution, capture, record, intent, entry, lane, session, grant, query, sql: { query } as unknown as GraphSqlClient }
}
it('allows a running execution before terminal acceptance using its entered placement, live session and grant', async () => {
  const f = fixture(), proof = await readSourceActiveNativeSession(f.sql, f.record, f.capture)
  expect(proof).toMatchObject({ executionId: f.execution.id, runId: f.execution.runId, technicalAttempt: 4, generation: 6,
    nativeSession: f.capture.session, owner: f.intent.owner, entry: { sourceId: f.entry.source_id, launchDigest: f.entry.transition.launchDigest },
    lane: { id: f.lane.id, revision: 7, expiresAt: f.lane.leaseExpiresAt } })
  expect(proof!.lane.tokenHash).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.stringify(proof)).not.toContain(f.capture.writer.token)
  expect(f.capture.assertCurrent).toHaveBeenCalledTimes(2)
})
it.each(['prepared-entry', 'wrong-entry-attempt', 'wrong-launch-reservation', 'different-session', 'finalized-session', 'stale-lane-generation',
  'different-lane-token', 'expired-lane', 'revoked-grant', 'wrong-native-binding'] as const)('rejects %s continuation evidence', async defect => {
  const f = fixture()
  if (defect === 'prepared-entry') f.entry.phase = 'prepared'
  if (defect === 'wrong-entry-attempt') f.entry.reservation.execution.attempt++
  if (defect === 'wrong-launch-reservation') f.entry.transition.reservation = { ...f.entry.reservation, scope: { runId: 'other-run' } }
  if (defect === 'different-session') f.session.reference = { ...f.capture.session, nativeSessionId: 'other-session' }
  if (defect === 'finalized-session') f.session.finalized = true
  if (defect === 'stale-lane-generation') f.lane.connectionGeneration++
  if (defect === 'different-lane-token') f.lane.leaseToken = 'other-writer-token'
  if (defect === 'expired-lane') f.lane.leaseExpiresAt = '2000-01-01T00:00:00Z'
  if (defect === 'revoked-grant') f.grant.rowCount = 0
  if (defect === 'wrong-native-binding') vi.mocked(readNativeExecutionBinding).mockReturnValue({ bindingHash: 'f'.repeat(64), materialization: f.record } as NativeExecutionPlacement)
  expect(await readSourceActiveNativeSession(f.sql, f.record, f.capture)).toBeNull()
})
it('rejects loss of the actual captured owner after SQL readback', async () => {
  const f = fixture()
  vi.mocked(f.capture.assertCurrent).mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('original manager owner ended') })
  await expect(readSourceActiveNativeSession(f.sql, f.record, f.capture)).rejects.toThrow('original manager owner ended')
})
it('allows only initial strict-byte verification after entered permission but before any actual native session allocation', async () => {
  const f = fixture()
  f.query.mockImplementation(async text => {
    if (text.includes('execution_native_sessions')) return { rows: [] }
    throw new Error('Initial byte admission must not reconstruct a native owner from entered permission.')
  })
  expect(await readSourceCurrentNativeSession(f.sql, f.record, [])).toBeNull()
  expect(f.query).toHaveBeenCalledTimes(1)
})
it.each(['missing-capture', 'ambiguous-capture', 'stale-session', 'finalized', 'stale-lane'] as const)('fails closed for an allocated original native session with %s', async defect => {
  const f = fixture(), captures = defect === 'missing-capture' ? [] : defect === 'ambiguous-capture' ? [f.capture, f.capture] : [f.capture]
  if (defect === 'stale-session') f.session.reference = { ...f.capture.session, nativeSessionId: 'other-session' }
  if (defect === 'finalized') f.session.finalized = true
  if (defect === 'stale-lane') f.lane.connectionGeneration++
  await expect(readSourceCurrentNativeSession(f.sql, f.record, captures)).rejects.toMatchObject({ code: 'SOURCE_NATIVE_SESSION_CONFLICT' })
})
