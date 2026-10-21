import { describe, expect, it } from 'vitest'
import type { HarnessExecution } from '@foreman-code/contracts'
import type { AcceptedNodePlacement, DispatchIntent } from '@foreman-code/contracts/node-placement'
import type { RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import type { RemoteJobOperationReceipt } from '@foreman-code/contracts/remote-job-execution'
import { telemetryComputerFixture } from '@foreman-code/contracts/resource-telemetry-fixtures'
import type { OCIHostCertificate } from '../../jobs/executorContainerOwner.js'
import { jobExecution } from '../../../../test/helpers/jobFixture.js'
import { projectAcceptedWorkflowScope, projectCIJobScope, projectConversationScope, type CapturedScopeLease } from './scopeProjection.js'
import { passiveRegistryOwnershipReader } from './registryAdapter.js'
const identity = { mainId: telemetryComputerFixture.mainId, host: telemetryComputerFixture.host }
const capture = (): CapturedScopeLease => ({ nativeOwner: 'captured-not-inferred-owner', shared: false, lifecycle: 'closure-unconfirmed',
  session: { harness: 'claude', nativeSessionId: 'session', providerVersion: 'observed-version' },
  writer: { id: 'lane', token: 'private-writer-token', owner: 'original-writer' },
  lane: { id: 'lane', harness: 'claude', nativeSessionId: 'session', ownerAgentId: 'agent', leaseOwner: 'original-writer',
    leaseToken: 'private-writer-token', leaseExpiresAt: '2026-10-02T00:00:00Z', observedStatus: 'busy', connectionGeneration: 1,
    observedAt: '2026-10-01T00:00:00Z', revision: 2 } })
const e: HarnessExecution = { id: 'execution', runId: 'run', workflowNodeId: 'node', agentId: 'agent',
  agentConfigurationVersionId: 'config', attempt: 1, nativeSessionId: 'session', input: { prompt: 'original' },
  workingDirectory: '/project', runtimeDirectory: '/runtime', state: 'running', createdAt: '2026-10-01T00:00:00Z' }
const i: DispatchIntent = { schemaVersion: 1, protocolVersion: 1, mainId: identity.mainId, runId: e.runId, nodeId: e.workflowNodeId,
  executionId: e.id, occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation',
  bindingHash: 'a'.repeat(64), inputDigest: `sha256:${'b'.repeat(64)}`, owner: { grantId: 'grant', epoch: '1' } }
const p: AcceptedNodePlacement = { schemaVersion: 1, mainId: identity.mainId, runId: e.runId, nodeId: e.workflowNodeId,
  hostRef: identity.host.hostRef, registration: null, mainInstallationId: identity.host.applicationInstallationId,
  destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime', directoryIdentityHash: 'a'.repeat(64),
    rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1', attestationId: 'attestation', attestationHash: 'a'.repeat(64) },
  source: { revisionId: 'source', manifestDigest: 'a'.repeat(64), materializationId: 'materialization', materializationDigest: 'a'.repeat(64) },
  payload: { kind: 'agent', agentId: e.agentId, agentConfigurationVersionId: e.agentConfigurationVersionId,
    driverId: 'driver', driverRevision: '1', instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'harness',
    installationFingerprint: 'fingerprint', runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [] }, bindingHash: i.bindingHash }
const workflow = () => ({ identity: structuredClone(identity), workspaceId: 'workspace', workflowId: 'workflow',
  accepted: structuredClone(e), captured: structuredClone(e), placement: structuredClone(p), intent: structuredClone(i), capture: capture(), nowUnixMs: 1 })
describe('accepted workflow and original conversation projection', () => {
  it('retains background ownership and omits writer tokens/version/progress from metrics', () => {
    const v = projectAcceptedWorkflowScope(workflow())!
    expect(v.nativeOwner).toBe('captured-not-inferred-owner'); expect(v.lifecycle).toBe('closure-unconfirmed')
    expect(v.selector.owner.kind).toBe('workflow-execution'); expect(JSON.stringify(v)).not.toContain('private-writer-token')
  })
  it.each(['input', 'createdAt', 'runtimeDirectory', 'workingDirectory', 'agentConfigurationVersionId', 'attempt', 'parallelGroupId'] as const)('rejects changed immutable SQL %s', key => {
    const f = workflow(); Object.assign(f.accepted, { [key]: key === 'attempt' ? 2 : 'changed' }); expect(projectAcceptedWorkflowScope(f)).toBeNull()
  })
  it.each(['token', 'owner', 'id'] as const)('rejects replaced original writer %s', key => {
    const f = workflow(); f.capture.writer[key] = 'replacement'; expect(projectAcceptedWorkflowScope(f)).toBeNull()
  })
  it('rejects expired or changed native session lease', () => {
    const f = workflow(); f.nowUnixMs = Date.parse(f.capture.lane.leaseExpiresAt!); expect(projectAcceptedWorkflowScope(f)).toBeNull()
    f.nowUnixMs = 1; f.capture.session.nativeSessionId = 'same-agent-new-session'; expect(projectAcceptedWorkflowScope(f)).toBeNull()
  })
  it('projects actual agent and Operator conversations without inventing turns', () => {
    for (const owner of [{ kind: 'agent-conversation' as const, workspaceId: 'w', workflowId: 'wf', nodeId: 'n', agentId: 'agent', conversationId: 'agent-conversation', leaseId: 'lane' },
      { kind: 'operator-conversation' as const, conversationId: 'operator-conversation', leaseId: 'lane' }]) {
      const v = projectConversationScope({ identity, owner, capture: capture(), nowUnixMs: 1 })!
      expect(v.selector.owner).toEqual(owner); expect(v.nativeOwner).toBe(capture().nativeOwner)
      expect(projectConversationScope({ identity, owner: { ...owner, leaseId: 'another-lane' }, capture: capture(), nowUnixMs: 1 })).toBeNull()
    }
  })
  it('remote workflow requires exact receipt intent, registration, connection generation and original session', () => {
    const f = workflow(); const h = f.identity.host
    h.hostRef = { kind: 'device', mainId: identity.mainId, deviceId: h.deviceId }; h.applicationInstallationId = '44444444-4444-4444-8444-444444444444'
    h.keyRevision = 1; h.authorizationRevision = 1; h.connectionGeneration = 2
    f.placement.hostRef = h.hostRef; f.placement.registration = { workerInstallationId: h.applicationInstallationId, keyRevision: 1, authorizationRevision: 1 }
    const receipt: RemoteOperationReceipt = { schemaVersion: 1, intent: f.intent, connection: { mainId: identity.mainId, deviceId: h.deviceId,
      workerInstallationId: h.applicationInstallationId, bootId: h.bootId, keyRevision: 1, authorizationRevision: 1, connectionGeneration: 2 },
      workerIncarnationId: h.bootId, sequence: 1, phase: 'running', entryAttempted: true, turnEntryAttempted: false, stopFence: false, controls: [],
      native: { sessionId: 'session', processIdentityDigest: 'a'.repeat(64) } }
    expect(projectAcceptedWorkflowScope({ ...f, receipt })).not.toBeNull()
    expect(projectAcceptedWorkflowScope(f)).toBeNull()
    expect(projectAcceptedWorkflowScope({ ...f, receipt: { ...receipt, intent: { ...receipt.intent, owner: { grantId: 'grant', epoch: '2' } } } })).toBeNull()
    receipt.connection.connectionGeneration = 1; expect(projectAcceptedWorkflowScope({ ...f, receipt })).toBeNull()
    receipt.connection.connectionGeneration = 2; receipt.native!.sessionId = 'other'; expect(projectAcceptedWorkflowScope({ ...f, receipt })).toBeNull()
  })
})
function ci() {
  const execution = jobExecution(); execution.acceptedSpec.target.mainInstallationId = identity.host.applicationInstallationId; const intent = { schemaVersion: 1 as const, protocolVersion: 1 as const, mainId: identity.mainId,
    subject: { kind: 'manual-job' as const, workspaceId: execution.workspaceId, jobExecutionId: execution.id, definitionId: 'definition' },
    executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId, bindingHash: execution.acceptedSpec.bindingHash,
    inputDigest: `sha256:${'b'.repeat(64)}`, owner: execution.owner }
  const receipt: RemoteJobOperationReceipt = { schemaVersion: 1, kind: 'job', intent, execution,
    connection: { kind: 'main', mainId: identity.mainId, mainInstallationId: identity.host.applicationInstallationId, bootId: identity.host.bootId },
    workerIncarnationId: identity.host.bootId, sequence: 1, observedAt: e.createdAt, phase: 'running', entryAttempted: true,
    stopFence: false, controls: [], publication: 'pending', native: { containerId: 'container', supervisorIdentity: 'actual-supervisor', processIdentityDigest: 'a'.repeat(64) } }
  const boundary = { kind: 'cgroup-v2' as const, path: '/sys/fs/cgroup/job', device: '1', inode: '2' }
  const process = { bootId: identity.host.bootId, pid: 42, startTicks: '100' }
  const certificate: OCIHostCertificate = { scope: { subject: { kind: 'job', executionId: intent.executionId, attemptId: intent.attemptId,
    operationId: intent.operationId, bindingHash: intent.bindingHash }, leaseId: 'job-lease', owner: intent.owner,
    observedDeviceId: identity.host.deviceId, observedInstallationId: identity.host.applicationInstallationId, bootId: identity.host.bootId },
    containerId: 'container', process, boundary, helpers: [{ kind: 'conmon', process: { ...process, pid: 43 }, boundary: { ...boundary, path: '/sys/fs/cgroup/conmon', inode: '3' } }], lifecycle: 'active' }
  return { identity, receipt, certificate, nativeOwner: 'actual-supervisor', attributionRevision: '1', shared: false,
    accepted: structuredClone(execution), lease: { id: 'job-lease', owner: intent.owner, expiresAt: '2026-10-02T00:00:00Z' }, nowUnixMs: 1 }
}
describe('original CI owner projection', () => {
  it('passes container and disjoint helper boundaries through the passive registry join', async () => {
    const f = ci(); const v = projectCIJobScope(f)!
    const reader = passiveRegistryOwnershipReader({ revision: () => '1', snapshot: () => ({ revision: '1', launches: [] }), changes: async function* () {} },
      { revision: () => '1', snapshot: async () => [v], changes: async function* () {} })
    const projected = (await reader.snapshot(new AbortController().signal)).views[0]!
    expect(projected.roots.map(p => p.pid)).toEqual([42, 43]); expect(projected.launchIds).toEqual(['container'])
    expect(projected.accountingHandles.map(h => h.boundary.path)).toEqual(['/sys/fs/cgroup/job', '/sys/fs/cgroup/conmon'])
  })
  it('missing helper accounting remains explicitly partial and closed certificate retains facts without reading sources', async () => {
    const f = ci(); f.certificate.helpers[0]!.boundary = null; expect(projectCIJobScope(f)?.captured?.incomplete).toBe(true)
    f.certificate.lifecycle = 'closed'; const v = projectCIJobScope(f)!
    const reader = passiveRegistryOwnershipReader({ revision: () => '1', snapshot: () => ({ revision: '1', launches: [] }), changes: async function* () {} },
      { revision: () => '1', snapshot: async () => [v], changes: async function* () {} })
    const row = (await reader.snapshot(new AbortController().signal)).views[0]!
    expect(row.roots).toEqual([]); expect(row.accountingHandles).toEqual([]); expect(row.launchIds).toEqual(['container']); expect(row.lifecycle).toBe('closed')
  })
  it('rejects old lease, owner epoch, host boot, container and modified accepted job facts', () => {
    const changed = ci(); changed.accepted.acceptedSpec.argv = ['changed']; expect(projectCIJobScope(changed)).toBeNull()
    for (const mutate of [(f: ReturnType<typeof ci>) => { f.lease.expiresAt = 'invalid' },
      (f: ReturnType<typeof ci>) => { f.lease.owner = { ...f.lease.owner, epoch: '2' } },
      (f: ReturnType<typeof ci>) => { f.certificate.process.bootId = 'other' },
      (f: ReturnType<typeof ci>) => { f.receipt.native!.containerId = 'another' }]) {
      const f = ci(); mutate(f); expect(projectCIJobScope(f)).toBeNull()
    }
  })
})
