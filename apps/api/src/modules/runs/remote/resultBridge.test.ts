import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { VerifiedRemoteEvidence, type RemoteCommitFacts, type RemoteResultCommitPort } from './resultBridge.js'
import type { RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import { remoteEntryClosureDigest } from '@foreman-code/contracts/remote-execution-entry-closure-node'
const digest = 'a'.repeat(64)
const mainId = randomUUID(), deviceId = randomUUID()
const connection = { mainId, deviceId, workerInstallationId: randomUUID(), bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 }
const receipt: RemoteOperationReceipt = { schemaVersion: 1, intent: { schemaVersion: 1, protocolVersion: 1, mainId, runId: 'run', nodeId: 'node', executionId: 'execution', occurrenceId: 'occurrence', occurrenceIndex: 0, technicalAttempt: 1, operationId: 'operation', attemptId: 'attempt', bindingHash: digest, inputDigest: `sha256:${digest}`, owner: { grantId: 'grant', epoch: '1' } }, connection, workerIncarnationId: randomUUID(), sequence: 4, phase: 'confirmed_terminal', entryAttempted: true, turnEntryAttempted: true, stopFence: false, controls: [], native: { sessionId: 'session', turnId: 'turn', processIdentityDigest: digest }, terminal: { kind: 'completed', closureEvidenceDigest: digest, resultDigest: digest } }
function fixture() {
  const state = { accepts: 0, retains: 0, rejects: [] as string[] }
  const authority = { intent: receipt.intent, placement: { hostRef: { kind: 'device', mainId, deviceId }, bindingHash: digest, registration: { workerInstallationId: connection.workerInstallationId, keyRevision: 1, authorizationRevision: 1 } }, originalConnection: connection, originalIncarnationId: receipt.workerIncarnationId, grantIsLive: true, lastSequence: 0, lastReceipt: null, terminal: null, native: null } as RemoteCommitFacts
  const port: RemoteResultCommitPort = { transaction: async (_operationId, work) => work({ authority: async () => authority, retain: async value => { expect(value).toBeInstanceOf(VerifiedRemoteEvidence); state.retains++ }, reject: async (_receipt, reason) => { state.rejects.push(reason) }, accept: async value => { state.accepts++; authority.lastSequence = value.receipt.sequence; authority.lastReceipt = value.receipt; authority.terminal = value.receipt.terminal ?? null; authority.native = value.receipt.native ?? null } }) }
  return { state, authority, port }
}
describe('authoritative remote result bridge', () => {
  it('accepts original correlated results and converges lost publication acknowledgments', async () => { const { state, port } = fixture(); expect(await VerifiedRemoteEvidence.commit(receipt, connection, port)).toBe('accepted'); expect(await VerifiedRemoteEvidence.commit(receipt, connection, port)).toBe('duplicate'); expect(state.accepts).toBe(1) })
  it('retains exact authenticated duplicate source provenance without another native publication', async () => {
    const { state, authority, port } = fixture()
    expect(await VerifiedRemoteEvidence.commit(receipt, connection, port)).toBe('accepted')
    expect(await VerifiedRemoteEvidence.commit(receipt, connection, port)).toBe('duplicate')
    expect(state).toMatchObject({ accepts: 1, retains: 1 })
    authority.grantIsLive = false
    expect(await VerifiedRemoteEvidence.commit(receipt, connection, port)).toBe('rejected')
    expect(state.retains).toBe(1)
  })
  it('converges the identical non-terminal durable receipt without another commit', async () => { const { state, port } = fixture(); const running = { ...receipt, phase: 'running' as const, terminal: undefined }; const { terminal: _terminal, ...report } = running; void _terminal; expect(await VerifiedRemoteEvidence.commit(report, connection, port)).toBe('accepted'); expect(await VerifiedRemoteEvidence.commit(report, connection, port)).toBe('duplicate'); expect(state.accepts).toBe(1) })
  it('permits observation over a reconnected authenticated carrier preserving original native evidence', async () => { const { port } = fixture(); expect(await VerifiedRemoteEvidence.commit(receipt, { ...connection, connectionGeneration: 2, bootId: randomUUID() }, port)).toBe('accepted') })
  it.each(['revoked', 'old-owner', 'wrong-worker', 'replacement-native'])('rejects %s without publishing an edge', async kind => {
    const { state, authority, port } = fixture(); let report = structuredClone(receipt); let authenticated = connection
    if (kind === 'revoked') authority.grantIsLive = false
    if (kind === 'old-owner') authority.intent = { ...authority.intent, owner: { grantId: 'renewed', epoch: '2' } }
    if (kind === 'wrong-worker') authenticated = { ...connection, deviceId: randomUUID() }
    if (kind === 'replacement-native') { authority.native = receipt.native!; report = { ...report, native: { ...receipt.native!, turnId: 'replacement' } } }
    expect(await VerifiedRemoteEvidence.commit(report, authenticated, port)).toBe('rejected'); expect(state.accepts).toBe(0); expect(state.rejects).toHaveLength(1)
  })
  it('accepts a main-owner recovery only after explicit original execution reconciliation', async () => { const { authority, port } = fixture(); const recovered = { ...receipt, intent: { ...receipt.intent, owner: { grantId: 'renewed', epoch: '2' } } }; expect(await VerifiedRemoteEvidence.commit(recovered, connection, port)).toBe('rejected'); authority.intent = recovered.intent; expect(await VerifiedRemoteEvidence.commit(recovered, connection, port)).toBe('accepted') })

  it('accepts positive registry closure before session acknowledgment without inventing a native result', async () => {
    const f = fixture()
    const launchId = randomUUID()
    const entryClosure = { intent: receipt.intent, connection, owner: 'execution:execution', initialLaunchId: launchId,
      launches: [{ owner: 'execution:execution', launchId, bootId: connection.bootId,
        lifecycle: 'closed' as const, closureEvidence: 'native_not_started' as const }] }
    const beforeEntry = { ...receipt }
    delete beforeEntry.native
    delete beforeEntry.terminal
    const report: RemoteOperationReceipt = { ...beforeEntry, turnEntryAttempted: false, stopFence: true,
      terminal: { kind: 'cancelled', entryClosure, closureEvidenceDigest: remoteEntryClosureDigest(entryClosure) } }
    expect(await VerifiedRemoteEvidence.commit(report, { ...connection, connectionGeneration: 2 }, f.port)).toBe('accepted')
    expect(f.authority.lastReceipt?.native).toBeUndefined()
    expect(f.authority.lastReceipt?.terminal?.result).toBeUndefined()
    expect(await VerifiedRemoteEvidence.commit(report, connection, f.port)).toBe('duplicate')
    expect(f.state.accepts).toBe(1)
  })

  it.each(['turn-entered', 'result', 'digest'] as const)('rejects %s from sessionless entry closure', async defect => {
    const f = fixture()
    const launchId = randomUUID()
    const entryClosure = { intent: receipt.intent, connection, owner: 'execution:execution', initialLaunchId: launchId,
      launches: [{ owner: 'execution:execution', launchId, bootId: connection.bootId,
        lifecycle: 'closed' as const, closureEvidence: 'native_not_started' as const }] }
    const beforeEntry = { ...receipt }
    delete beforeEntry.native
    delete beforeEntry.terminal
    const report: RemoteOperationReceipt = { ...beforeEntry, turnEntryAttempted: defect === 'turn-entered', stopFence: true,
      terminal: { kind: 'cancelled', entryClosure, closureEvidenceDigest: remoteEntryClosureDigest(entryClosure),
        ...(defect === 'result' ? { result: { outcome: 'succeeded' as const, output: { text: 'invented' } } } : {}) } }
    if (defect === 'digest') report.terminal!.closureEvidenceDigest = 'b'.repeat(64)
    expect(await VerifiedRemoteEvidence.commit(report, connection, f.port)).toBe('rejected')
    expect(f.state.accepts).toBe(0)
    expect(f.state.rejects).toEqual(['invalid_entry_closure'])
  })
})

it('accepts only an extending journaled capacity retry chain on the original process', async () => {
  const f = fixture()
  const { terminal: _terminal, ...running } = receipt
  void _terminal
  const first = { ...running, phase: 'running' as const }
  expect(await VerifiedRemoteEvidence.commit(first, connection, f.port)).toBe('accepted')
  const retry = { ...first, sequence: first.sequence + 1,
    native: { ...first.native!, turnId: 'retry-turn' },
    nativeTurnRetries: [{ previousTurnId: 'turn', turnId: 'retry-turn' }] }
  expect(await VerifiedRemoteEvidence.commit(retry, connection, f.port)).toBe('accepted')
  const next = { ...retry, sequence: retry.sequence + 1, native: { ...retry.native, turnId: 'last-turn' },
    nativeTurnRetries: [...retry.nativeTurnRetries, { previousTurnId: 'retry-turn', turnId: 'last-turn' }] }
  expect(await VerifiedRemoteEvidence.commit(next, connection, f.port)).toBe('accepted')
  expect(await VerifiedRemoteEvidence.commit({ ...next, sequence: next.sequence + 1,
    native: { ...next.native, turnId: 'foreign-turn' } }, connection, f.port)).toBe('rejected')
  expect(f.state.accepts).toBe(3)
})
