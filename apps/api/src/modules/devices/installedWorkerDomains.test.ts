import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { WorkerPairingConfigurationSchema } from '@foreman-code/contracts/device-identity'
import { createInstalledWorkerDomains, createWorkerRuntimeDrain } from './installedWorkerDomains.js'

// Native MCP files are exercised separately; domain fixtures must not touch the host user profile.
vi.mock('../harnesses/installedWorkerManagedMcp.js', () => ({
  createInstalledWorkerManagedMcp: () => ({ worker: {}, ensureReady: async () => {} }),
}))
import { ApprovedRootAllowlistSchema } from '@foreman-code/contracts/workspace-root-policies'
import { extensionDescriptors } from './deviceApplicationChannel.js'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import { afterEach } from 'vitest'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { TelemetryCollectedBatchSchema } from '@foreman-code/contracts/resource-telemetry'
import { resourceTelemetryExtension } from '../resource-telemetry/ingestion/ports.js'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { qualifyApprovedRootAllowlist } from '../sources/rootAttestation.js'
import { identity, openPrivateRoot } from '../sources/privateFilesystem.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { HarnessRegistryReadbackSchema } from '@foreman-code/contracts/harness-registry'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { OperatorServices } from '../../mcp/operator/types.js'
import type { PostgresAccessService } from '../access/postgres.js'
import { requireAuthorization } from '../access/policy.js'
import { buildApp } from '../../app.js'
import { DomainError } from '../errors.js'
import { verificationRuntimeFixture } from '../../../test/helpers/verificationRuntimeFixture.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('actual installed worker mount availability, no physical acceptance', () => {
  it.each(['absent', 'missing-sdk', 'invalid-lock'] as const)(
    'refreshes authenticated discovery and isolates Claude inspection when %s', async claudeState => {
    const stateDirectory = await mkdtemp(join(persistentFixtureRoot, 'worker-discovery-refresh-'))
    roots.push(stateDirectory)
    const pairing = WorkerPairingConfigurationSchema.parse({ formatVersion: 1, mainId: randomUUID(),
      deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
      endpoint: 'wss://unconnected.example/device/connect', mainPublicKeyFingerprint: 'a'.repeat(64),
      credential: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' })
    const binding = { mainId: pairing.mainId, deviceId: pairing.deviceId,
      workerInstallationId: pairing.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
      bootId: bootIdentity(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
    const location = { path: join(stateDirectory, 'workflow-runtime.json'), ownerUid: process.getuid!() }
    const sdk = join(stateDirectory, 'sdk')
    await mkdir(sdk)
    await writeFile(join(sdk, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk',
      version: '0.3.284' }))
    await writeFile(join(sdk, 'sdk.mjs'), 'export {};')
    const lock = join(stateDirectory, 'claude-lock.yaml')
    await writeFile(lock, 'packages: {}')
    const claude = { binary: process.execPath, installedLockPath: lock,
      sdkEntrypoint: join(sdk, claudeState === 'missing-sdk' ? 'missing.mjs' : 'sdk.mjs') }
    const refresh = vi.fn(async (): Promise<typeof location | null> => {
      await writeFile(location.path, JSON.stringify({ schemaVersion: 1, codexBinary: process.execPath,
        expectedVersion: 'codex-cli 0.162.0', payloadPaths: [], appMcpLauncher: '/installed/launcher.mjs',
        ...(claudeState === 'absent' ? {} : { claude }) }),
      { mode: 0o600 })
      return location
    })
    const mounted = await createInstalledWorkerDomains({ stateDirectory, pairing, bootId: binding.bootId,
      configuration: null, refreshWorkflowConfiguration: refresh, approvedRoots: async () => null,
      connection: () => ({ currentBinding: () => binding, captureRequest: () => undefined, mainNow: () => Date.now() }),
      codexSuiteRevision: 'discovery-fixture' })
    try {
      const discovery = mounted.extensions.find(extension => extension.namespace === 'harness-discovery-v1')!
      const context = { binding, signal: AbortSignal.timeout(10_000) }
      const request = { operation: 'discover', refreshId: randomUUID() }
      await expect(discovery.handle!(request, { ...context, binding: { ...binding, authorizationRevision: 2 } }))
        .rejects.toMatchObject({ code: 'HARNESS_INVENTORY_STALE' })
      expect(refresh).not.toHaveBeenCalled()
      const result = await discovery.handle!(request, context)
      const inventory = HarnessRegistryReadbackSchema.parse(result.payload)
      expect(inventory.installations).toHaveLength(claudeState === 'absent' ? 1 : 2)
      expect(inventory.installations[0]).toMatchObject({ driverId: 'codex', installed: true,
        hostRef: { kind: 'device', mainId: pairing.mainId, deviceId: pairing.deviceId } })
      if (claudeState !== 'absent') {
        expect(inventory.installations[1]).toMatchObject({ driverId: 'claude', installed: false,
          qualified: false, installationFingerprint: null, launcher: { status: 'unreadable',
            requested: process.execPath, diagnostics: [expect.any(String)] } })
      }
      expect(refresh).toHaveBeenCalledOnce()
      const principal: ManagementPrincipal = { id: 'worker-inventory-reader', name: 'Reader', audience: 'operator',
        expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
        grants: [{ actions: ['harnesses:read'], scope: {} }] }
      const access = { authenticate: async (token: string) => {
        if (token === 'inventory-reader') return principal
        if (token === 'denied-reader') return { ...principal, grants: [] }
        throw new DomainError('AUTH_REQUIRED', 'Authentication required.', 401)
      } } as unknown as PostgresAccessService
      const ci = mounted.extensions.find(extension => extension.namespace === 'ci-runtime-v1')!
      const fingerprint = verificationRuntimeFixture().measurement.fingerprint
      const commit = fingerprint.sourceCommit!
      const legacyRefresh = { operation: 'refresh', operationId: randomUUID(), commit, root: fingerprint.root,
        resources: fingerprint.resources, manifest: { version: 1, ...fingerprint.root.source,
          git: { commit, tree: 'a'.repeat(40), objectFormat: 'sha1' }, capturePolicy: 'git-tree-v1',
          executablePolicy: 'preserve-approved', entries: [], deletions: [], totalEntries: 0, totalBytes: 0 } }
      const get = vi.fn(async (caller: ManagementPrincipal) => {
        requireAuthorization(caller, 'harnesses:read')
        await expect(ci.handle!(legacyRefresh, context)).rejects.toMatchObject({ code: 'CI_RUNTIME_RETIRED' })
        return (await discovery.handle!(request, context)).payload
      })
      const commands = { recordDenied: vi.fn(async () => {}) }
      const services = { harnessRegistry: { get }, commands } as unknown as OperatorServices
      const app = buildApp({ logger: false,
        readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services } })
      const host = { kind: 'device', mainId: pairing.mainId, deviceId: pairing.deviceId }
      try {
        const address = await app.listen({ host: '127.0.0.1', port: 0 })
        const rpc = async (token: string) => {
          const response = await fetch(new URL('/mcp', address), { method: 'POST',
            headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream',
              'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
              params: { name: 'harness_registry_get', arguments: host } }) })
          return { statusCode: response.status, body: await response.text() }
        }
        const response = await rpc('inventory-reader')
        expect(response.statusCode, response.body).toBe(200)
        const json = response.body.startsWith('event:')
          ? response.body.split('\n').find(line => line.startsWith('data: '))!.slice(6) : response.body
        const direct = HarnessRegistryReadbackSchema.parse(result.payload)
        expect(decodeMcpToolResult(JSON.parse(json).result)).toEqual({ ...direct,
          installations: direct.installations.map(installation => ({ ...installation,
            launcher: { ...installation.launcher, checkedAt: expect.any(String) } })) })
        expect(get).toHaveBeenLastCalledWith(principal, host)
        expect(JSON.parse(await readFile(location.path, 'utf8')))
          .toMatchObject({ codexBinary: process.execPath, expectedVersion: 'codex-cli 0.162.0' })
        const reads = get.mock.calls.length
        const denied = await rpc('denied-reader')
        expect(denied.body).toContain('isError')
        expect(get).toHaveBeenCalledTimes(reads)
        expect((await rpc('invalid-token')).statusCode).toBe(401)
      } finally { await app.close() }
      refresh.mockImplementationOnce(async () => null)
      expect((await discovery.handle!(request, context)).payload).toMatchObject({ installations: [] })
    } finally { await mounted.close() }
  })
  it('drains active Jobs and Agent sessions before refresh while preserving status and controls', async () => {
    let finishJob!: () => void
    const job = new Promise<void>(resolve => { finishJob = resolve })
    let agentOpen = true
    let observeQuiescence!: () => void
    const quiescence = new Promise<void>(resolve => { observeQuiescence = resolve })
    let finishAgent!: () => void
    const agentClosed = new Promise<void>(resolve => { finishAgent = resolve })
    let jobOutcome = 'running'
    let scheduled = false
    const drain = createWorkerRuntimeDrain({ signal: new AbortController().signal, active: () => [],
      drainJobs: async () => { await job; jobOutcome = 'succeeded' },
      drainQualifications: async () => {}, drainMaintenance: async () => {}, quiescent: async () => {
        observeQuiescence()
        await agentClosed
        return !agentOpen
      } })
    const refresh = drain.run().then(() => { scheduled = true })
    expect(() => drain.assertAdmission('execution-v1', { method: 'job-dispatch' })).toThrow('waiting for active work')
    expect(() => drain.assertAdmission('execution-v1', { method: 'conversation.open' })).toThrow()
    expect(() => drain.assertAdmission('job-runtime-qualification-v1', { operation: 'start' })).toThrow()
    expect(() => drain.assertAdmission('harness-discovery-v1', {})).toThrow()
    expect(() => drain.assertAdmission('execution-v1', { method: 'job-status' })).not.toThrow()
    expect(() => drain.assertAdmission('execution-v1', { method: 'conversation.close' })).not.toThrow()
    expect(() => drain.assertAdmission('execution-v1', { method: 'conversation.respond' })).not.toThrow()
    expect(scheduled).toBe(false)
    expect(jobOutcome).toBe('running')
    finishJob()
    await quiescence
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(jobOutcome).toBe('succeeded')
    expect(scheduled).toBe(false)
    agentOpen = false
    finishAgent()
    await refresh
    expect(scheduled).toBe(true)
    expect(jobOutcome).toBe('succeeded')
    drain.resume()
    expect(() => drain.assertAdmission('execution-v1', { method: 'job-dispatch' })).not.toThrow()
  })

  it.each(['idle', 'failed'] as const)(
    'keeps Agent discovery and source recovery open after legacy refresh attempts with %s status', async legacyState => {
    const stateDirectory = await mkdtemp(join(persistentFixtureRoot, 'worker-source-cleanup-'))
    roots.push(stateDirectory)
    const project = join(stateDirectory, 'project')
    const rootPolicyId = randomUUID()
    const namespace = join(stateDirectory, 'source-materializations', rootPolicyId)
    await mkdir(project, { mode: 0o700 })
    await mkdir(namespace, { recursive: true, mode: 0o700 })
    for (const name of ['workflow-operations.json', 'job-runtime-operations.json']) {
      const journal = await RemoteOperationJournal.open(join(stateDirectory, name), { initializeNewInstallation: true })
      await journal.close()
    }
    const pairing = WorkerPairingConfigurationSchema.parse({ formatVersion: 1, mainId: randomUUID(), deviceId: randomUUID(),
      workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, endpoint: 'wss://unconnected.example/device/connect',
      mainPublicKeyFingerprint: 'a'.repeat(64), credential: 'b'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString() })
    const approved = await qualifyApprovedRootAllowlist({ schemaVersion: 1,
      hostRef: { kind: 'device', mainId: pairing.mainId, deviceId: pairing.deviceId },
      applicationInstallationId: pairing.workerInstallationId, configurationRevision: '1',
      bases: [{ baseId: randomUUID(), canonicalPath: project, accessModes: ['read-write'] }],
      managedRuntimeRoot: stateDirectory })
    const directory = await openPrivateRoot(namespace)
    const filesystem = await identity(directory)
    await directory.close()
    const source = { approvedSourceId: randomUUID(), snapshotId: randomUUID(), manifestDigest: 'c'.repeat(64) }
    const root = SourceRootRecordSchema.parse({ version: 1, source,
      selection: { hostRef: approved.hostRef, rootPolicyId, rootPolicyRevision: '1', locationRevision: '1' },
      binding: { version: 1, mainId: pairing.mainId, deviceId: pairing.deviceId,
        workerInstallationId: pairing.workerInstallationId, workspaceId: randomUUID(), rootId: randomUUID(),
        bindingRevision: 1, locationRevision: 1, canonicalPath: namespace, filesystem, accessMode: 'exclusive-write',
        snapshotId: source.snapshotId, manifestDigest: source.manifestDigest },
      registration: { workerInstallationId: pairing.workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
      ownerPrincipalId: 'source-owner', authorizedByPrincipalId: 'source-owner', attestationId: randomUUID(),
      attestationDigest: 'd'.repeat(64), boundAt: new Date().toISOString() })
    const grant = { reservationId: randomUUID(), reclamationId: randomUUID(), operationId: randomUUID(),
      scopeId: 'original-filesystem', expiresAt: pairing.expiresAt, roots: [root], owner: null }
    const binding = { mainId: pairing.mainId, deviceId: pairing.deviceId, workerInstallationId: pairing.workerInstallationId,
      keyRevision: 1, authorizationRevision: 1, bootId: bootIdentity(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
    if (legacyState === 'failed') {
      const ciDirectory = join(stateDirectory, 'managed', 'ci')
      const log = join(ciDirectory, 'refresh.log')
      await mkdir(ciDirectory, { recursive: true, mode: 0o700 })
      await writeFile(log, 'EXDEV\nexit=1\n', { mode: 0o600 })
      await writeFile(join(ciDirectory, 'ci-runtime-last-refresh.json'), JSON.stringify({
        operationId: randomUUID(), commit: 'a'.repeat(40), log,
      }), { mode: 0o600 })
    }
    const mounted = await createInstalledWorkerDomains({ stateDirectory, pairing, bootId: binding.bootId,
      configuration: null, approvedRoots: async () => approved, codexSuiteRevision: 'fixture-suite',
      connection: () => ({ mainNow: () => Date.now(), currentBinding: () => binding, captureRequest: () => ({ binding,
        request: async () => ({ payload: { version: 1, operation: 'sources.reclamation-authorize', grant } }) }) }) })
    try {
      const ci = mounted.extensions.find(value => value.namespace === 'ci-runtime-v1')!
      const context = { binding, signal: AbortSignal.timeout(10_000) }
      const fingerprint = verificationRuntimeFixture().measurement.fingerprint
      const commit = fingerprint.sourceCommit!
      const refresh = { operation: 'refresh', operationId: randomUUID(), commit, root,
        resources: fingerprint.resources, manifest: { version: 1, ...source,
          git: { commit, tree: 'a'.repeat(40), objectFormat: 'sha1' }, capturePolicy: 'git-tree-v1',
          executablePolicy: 'preserve-approved', entries: [], deletions: [], totalEntries: 0, totalBytes: 0 } }
      await expect(ci.handle!(refresh, { ...context, binding: { ...binding, authorizationRevision: 2 } }))
        .rejects.toMatchObject({ code: 'CI_RUNTIME_STALE' })
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(ci.handle!(refresh, context)).rejects.toMatchObject({ code: 'CI_RUNTIME_RETIRED' })
        expect((await ci.handle!({ operation: 'status' }, context)).payload).toMatchObject({ state: legacyState })
        const discovery = mounted.extensions.find(value => value.namespace === 'harness-discovery-v1')!
        expect((await discovery.handle!({ operation: 'discover', refreshId: randomUUID() }, context)).payload)
          .toMatchObject({ installations: [] })
      }
      const extension = mounted.extensions.find(value => value.namespace === 'source-operations-v1')!
      expect(await extension.handle!({ version: 1, operation: 'sources.reclaim-reservation',
        reservationId: grant.reservationId, reclamationId: grant.reclamationId },
      { binding, signal: AbortSignal.timeout(10_000) }))
        .toMatchObject({ payload: { reclaimed: true, operationId: grant.operationId, closures: [] } })
    } finally {
      await mounted.close()
    }
  }, 30_000)
  it('mounts the guarded native profile-check endpoint for an installed workflow configuration', async () => {
    const stateDirectory = await mkdtemp(join(persistentFixtureRoot, 'worker-profile-check-'))
    const journal = await RemoteOperationJournal.open(join(stateDirectory, 'workflow-operations.json'),
      { initializeNewInstallation: true })
    await journal.close()
    const pairing = WorkerPairingConfigurationSchema.parse({ formatVersion: 1, mainId: randomUUID(), deviceId: randomUUID(),
      workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, endpoint: 'wss://unconnected.example/device/connect',
      mainPublicKeyFingerprint: 'a'.repeat(64), credential: 'b'.repeat(64), expiresAt: new Date(Date.now() + 60000).toISOString() })
    const path = join(stateDirectory, 'workflow-runtime.json')
    await writeFile(path, JSON.stringify({ schemaVersion: 1, codexBinary: '/uncreated/codex',
      appMcpLauncher: '/uncreated/launcher.mjs', expectedVersion: '0.154.0', payloadPaths: [] }), { mode: 0o600 })
    const filesystem = { device: '1', inode: '1', mountId: '1' }
    const approved = ApprovedRootAllowlistSchema.parse({ schemaVersion: 1,
      hostRef: { kind: 'device', mainId: pairing.mainId, deviceId: pairing.deviceId },
      applicationInstallationId: pairing.workerInstallationId, configurationRevision: '1',
      bases: [{ baseId: randomUUID(), canonicalPath: '/uncreated/project', filesystem, accessModes: ['read-write'] }],
      managedRuntimeRoot: stateDirectory, runtimeFilesystem: filesystem })
    const mounted = await createInstalledWorkerDomains({ stateDirectory, pairing, bootId: bootIdentity(),
      configuration: { path, ownerUid: process.getuid!() }, approvedRoots: async () => approved,
      connection: () => undefined, codexSuiteRevision: 'fixture-suite' })
    try {
      expect(extensionDescriptors(mounted.extensions).filter(value => value.namespace === 'host-harness-check-v1'))
        .toEqual([{ namespace: 'host-harness-check-v1', version: 1, role: 'server', maxJsonBytes: 1048576, maxBinaryBytes: 0 }])
      const handler = mounted.extensions.find(value => value.namespace === 'host-harness-check-v1')!
      await expect(handler.handle!({}, { signal: AbortSignal.timeout(1000), binding: {
        mainId: pairing.mainId, deviceId: pairing.deviceId, workerInstallationId: pairing.workerInstallationId,
        keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1,
      } })).rejects.toThrow()
    } finally {
      await mounted.close()
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })
  it('keeps execution domains unavailable while exposing guarded CI setup without protected approved roots', async () => {
    const pairing = WorkerPairingConfigurationSchema.parse({ formatVersion: 1, mainId: randomUUID(), deviceId: randomUUID(),
      workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, endpoint: 'wss://unconnected.example/device/connect',
      mainPublicKeyFingerprint: 'a'.repeat(64), credential: 'b'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString() })
    const mounted = await createInstalledWorkerDomains({ stateDirectory: '/uncreated-model-free-fixture', pairing, bootId: randomUUID(),
      configuration: null, approvedRoots: async () => null, connection: () => undefined, codexSuiteRevision: 'source-test-current-suite' })
    try {
      expect(mounted.workflowAvailable).toBe(false)
      expect(mounted.sourceAvailable).toBe(false)
      expect(mounted.rsyncAvailable).toBe(false)
      expect(mounted.rsyncMissing).toContain('canonical acknowledgement')
      expect(mounted.extensions.map(extension => extension.namespace).sort()).toEqual([
        'agent-snapshot-v1', 'ci-host-v1', 'ci-runtime-v1', 'computer-accounts-v1', 'computer-github-v1',
        'computer-maintenance-v2', 'computer-sync-v1', 'harness-discovery-v1', 'managed-mcp-v1', 'resource-telemetry',
      ])
      for (const namespace of ['ci-runtime-v1', 'ci-host-v1']) {
        const ci = mounted.extensions.find(extension => extension.namespace === namespace)!
        await expect(ci.handle!({ operation: 'status' }, {
          signal: AbortSignal.timeout(1000),
          binding: {
            mainId: pairing.mainId, deviceId: pairing.deviceId, workerInstallationId: pairing.workerInstallationId,
            keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(),
            connectionEpoch: randomUUID(), connectionGeneration: 1,
          },
        })).rejects.toMatchObject({ code: 'WORKER_DOMAIN_UNAVAILABLE' })
      }
    } finally {
      await mounted.close()
      await mounted.close()
    }
  })
  it('advertises the Job input client only with a Job installation and computer telemetry without one',async()=>{
    const pairing=WorkerPairingConfigurationSchema.parse({formatVersion:1,mainId:randomUUID(),deviceId:randomUUID(),workerInstallationId:randomUUID(),
      keyRevision:1,authorizationRevision:1,endpoint:'wss://unconnected.example/device/connect',mainPublicKeyFingerprint:'a'.repeat(64),credential:'b'.repeat(64),expiresAt:new Date(Date.now()+60000).toISOString()})
    const stateDirectory = await mkdtemp(join(persistentFixtureRoot, 'worker-input-client-'))
    roots.push(stateDirectory)
    const journal = await RemoteOperationJournal.open(join(stateDirectory, 'job-runtime-operations.json'),
      { initializeNewInstallation: true })
    await journal.close()
    // Metadata negotiation fixture only; original journal storage is real.
    const filesystem={device:'1',inode:'1',mountId:'1'}
    const approved=ApprovedRootAllowlistSchema.parse({schemaVersion:1,hostRef:{kind:'device',mainId:pairing.mainId,deviceId:pairing.deviceId},applicationInstallationId:pairing.workerInstallationId,
      configurationRevision:'1',bases:[{baseId:randomUUID(),canonicalPath:'/uncreated-input-client-root',filesystem,accessModes:['read-write']}],
      managedRuntimeRoot:stateDirectory,runtimeFilesystem:filesystem})
    const bootId = bootIdentity()
    const binding = { mainId: pairing.mainId, deviceId: pairing.deviceId, workerInstallationId: pairing.workerInstallationId,
      keyRevision: 1, authorizationRevision: 1, bootId, connectionEpoch: randomUUID(), connectionGeneration: 1 }
    const input={stateDirectory,pairing,bootId,configuration:null,approvedRoots:async()=>approved,
      connection:()=>({ mainNow:()=>Date.now(), currentBinding:()=>binding, captureRequest:()=>undefined }),codexSuiteRevision:'source-test-current-suite'}
    const absent=await createInstalledWorkerDomains(input)
    expect(absent.extensions.some(value=>value.namespace==='job-inputs-v1')).toBe(false)
    expect(extensionDescriptors(absent.extensions).filter(value => value.namespace === 'byte-transfer-v1'))
      .toEqual([{ namespace: 'byte-transfer-v1', version: 1, role: 'duplex', maxJsonBytes: 16384, maxBinaryBytes: 1048576 }])
    const configured=await createInstalledWorkerDomains({...input,jobConfiguration:{path:'/uncreated-job-selection.json',ownerUid:process.getuid!()}})
    expect(extensionDescriptors(configured.extensions).filter(value=>value.namespace==='job-inputs-v1')).toEqual([{namespace:'job-inputs-v1',version:1,role:'client',maxJsonBytes:1_048_576,maxBinaryBytes:8192}])
    expect(extensionDescriptors(configured.extensions).filter(value => value.namespace === 'byte-transfer-v1'))
      .toEqual([{ namespace: 'byte-transfer-v1', version: 1, role: 'duplex', maxJsonBytes: 16384, maxBinaryBytes: 1048576 }])
    expect(configured.extensions.some(value => value.namespace === resourceTelemetryExtension.namespace)).toBe(true)
    await configured.close()
    try {
      // A computer that runs only CI or agents still reports its CPU, memory and disk.
      const telemetry = absent.extensions.find(value => value.namespace === resourceTelemetryExtension.namespace)!
      const identity = { mainId: pairing.mainId, host: { hostRef: approved.hostRef, deviceId: pairing.deviceId,
        applicationInstallationId: pairing.workerInstallationId, bootId, runtimeEpoch: binding.connectionEpoch,
        keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1, collectorGeneration: 'installed-controller' } }
      const now = Date.now()
      const payload = { operation: 'collect', challenge: { schemaVersion: 1, identity, challengeId: randomUUID(),
        issuedAtUnixMs: now, freshUntilUnixMs: now + 5000 } }
      const context = { binding, signal: AbortSignal.timeout(5000) }
      const result = await telemetry.handle!(payload, context)
      const batch = TelemetryCollectedBatchSchema.parse(result.payload)
      expect(batch.identity).toEqual(identity)
      expect(batch.host?.memory).toMatchObject({ state: 'ok', value: { kind: 'host-used-estimate' } })
      if (batch.host?.memory.state !== 'ok' || !('availableBytes' in batch.host.memory.value)) throw new Error('Host memory unavailable')
      expect(batch.host.memory.value.availableBytes).toBeGreaterThan(0)
      const totalBytes = batch.host.memory.value.totalBytes
      if (totalBytes === null) throw new Error('Host memory total unavailable')
      expect(batch.host.memory.value.availableBytes).toBeLessThanOrEqual(totalBytes)
      await expect(telemetry.handle!({ ...payload, challenge: { ...payload.challenge,
        challengeId: randomUUID(), identity: { ...identity, host: { ...identity.host, bootId: randomUUID() } } } }, context))
        .rejects.toThrow()
    } finally { await absent.close() }
  })
})
