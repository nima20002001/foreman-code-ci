import { describe, expect, it } from 'vitest'
import { AcceptedNodePlacementSchema, DispatchIntentSchema, NodePlacementReadbackSchema } from '@foreman-code/contracts/node-placement'
import { directoryIdentityHash, deriveDispatch, freezePlacement, readPlacement } from '../src/modules/placement/binding.js'
import { preparePlacement, type PlacementValidationPort } from '../src/modules/placement/admission.js'

const mainId = '11111111-1111-4111-8111-111111111111'
const deviceId = '22222222-2222-4222-8222-222222222222'
const workerInstallationId = '33333333-3333-4333-8333-333333333333'
const digest = 'a'.repeat(64)
const hostRef = { kind: 'device' as const, mainId, deviceId }
const destination = { canonicalProjectRoot: '/projects/one', canonicalCwd: '/projects/one', managedRuntimeRoot: '/runtime',
  directoryIdentityHash: digest, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1', attestationId: 'attestation', attestationHash: digest }
const payload = { kind: 'agent' as const, agentId: 'agent-a', agentConfigurationVersionId: 'config-1', driverId: 'codex', driverRevision: '1',
  instanceId: 'instance-1', instanceRevision: '1', harnessInstallationId: 'harness-1', installationFingerprint: digest,
  runtimeContractVersion: 1 as const, protocolRevision: '1', credentialScopeRefs: ['scope-1'] }
const source = { revisionId: 'source-1', manifestDigest: digest, materializationId: 'materialized-1', materializationDigest: digest }
const pins = { schemaVersion: 1 as const, mainId, runId: 'run-1', nodeId: 'node-a', hostRef,
  registration: { workerInstallationId, keyRevision: 1, authorizationRevision: 1 }, mainInstallationId: 'main-install-1', destination, payload, source }
const saved = { schemaVersion: 1 as const, hostRef, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1', projectRoot: '/projects/one',
  cwdPolicy: 'project-root' as const, relativeCwd: '', instanceId: 'instance-1', instanceRevision: '1', harnessInstallationId: 'harness-1' }
const registration = { mainId, deviceId, workerInstallationId, publicKeyFingerprint: digest, keyRevision: 1, authorizationRevision: 1,
  status: 'paired' as const, scopes: ['connect' as const] }
function port(overrides: Partial<Awaited<ReturnType<PlacementValidationPort['validate']>>> = {}): PlacementValidationPort {
  return { validate: async () => ({ hostRef, registration, destination, payload, source, ...overrides }) }
}
describe('accepted node placement binding', () => {
  it('copies and deeply freezes every accepted configuration/source/host pin', () => {
    const input = structuredClone(pins)
    const accepted = freezePlacement(input)
    input.destination.canonicalCwd = '/other'
    input.payload.instanceId = 'new-instance'
    input.source.revisionId = 'new-source'
    expect(accepted.destination.canonicalCwd).toBe('/projects/one')
    expect(accepted.payload.kind === 'agent' && accepted.payload.instanceId).toBe('instance-1')
    expect(accepted.source.revisionId).toBe('source-1')
    expect(Object.isFrozen(accepted.payload)).toBe(true)
    expect(readPlacement(accepted)).toEqual(accepted)
  })
  it('rejects mutated pins and host-colliding dev/inode identities', () => {
    const accepted = freezePlacement(pins)
    expect(() => readPlacement({ ...accepted, source: { ...source, revisionId: 'source-edited' } })).toThrow('immutable pins')
    expect(directoryIdentityHash(hostRef, '1', '5')).not.toBe(directoryIdentityHash({ ...hostRef, deviceId: workerInstallationId }, '1', '5'))
  })
  it.each(['/projects/one/../two', '/runtime/project', '/projects/one/\0'])('rejects invalid canonical project root %s', (root) => {
    expect(() => freezePlacement({ ...pins, destination: { ...destination, canonicalProjectRoot: root } })).toThrow()
  })
  it('derives lazy dispatch solely from accepted placement', () => {
    const accepted = freezePlacement(pins)
    const intent = deriveDispatch(accepted, { executionId: 'execution-1', occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1,
      attemptId: 'attempt-1', operationId: 'operation-1', inputDigest: `sha256:${digest}`, owner: { grantId: 'grant-1', epoch: '1' } })
    expect(intent.bindingHash).toBe(accepted.bindingHash)
    expect(intent.nodeId).toBe(accepted.nodeId)
    expect(DispatchIntentSchema.safeParse({ ...intent, protocolVersion: 2 }).success).toBe(false)
  })
  it('fails unknown schema/runtime versions and forged caller binding fields closed', () => {
    const accepted = freezePlacement(pins)
    expect(AcceptedNodePlacementSchema.safeParse({ ...accepted, schemaVersion: 2 }).success).toBe(false)
    expect(AcceptedNodePlacementSchema.safeParse({ ...accepted, payload: { ...payload, runtimeContractVersion: 2 } }).success).toBe(false)
    expect(AcceptedNodePlacementSchema.safeParse({ ...accepted, nativeEntryPermit: {} }).success).toBe(false)
  })
  it('accepted-but-unstarted and legacy history never manufacture observation', () => {
    expect(NodePlacementReadbackSchema.parse({ evidence: 'accepted', placement: freezePlacement(pins), observations: [] }).evidence).toBe('accepted')
    expect(NodePlacementReadbackSchema.parse({ evidence: 'legacy_missing', originalMainInstallationId: null })).toEqual({ evidence: 'legacy_missing', originalMainInstallationId: null })
  })
})
describe('authenticated destination preparation', () => {
  it('pins authenticated host evidence', async () => {
    const accepted = await preparePlacement(port(), saved, { mainId, mainInstallationId: 'main-install-1', runId: 'run-1', nodeId: 'node-a' }, payload, 'read-only')
    expect(accepted).toEqual(freezePlacement(pins))
  })
  it.each([
    { registration: { ...registration, status: 'revoked' as const } },
    { registration: { ...registration, deviceId: workerInstallationId } },
    { destination: { ...destination, locationRevision: '2' } },
    { destination: { ...destination, rootPolicyRevision: '2' } },
    { payload: { ...payload, installationFingerprint: 'changed' } },
    { hostRef: { ...hostRef, deviceId: workerInstallationId } },
  ])('rejects drift/revocation/wrong host evidence %#', async (changed) => {
    await expect(preparePlacement(port(changed), saved, { mainId, mainInstallationId: 'main-install-1', runId: 'run-1', nodeId: 'node-a' }, payload, 'read-only')).rejects.toThrow()
  })
})
