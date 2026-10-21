import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateManifest, validateEvidence } from './distributed-board-acceptance.mjs'
const manifest = { formatVersion: 1, topology: 'production-two-host', mainId: 'main', runId: 'run', mainEndpoint: 'http://127.0.0.1:4000',
  diagnosticPath: '/api/diagnostics/distributed-run', credentialReference: 'W08_DIAGNOSTIC_TOKEN', hosts: [
    { machineId: 'pc', hostname: 'pc', endpoint: 'https://pc.example', allowedRoot: '/project' },
    { machineId: 'laptop', hostname: 'laptop', endpoint: 'https://laptop.example', allowedRoot: '/project' } ],
  approvals: { 'happy-path': { mainId: 'main', runId: 'run', approvedBy: 'human', operationIds: ['a','b'], hostIds: ['pc','laptop'],
    from: '2026-10-01T00:00:00Z', until: '2026-10-01T02:00:00Z' } } }
test('requires actual two-host approved topology', () => {
  assert.doesNotThrow(() => validateManifest(manifest, 'happy-path', Date.parse('2026-10-01T01:00:00Z')))
  const local = structuredClone(manifest); local.hosts[1].endpoint = 'http://localhost:5000'
  assert.throws(() => validateManifest(local, 'happy-path', Date.parse('2026-10-01T01:00:00Z')), /non-loopback/)
  assert.throws(() => validateManifest(manifest, 'all'), /named case/)
  assert.throws(() => validateManifest(manifest, 'worker-sleep'), /approval window/)
})
test('connection or caller-supplied synthetic proof is not acceptance', () => {
  assert.throws(() => validateEvidence({ synthetic: true }, manifest, 'happy-path'), /immutable production/)
  assert.throws(() => validateEvidence({ connected: true }, manifest, 'happy-path'), /immutable production/)
})
const digest = 'a'.repeat(64)
function evidence() {
  return { mainId: 'main', runId: 'run', productionBinding: true, commit: 'exact-commit', lockfileDigest: digest, runtimeVersion: '22', protocolVersion: 1,
    acceptedSnapshotHash: digest, finalSnapshotHash: digest, freshNonce: 'fresh-nonce', nodes: manifest.hosts.map((h,i) => ({
      executionId: `execution-${i}`, machineId: h.machineId, hostname: h.hostname, bootId: `boot-${i}`, workerIncarnationId: `incarnation-${i}`,
      bindingHash: digest, finalBindingHash: digest, operationId: i ? 'b' : 'a', attemptId: `attempt-${i}`, ownerGrantId: `grant-${i}`, ownerEpoch: '1',
      pid: 10+i, ppid: 1, processStartedAt: '2026-10-01T01:00:00Z', cwd: '/project', sessionId: `session-${i}`, turnId: `turn-${i}`, ackSequence: [1,2,3], outputDigest: digest, inputDigest: digest })),
    edge: { payloadDigest: digest, revisionId: 'edge-revision', artifactRevisionId: 'artifact-revision', producerExecutionId: 'execution-0', consumerExecutionId: 'execution-1', canonicalReadback: true },
    database: { uniqueRun: true, uniqueEdgeConsumption: true }, finalAuthoritativeReadback: true, outcome: 'succeeded', result: { digest, verifiedDerivedDigest: digest } }
}
test('complete fixture passes; forged host, stale ACKs, binding mutation and seeded input fail', () => {
  assert.doesNotThrow(() => validateEvidence(evidence(), manifest, 'happy-path'))
  const wrongHost = evidence(); wrongHost.nodes[1].machineId = 'pc'
  assert.throws(() => validateEvidence(wrongHost, manifest, 'happy-path'), /attribution/)
  const stale = evidence(); stale.nodes[1].ackSequence = [1,1]
  assert.throws(() => validateEvidence(stale, manifest, 'happy-path'), /attribution/)
  const changed = evidence(); changed.nodes[1].finalBindingHash = 'b'.repeat(64)
  assert.throws(() => validateEvidence(changed, manifest, 'happy-path'), /attribution/)
  const seeded = evidence(); seeded.nodes[1].inputDigest = 'b'.repeat(64)
  assert.throws(() => validateEvidence(seeded, manifest, 'happy-path'), /exact B input/)
})
