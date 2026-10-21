import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import { beforeEach, expect, it, vi } from 'vitest'
import type { HarnessExecution } from '@foreman-code/contracts'
import type { AcceptedArtifactPublication } from '../../files/distributed/publication.js'
import type { WorkflowNativeCapture } from '../../interactions/workflowNativeCapture.js'
import { ExclusiveGraphConnection } from '../../run-graph/connection.js'
import type { RunOwnership } from '../ownership.js'
import type { RepeatNativeEvidence } from '../repeatNativeRepository.js'
import { repeatDigest, repeatExecutionIdentity } from '../repeatResolution.js'
import type { WorkflowNativeProofRecord } from '../workflowNativeProof.js'
import { currentInitialPrompt, parseCurrentChoiceResult } from '../currentRouting.js'
import { createProductionWorkflowArtifactResultSource } from './workflowArtifactResultProduction.js'
import { artifactWorkflowReceipt } from './workflowRepair.test-support.js'

const reads = vi.hoisted(() => ({ snapshot: vi.fn(), execution: vi.fn(), dispatch: vi.fn(), intent: vi.fn(),
  receipt: vi.fn(), placement: vi.fn() }))
vi.mock('../repeatStartRead.js', () => ({ readAcceptedRepeatRunLocked: reads.snapshot }))
vi.mock('../repeatPostgres.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../repeatPostgres.js')>(), readRepeatExecutionLocked: reads.execution }))
vi.mock('../../placement/persistence.js', () => ({ readDispatchIntent: reads.dispatch, readAcceptedPlacement: reads.placement }))
vi.mock('./persistence.js', () => ({ readReconciledDispatchIntent: reads.intent }))
vi.mock('../../run-graph/repeatReceipts.js', () => ({ assertRepeatCanonicalReceiptLocked: reads.receipt,
  requireRepeatCanonicalReceiptBeforeCommit: vi.fn() }))
beforeEach(() => vi.resetAllMocks())

function fixture() {
  // Original capture, SQL readers, physical qualification and authority are
  // explicit UNIT ports; this exercises real commit ordering, never DB/native proof.
  const execution = { id: 'execution', runId: 'run', workflowNodeId: 'node', agentId: 'agent',
    agentConfigurationVersionId: 'config', attempt: 1, input: {}, nativeSessionId: 'session', state: 'completed',
    createdAt: '2026-10-02T00:00:00.000Z',
    result: { outcome: 'succeeded', output: { text: 'original terminal' } } } as HarnessExecution
  const proof = { proofId: 'proof', scope: { workspaceId: 'workspace', workflowId: 'workflow', runId: 'run',
    workflowVersionId: 'version', executionSemanticsVersion: 3 }, ref: { nodeId: 'node', occurrence: null },
    execution: repeatExecutionIdentity(execution), inputDigest: repeatDigest(execution.input), commandId: 'execution:execution',
    session: { harness: 'codex', providerVersion: 'unit', nativeSessionId: 'session' },
    original: { type: 'history', history: { correlationId: 'execution:execution', nativeTurnId: 'turn',
      events: [], pendingInteractions: [], terminalTurn: { correlationId: 'execution:execution', providerId: 'turn', result: execution.result } } },
    observedAt: '2026-10-02T00:00:00.000Z', ownerId: 'owner', ownerFence: '1',
    lifetimeGeneration: 1, closureGeneration: '1', lane: { id: 'lane', token: 'token',
      connectionGeneration: 1, providerId: 'turn' } } as WorkflowNativeProofRecord
  const accepted = { attempt: { workspaceId: 'workspace', workflowId: 'workflow', runId: 'run', nodeId: 'node',
    executionId: 'execution', attemptId: 'attempt', placementHash: 'a'.repeat(64) },
    context: { nativeSessionId: 'session', turnId: 'turn' }, transferContext: { mainId: randomUUID(),
      deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
      bootId: randomUUID(), connectionEpoch: randomUUID() } } as AcceptedArtifactPublication
  const remote = artifactWorkflowReceipt(accepted, execution.result!)
  const version = { id: 'version', definition: { nodes: [{ id: 'node', artifactOutputs: { version: 1, outputKeys: ['report'] } }] } }
  const snapshot = { version, stopRequested: false, cleanupPending: false }
  const stored = { execution, ref: proof.ref, inputDigest: proof.inputDigest }
  let durable = { record: structuredClone(proof), source_digest: repeatDigest(proof, 4 * 1024 * 1024) }
  const connection = new ExclusiveGraphConnection({ query: vi.fn(async (text: string) => ({
    rows: [text.includes('from remote_execution_receipts') ? { receipt: remote } : durable], rowCount: 1,
  })) } as unknown as pg.ClientBase, () => {})
  const owner = { runId: 'run', assertOwned() {}, oneShotConnection: () => connection } as unknown as RunOwnership
  const capture = { owner, execution, session: proof.session, source: proof.original,
    assertCurrent: vi.fn() } as unknown as WorkflowNativeCapture
  const evidence = {} as RepeatNativeEvidence
  const physical = { artifactTerminalContext: vi.fn(async () => accepted.transferContext), assertArtifactTerminal: vi.fn(async () => {}),
    assertAdoptedArtifacts: vi.fn(async () => {}) }
  const authority = { resolveWorkflowContext: vi.fn(async () => accepted), authorize: vi.fn(async () => ({ context: accepted.context })) }
  reads.snapshot.mockResolvedValue(snapshot); reads.execution.mockResolvedValue(stored)
  reads.dispatch.mockResolvedValue({ operationId: 'operation' })
  reads.intent.mockResolvedValue(remote.intent)
  const service = createProductionWorkflowArtifactResultSource({ captures: { read: () => capture }, physical,
    authority: authority as unknown as Parameters<typeof createProductionWorkflowArtifactResultSource>[0]['authority'] })
  const retain = () => connection.transaction(sql => service.retainOriginalLocked(sql, evidence, proof))
  return { service, retain, connection, proof, accepted, capture, physical, authority, snapshot, stored,
    evidence, remote, changeProof: () => { durable = { ...durable, record: { ...durable.record, ownerFence: '2' } } } }
}
it('waits for Main validation and physical settlement before retaining an artifact terminal', async () => {
  const f = fixture()
  delete f.remote.terminal
  f.remote.phase = 'running'
  await f.retain()
  expect(f.service.acceptedAfterCommit(f.evidence)).toBeUndefined()
  expect(f.physical.artifactTerminalContext).not.toHaveBeenCalled()
})
it('qualifies only the exact committed original and rechecks it across later awaits', async () => {
  const f = fixture(); await f.retain()
  expect(f.service.acceptedAfterCommit(f.evidence)).toEqual(f.accepted)
  const source = await f.service.source.readVerified(f.accepted)
  expect(source.proof).toEqual(f.proof)
  expect(source.sourceDigest).toBe(repeatDigest(f.proof, 4 * 1024 * 1024))
  f.capture.assertCurrent = () => { throw new Error('original coordinator already closed') }
  await source.assertCurrent()
  expect(f.physical.assertArtifactTerminal).toHaveBeenCalled()
  await f.service.assertAdoptedAfterCommit(f.evidence)
  expect(f.physical.assertAdoptedArtifacts).toHaveBeenCalledOnce()
  f.changeProof()
  await expect(source.assertCurrent()).rejects.toMatchObject({ code: 'WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE' })
})
it('does not expose a retained capture whose proof transaction rolled back', async () => {
  const f = fixture()
  await expect(f.connection.transaction(async sql => {
    await f.service.retainOriginalLocked(sql, f.evidence, f.proof)
    expect(() => f.service.acceptedAfterCommit(f.evidence)).toThrow()
    throw new Error('rollback')
  })).rejects.toThrow('rollback')
  await expect(f.service.source.readVerified(f.accepted)).rejects.toMatchObject({ code: 'WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE' })
  await expect(f.service.assertAdoptedAfterCommit(f.evidence)).rejects.toMatchObject({ code: 'WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE' })
})
it.each(['caller-context', 'stopped', 'physical', 'authority', 'receipt', 'result'] as const)('rejects changed %s original authority', async kind => {
  const f = fixture(); await f.retain()
  if (kind === 'caller-context') f.accepted = { ...f.accepted, context: { ...f.accepted.context, turnId: 'another-turn' } }
  if (kind === 'stopped') f.snapshot.stopRequested = true
  if (kind === 'physical') f.physical.assertArtifactTerminal.mockRejectedValue(new Error('physical unavailable'))
  if (kind === 'authority') f.authority.authorize.mockRejectedValue(new Error('authority revoked'))
  if (kind === 'receipt') reads.receipt.mockRejectedValue(new Error('canonical receipt missing'))
  if (kind === 'result') f.stored.execution = { ...f.stored.execution, result: { outcome: 'succeeded', output: 'replacement' } }
  await expect(f.service.source.readVerified(f.accepted)).rejects.toThrow()
})
it('does not retain ordinary, failed or undeclared observations', async () => {
  const f = fixture(); f.snapshot.version.definition.nodes[0]!.artifactOutputs = undefined as never
  await f.retain()
  expect(f.service.acceptedAfterCommit(f.evidence)).toBeUndefined()
  expect(f.physical.artifactTerminalContext).not.toHaveBeenCalled()
})
it('retains the saved output declaration through launch admission and rejects a changed placement', async () => {
  const f = fixture()
  reads.placement.mockResolvedValue({ payload: { kind: 'agent', artifactOutputs: { version: 1, outputKeys: ['report'] } } })
  await f.connection.transaction(sql => f.service.assertLaunchDeclarationLocked(sql, 'execution', 'run'))
  expect(f.physical.artifactTerminalContext).not.toHaveBeenCalled()
  expect(f.authority.resolveWorkflowContext).not.toHaveBeenCalled()
  reads.placement.mockResolvedValue({ payload: { kind: 'agent', artifactOutputs: { version: 1, outputKeys: ['foreign'] } } })
  await expect(f.connection.transaction(sql => f.service.assertLaunchDeclarationLocked(sql, 'execution', 'run')))
    .rejects.toMatchObject({ code: 'WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE' })
})
it('prompts only the saved keys and original successful publication commands', () => {
  const prompt = currentInitialPrompt({ initialPrompt: 'Produce a report.', artifactOutputs: { version: 1, outputKeys: ['report'] } })!
  expect(prompt).toContain('Produce a report.')
  expect(prompt).toContain('["report"]')
  expect(prompt).toContain('files.publish_transferred_result')
  expect(prompt).toContain('data and artifactOutputs')
  expect(currentInitialPrompt({ artifactOutputs: { version: 1, outputKeys: ['report'] },
    choice: { outcomes: [{ outcome: 'done', target: { kind: 'branch_end' } }] } })).toContain('routing, data, and artifactOutputs')
})
it('routes the complete original artifact choice text using its saved declaration', () => {
  const declaration = { version: 1 as const, outputKeys: ['report'] }
  const choice = { outcomes: [{ outcome: 'done', target: { kind: 'branch_end' as const } }] }
  const result = { outcome: 'succeeded' as const, output: { text: JSON.stringify({ routing: { outcome: 'done' },
    data: null, artifactOutputs: { version: 1, outputs: [{ outputKey: 'report', commandId: randomUUID() }] } }) } }
  const original = structuredClone(result)
  expect(parseCurrentChoiceResult(result, choice, declaration).routing.outcome).toBe('done')
  expect(result).toEqual(original)
  expect(() => parseCurrentChoiceResult(result, choice, { version: 1, outputKeys: ['other'] })).toThrow()
})
