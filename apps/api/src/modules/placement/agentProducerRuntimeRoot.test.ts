import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { canonicalGraphJson, makeCurrentWorkflowFixture, RunStartV3InputSchema } from '@foreman-code/contracts/wave25'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import type { SourceRootRecord, SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import type { SourceOperationOwner } from '@foreman-code/contracts/source-operations'
import { AgentPlacementProducer } from './agentProducer.js'
import { deriveDispatch } from './binding.js'
import { bindNativeExecution } from './executionBinding.js'
import { HarnessInstallationRegistry } from '../harnesses/installationRegistry.js'
import { HarnessInstanceRegistry, localHarnessDrivers } from '../harnesses/instanceRegistry.js'
import type { SourceAdmissionPort } from '../sources/admissionPorts.js'
import type { WorkspaceRootPolicyPort } from '../sources/rootPolicyPorts.js'
import { identity, openPrivateRoot } from '../sources/privateFilesystem.js'
import { createSourceManifest, sourceSha256 } from '../sources/manifest.js'
import { sourceBindingHash } from '../sources/bindingHash.js'
import { PrivateSourceMaterializer } from '../sources/materialization.js'
import { verifyMaterializedWorkingDirectory } from '../sources/workingDirectory.js'
import { SourceOperationWorkerService } from '../sources/operationWorker.js'
import { attestInstalledWorkflowRuntimeLeaf } from '../runs/remote/installedWorkflowHost.js'
import { repeatRuntimeDirectory } from '../runs/repeatRepositoryHost.js'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'

const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
async function filesystem(path: string) {
  const handle = await openPrivateRoot(path)
  try { return await identity(handle) } finally { await handle.close() }
}

/** SQL/catalog/authorization doubles; producer, profile validation, source bytes,
 * execution binding and installed worker filesystem admission are real. No native provider launches. */
async function fixture() {
  const root = await mkdtemp(join(persistentFixtureRoot, 'review-placement-root-')); directories.push(root)
  const runtime = join(root, 'runtime'), project = join(root, 'project'), rootPolicyId = randomUUID()
  const namespace = join(runtime, 'source-materializations', rootPolicyId)
  await mkdir(runtime, { mode: 0o700 }); await mkdir(project, { mode: 0o700 })
  await mkdir(namespace, { recursive: true, mode: 0o700 })
  const binding: DeviceSessionBinding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const hostRef = { kind: 'device' as const, mainId: binding.mainId, deviceId: binding.deviceId }
  const approvedRoots: ApprovedRootAllowlist = { schemaVersion: 1, hostRef, applicationInstallationId: binding.workerInstallationId,
    configurationRevision: '1', bases: [{ baseId: randomUUID(), canonicalPath: project, filesystem: await filesystem(project), accessModes: ['read-only'] }],
    managedRuntimeRoot: runtime, runtimeFilesystem: await filesystem(runtime) }
  const f = makeCurrentWorkflowFixture('review-placement-root', 'single'), configuration = f.configurations[0]!
  const bytes = Buffer.from('export const approved = true\n')
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip', deletions: [],
    entries: [{ path: 'src/file.ts', kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false }] })
  const source = { approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
  const registration = { workerInstallationId: binding.workerInstallationId, keyRevision: 1, authorizationRevision: 1 }, digest = 'a'.repeat(64)
  const sourceRoot: SourceRootRecord = { version: 1, source, selection: { hostRef, rootPolicyId, rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1, mainId: binding.mainId, deviceId: binding.deviceId, workerInstallationId: binding.workerInstallationId,
      workspaceId: f.version.workspaceId, rootId: randomUUID(), bindingRevision: 1, locationRevision: 1, canonicalPath: namespace,
      filesystem: await filesystem(namespace), accessMode: 'exclusive-write', snapshotId: source.snapshotId, manifestDigest: source.manifestDigest },
    ownerPrincipalId: 'operator', authorizedByPrincipalId: 'operator', registration, attestationId: randomUUID(), attestationDigest: digest, boundAt: f.createdAt }
  const instanceId = randomUUID(), harnessInstallationId = 'installed-codex'
  const instances = new HarnessInstanceRegistry(localHarnessDrivers)
  instances.reload([{ instanceId, instanceRevision: '1', driverId: 'codex', enabled: true, configuration: configuration.harness }])
  const installations = new HarnessInstallationRegistry(instances)
  installations.refresh([{ hostRef, harnessInstallationId, installationFingerprint: digest, driverId: 'codex', driverRevision: '1',
    protocolRevision: 'codex-native-adapter-v1', environmentGeneration: '1', connectionGeneration: '1', observedVersion: '0.156.1',
    installed: true, authenticated: null, compatible: null, qualified: true,
    launcher: { requested: '/installed/codex', resolvedLauncher: '/installed/codex', fingerprint: digest,
      payloadFingerprints: [{ path: '/installed/codex', fingerprint: digest }], status: 'installed', interpreter: null, diagnostics: [],
      environment: { generation: '1', provenance: 'worker', cwd: project, path: '/installed' }, checkedAt: f.createdAt } }])
  const target = { hostRef, applicationInstallationId: binding.workerInstallationId, harnessInstallationId, installationFingerprint: digest }
  const override = { instanceId, revision: 1, instanceRevision: '1', target, presetId: 'codex', enabled: true, driverId: 'codex',
    configuration: configuration.harness, configurationFingerprint: digest, qualification: 'qualified' }
  const profileProof = { target, instanceRevision: '1', configurationFingerprint: digest, driverId: 'codex', driverRevision: '1',
    protocolRevision: 'codex-native-adapter-v1', suiteRevision: 'codex-live-4', environmentGeneration: '1', connectionGeneration: '1',
    authenticated: true, compatible: true, qualified: true, checkedAt: f.createdAt }
  const version = structuredClone(f.version), node = version.definition.nodes[0]!
  node.placement = { schemaVersion: 1, hostRef, rootPolicyId, rootPolicyRevision: '1', locationRevision: '1', projectRoot: project,
    cwdPolicy: 'project-subdirectory', relativeCwd: 'src', instanceId, instanceRevision: '1', harnessInstallationId,
    source, rootBinding: { rootId: sourceRoot.binding.rootId, bindingRevision: 1 } }
  version.contentHash = `sha256:${createHash('sha256').update(canonicalGraphJson({ definition: version.definition,
    configurations: version.agentConfigurationVersionIds, entryNodeId: version.entryNodeId })).digest('hex')}`
  const client = { query: async (text: string) => {
    let rows: unknown[] = []
    if (text.includes('from workflow_versions')) rows = [{ id: version.id, workspace_id: version.workspaceId, workflow_id: version.workflowId,
      version: version.version, entry_node_id: version.entryNodeId, execution_semantics_version: 3, record: version }]
    else if (text.includes('from agent_configuration_versions')) {
      rows = [{ id: configuration.id, agent_id: configuration.agentId, record: configuration }]
    }
    else if (text.includes('from source_root_bindings')) rows = [{ record: sourceRoot }]
    else if (text.includes('from harness_instance_settings')) rows = [{ record: override }]
    else if (text.includes('from harness_instance_profile_evidence')) rows = [{ instance_revision: String(override.revision), record: profileProof }]
    else if (text.includes('from harness_qualifications')) rows = [{ harness: 'codex', version: '0.156.1', binary_sha256: digest,
      suite_revision: 'codex-live-4', profile: 'codex-0.156', checks: [{ id: 'fixture-check', passed: true, detail: null }],
      failure_reason: null, started_at: f.createdAt, checked_at: f.createdAt }]
    return { rows, rowCount: rows.length }
  }, on: () => undefined, removeListener: () => undefined, release: () => undefined }
  const policy = { ...sourceRoot.selection, canonicalProjectRoot: project, managedRuntimeRoot: runtime, registration }
  const roots = { resolve: async () => policy, read: async () => [policy] } as unknown as WorkspaceRootPolicyPort
  const sources = { resolveRootBinding: async () => sourceRoot,
    resolveApprovedSource: async () => ({ manifest }) } as unknown as SourceAdmissionPort
  const producer = new AgentPlacementProducer({ connect: async () => client } as unknown as pg.Pool, binding.mainId, sources, roots,
    { installations, pinOverride: value => installations.pin({ instanceId: value.instanceId,
      hostRef: value.target.hostRef, harnessInstallationId: value.target.harnessInstallationId,
      connectionGeneration: '1', environmentGeneration: '1' }) }, { codex: 'codex-live-4' },
    new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }))
  const prepared = await producer.prepare(RunStartV3InputSchema.parse({ workspaceId: version.workspaceId, workflowId: version.workflowId,
    workflowVersionId: version.id, expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds, commandId: 'root-admission',
    executionSemanticsVersion: 3, expectedWorkflowRevision: 1, expectedLocationRevision: 1, input: {} }),
  { id: 'operator', name: 'test', audience: 'operator', grants: [], expiresAt: '2099-01-01T00:00:00Z', revokedAt: null })
  if (!prepared) throw new Error('Expected placed admission')
  const placement = prepared.bind(f.run.id)[0]!
  const execution = HarnessExecutionSchema.parse({ id: f.identities[0]!.executionId, runId: f.run.id, workflowNodeId: node.id,
    agentId: configuration.agentId, agentConfigurationVersionId: configuration.id, attempt: 1,
    input: {}, state: 'queued', createdAt: f.createdAt })
  const intent = deriveDispatch(placement, { executionId: execution.id, attemptId: 'attempt', operationId: 'operation', technicalAttempt: 1,
    occurrenceId: null, occurrenceIndex: 0, inputDigest: `sha256:${digest}`, owner: { grantId: 'grant', epoch: '1' } })
  const attempt = { executionId: intent.executionId, attemptId: intent.attemptId, keyRevision: 1, authorizationRevision: 1,
    placementHash: sourceBindingHash(sourceRoot, { executionId: intent.executionId, attemptId: intent.attemptId, keyRevision: 1, authorizationRevision: 1 }, intent.operationId) }
  const receipt = await new PrivateSourceMaterializer({ read: async () => bytes }, async () => undefined).prepare({ manifest, binding: sourceRoot.binding, attempt })
  const record: SourceMaterializationRecord = { receipt, rootPolicyId, rootPolicyRevision: '1', operationId: intent.operationId,
    reservationId: randomUUID(), sourceBindingHash: attempt.placementHash, finalDispatchBindingHash: null, state: 'prepared' }
  const workingTree = await verifyMaterializedWorkingDirectory(record, 'src', async () => undefined)
  const nativePlacement = bindNativeExecution(placement, intent, record, workingTree)
  nativePlacement.materialization.finalDispatchBindingHash = nativePlacement.bindingHash
  const owner: SourceOperationOwner = { identity: { operationId: intent.operationId, ownerPrincipalId: 'operator', expiresAt: '2099-01-01T00:00:00.000Z' },
    root: sourceRoot, attempt, source, record: nativePlacement.materialization, physicalClosureConfirmed: false }
  const workerSources = new SourceOperationWorkerService({mainNow:()=>Date.now(), authenticate: async () => undefined, approvedRoots: async () => approvedRoots,
    currentOwner: async () => owner })
  const verify = vi.spyOn(workerSources, 'handle')
  const request = { executionId: execution.id, runId: f.run.id, workspaceId: version.workspaceId, workflowNodeId: node.id,
    workingDirectory: workingTree.canonicalCwd, runtimeDirectory: repeatRuntimeDirectory(placement.destination.managedRuntimeRoot, f.scope, execution),
    configuration, input: {} }
  return { approvedRoots, placement, intent, nativePlacement, request, sources: workerSources, verify,
    context: { binding, signal: new AbortController().signal } }
}

it('admits the real producer pin through installed worker source/runtime attestation', async () => {
  const f = await fixture()
  const proof = await attestInstalledWorkflowRuntimeLeaf(f)
  expect(f.placement.destination.managedRuntimeRoot).toBe(f.approvedRoots.managedRuntimeRoot)
  expect(f.placement.destination.canonicalProjectRoot).toBe(f.approvedRoots.bases[0]!.canonicalPath)
  expect(f.request.runtimeDirectory.startsWith(`${f.approvedRoots.managedRuntimeRoot}/`)).toBe(true)
  expect(f.request.workingDirectory).not.toBe(f.placement.destination.canonicalCwd)
  expect(proof.canonicalRuntimeDirectory).toBe(f.request.runtimeDirectory)
  await expect(access(join(f.request.runtimeDirectory, '.graphql-workflow-runtime.json'))).resolves.toBeUndefined()
  expect(await attestInstalledWorkflowRuntimeLeaf(f)).toEqual(proof)
})

it('rejects a worker allowlist with a different runtime root before source verification or mkdir', async () => {
  const f = await fixture()
  await expect(attestInstalledWorkflowRuntimeLeaf({ ...f,
    approvedRoots: { ...f.approvedRoots, managedRuntimeRoot: join(f.approvedRoots.managedRuntimeRoot, 'unauthorized') } }))
    .rejects.toMatchObject({ code: 'WORKER_WORKFLOW_UNAVAILABLE' })
  expect(f.verify).not.toHaveBeenCalled()
  await expect(access(f.request.runtimeDirectory)).rejects.toThrow()
})
