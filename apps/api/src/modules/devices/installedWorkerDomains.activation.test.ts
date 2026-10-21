import { randomUUID } from 'node:crypto'
import { REMOTE_PREPARATION_EXTENSION } from '@foreman-code/contracts/remote-execution-rpc'
import { negotiateDeviceExtensions } from '@foreman-code/contracts/device-application'
import { WORKER_MCP_EXTENSION } from '@foreman-code/contracts/worker-mcp-relay'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { HostHarnessOverrideSchema, HarnessRegistryReadbackSchema } from '@foreman-code/contracts/harness-registry'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { OperatorServices } from '../../mcp/operator/types.js'
import type { PostgresAccessService } from '../access/postgres.js'
import { requireAuthorization } from '../access/policy.js'
import { buildApp } from '../../app.js'
import { DomainError } from '../errors.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { sourceFixture } from '../runs/remote/__tests__/installedWorkflowHost.js'
import { workerHarnessCatalogFixture } from '../../../test/helpers/workerHarnessCatalog.js'
import { createInstalledWorkerDomains } from './installedWorkerDomains.js'

// Native MCP files are exercised separately; domain fixtures must not touch the host user profile.
const managedMcp = vi.hoisted(() => ({ ensureReady: async (): Promise<void> => {} }))
vi.mock('../harnesses/installedWorkerManagedMcp.js', () => ({
  createInstalledWorkerManagedMcp: () => ({ worker: {}, ensureReady: () => managedMcp.ensureReady() }),
}))

it('activates first-installed workflow and profile domains on authenticated discovery with persisted MCP readback', async () => {
  const f = await sourceFixture()
  for (const name of ['workflow-operations.json', 'job-runtime-operations.json']) {
    const journal = await RemoteOperationJournal.open(join(f.root, name), { initializeNewInstallation: true })
    await journal.close()
  }
  const binding = f.context.binding
  const pairing = { formatVersion: 1 as const, mainId: binding.mainId, deviceId: binding.deviceId,
    workerInstallationId: binding.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
    endpoint: 'wss://worker.example/device/connect', mainPublicKeyFingerprint: 'a'.repeat(64),
    credential: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' }
  const location = { path: join(f.root, 'workflow-runtime.json'), ownerUid: process.getuid!() }
  const selection = { schemaVersion: 1, codexBinary: process.execPath, expectedVersion: 'codex-cli 0.162.0',
    payloadPaths: [], appMcpLauncher: '/installed/launcher.mjs' }
  const refresh = vi.fn(async () => {
    await writeFile(location.path, JSON.stringify(selection), { mode: 0o600 })
    return location
  })
  const request = vi.fn(async () => { throw new Error('Main preparation denied by fixture') })
  const mounted = await createInstalledWorkerDomains({ stateDirectory: f.root, pairing, bootId: binding.bootId,
    configuration: null, refreshWorkflowConfiguration: refresh, approvedRoots: async () => f.approvedRoots,
    connection: () => ({ currentBinding: () => binding, mainNow: () => Date.now(),
      captureRequest: () => ({ binding, request }) }), codexSuiteRevision: 'fixture-suite' })
  const principal: ManagementPrincipal = { id: 'inventory-reader', name: 'Reader', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
    grants: [{ actions: ['harnesses:read'], scope: {} }] }
  const access = { authenticate: async (token: string) => {
    if (token === 'inventory-reader') return principal
    if (token === 'denied-reader') return { ...principal, grants: [] }
    throw new DomainError('AUTH_REQUIRED', 'Authentication required.', 401)
  } } as unknown as PostgresAccessService
  const discovery = mounted.extensions.find(extension => extension.namespace === 'harness-discovery-v1')!
  const context = { binding, signal: AbortSignal.timeout(20_000) }
  const discover = { operation: 'discover', refreshId: randomUUID() }
  const get = async (caller: ManagementPrincipal) => {
    requireAuthorization(caller, 'harnesses:read')
    return (await discovery.handle!(discover, context)).payload
  }
  const services = { harnessRegistry: { get },
    commands: { recordDenied: vi.fn(async () => {}) } } as unknown as OperatorServices
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services } })
  try {
    expect(mounted.workflowAvailable).toBe(false)
    const negotiated = negotiateDeviceExtensions(
      [{ ...REMOTE_PREPARATION_EXTENSION, role: 'client' }], mounted.extensions)
    expect(negotiated).toContainEqual(expect.objectContaining({
      namespace: REMOTE_PREPARATION_EXTENSION.namespace, version: REMOTE_PREPARATION_EXTENSION.version,
      mainCanRequest: true,
    }))
    await expect(discovery.handle!(discover, { ...context, binding: { ...binding, authorizationRevision: 2 } }))
      .rejects.toMatchObject({ code: 'HARNESS_INVENTORY_STALE' })
    expect(refresh).not.toHaveBeenCalled()
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const rpc = async (token: string) => {
      const response = await fetch(new URL('/mcp', address), { method: 'POST',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream',
          'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'harness_registry_get', arguments: f.approvedRoots.hostRef } }) })
      const body = await response.text()
      const json = body.startsWith('event:')
        ? body.split('\n').find(line => line.startsWith('data: '))!.slice(6) : body
      return JSON.parse(json).result
    }
    expect((await rpc('denied-reader')).isError).toBe(true)
    expect(refresh).not.toHaveBeenCalled()
    const readback = HarnessRegistryReadbackSchema.parse(decodeMcpToolResult(await rpc('inventory-reader')))
    expect(readback.installations).toMatchObject([{ driverId: 'codex', installed: true }])
    expect(JSON.parse(await readFile(location.path, 'utf8'))).toEqual(selection)
    expect(mounted.workflowAvailable).toBe(true)
    const descriptors = mounted.extensions.map(extension => extension.namespace)
    expect(descriptors).toContain('execution-authority-v1')
    expect(mounted.extensions).toContainEqual(expect.objectContaining({
      ...WORKER_MCP_EXTENSION, role: 'client',
    }))
    const execution = mounted.extensions.find(extension => extension.namespace === 'execution-v1')!
    await expect(execution.handle!({ method: 'prepare', intent: f.intent, placement: f.placement,
      request: f.request, executionPlacement: f.nativePlacement }, context))
      .rejects.toMatchObject({ code: 'HARNESS_UNQUALIFIED' })
    const preparation = mounted.extensions.find(extension =>
      extension.namespace === REMOTE_PREPARATION_EXTENSION.namespace)!
    await expect(preparation.handle!({ method: 'prepare', intent: f.intent, placement: f.placement,
      request: f.request, executionPlacement: f.nativePlacement,
      sessionContinuation: { previousExecutionId: 'previous-execution', previousOperationId: 'previous-operation',
        session: { harness: 'codex', providerVersion: 'fixture', nativeSessionId: 'previous-session' } },
    }, context)).rejects.toMatchObject({ code: 'HARNESS_UNQUALIFIED' })
    const installation = readback.installations[0]!
    const override = HostHarnessOverrideSchema.parse({ instanceId: randomUUID(), revision: 1, instanceRevision: '1',
      target: { hostRef: f.approvedRoots.hostRef, applicationInstallationId: pairing.workerInstallationId,
        harnessInstallationId: installation.harnessInstallationId,
        installationFingerprint: 'unqualified-fixture' },
      presetId: 'local-default:codex', enabled: true, driverId: 'codex',
      configuration: { harness: 'codex', model: 'model', reasoningEffort: 'high', sandbox: 'read-only',
        serviceTier: 'standard' }, configurationFingerprint: 'profile', qualification: 'unqualified' })
    const profile = mounted.extensions.find(extension => extension.namespace === 'host-harness-check-v1')!
    await expect(profile.handle!({ checkId: randomUUID(), override }, context))
      .rejects.toMatchObject({ code: 'HARNESS_QUALIFICATION_TARGET_CHANGED' })
    await rpc('inventory-reader')
    expect(mounted.extensions.map(extension => extension.namespace)).toEqual(descriptors)
    const refreshCount = refresh.mock.calls.length
    expect((await rpc('denied-reader')).isError).toBe(true)
    expect(refresh).toHaveBeenCalledTimes(refreshCount)
    expect(mounted.workflowAvailable).toBe(true)
    expect(JSON.parse(await readFile(location.path, 'utf8'))).toEqual(selection)
  } finally {
    await app.close()
    await mounted.close()
  }
})


it('fences authenticated continuation preparation until a configured worker resumes after update', async () => {
  const f = await sourceFixture()
  for (const name of ['workflow-operations.json', 'job-runtime-operations.json']) {
    const journal = await RemoteOperationJournal.open(join(f.root, name), { initializeNewInstallation: true })
    await journal.close()
  }
  const binding = f.context.binding
  const pairing = { formatVersion: 1 as const, mainId: binding.mainId, deviceId: binding.deviceId,
    workerInstallationId: binding.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
    endpoint: 'wss://worker.example/device/connect', mainPublicKeyFingerprint: 'a'.repeat(64),
    credential: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' }
  const location = { path: join(f.root, 'workflow-runtime.json'), ownerUid: process.getuid!() }
  await writeFile(location.path, JSON.stringify({ schemaVersion: 1, codexBinary: process.execPath,
    expectedVersion: 'codex-cli 0.162.0', payloadPaths: [], appMcpLauncher: '/installed/launcher.mjs',
  }), { mode: 0o600 })
  const mounted = await createInstalledWorkerDomains({ stateDirectory: f.root, pairing, bootId: binding.bootId,
    configuration: location, approvedRoots: async () => f.approvedRoots,
    connection: () => ({ currentBinding: () => binding, mainNow: () => Date.now(), captureRequest: () => undefined }),
    codexSuiteRevision: 'fixture-suite' })
  const context = { binding, signal: AbortSignal.timeout(20_000) }
  const payload = { method: 'prepare', intent: f.intent, placement: f.placement, request: f.request,
    executionPlacement: f.nativePlacement,
    sessionContinuation: { previousExecutionId: 'previous-execution', previousOperationId: 'previous-operation',
      session: { harness: 'codex', providerVersion: 'fixture', nativeSessionId: 'previous-session' } } }
  const preparation = mounted.extensions.find(extension =>
    extension.namespace === REMOTE_PREPARATION_EXTENSION.namespace)!
  try {
    await expect(preparation.handle!(payload, context)).rejects.toMatchObject({ code: 'HARNESS_UNQUALIFIED' })
    await mounted.drainForUpdate()
    await expect(preparation.handle!(payload, context)).rejects.toMatchObject({ code: 'WORKER_RUNTIME_DRAINING' })
    mounted.resumeAfterUpdate()
    await expect(preparation.handle!(payload, context)).rejects.toMatchObject({ code: 'HARNESS_UNQUALIFIED' })
  } finally {
    await mounted.close()
  }
})

it('reports an unavailable selected installation although managed setup cannot run without it', async () => {
  const f = await sourceFixture()
  for (const name of ['workflow-operations.json', 'job-runtime-operations.json']) {
    const journal = await RemoteOperationJournal.open(join(f.root, name), { initializeNewInstallation: true })
    await journal.close()
  }
  const binding = f.context.binding
  const pairing = { formatVersion: 1 as const, mainId: binding.mainId, deviceId: binding.deviceId,
    workerInstallationId: binding.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
    endpoint: 'wss://worker.example/device/connect', mainPublicKeyFingerprint: 'a'.repeat(64),
    credential: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' }
  const location = { path: join(f.root, 'workflow-runtime.json'), ownerUid: process.getuid!() }
  const selection = { schemaVersion: 1, codexBinary: join(f.root, 'removed-codex'), expectedVersion: 'codex-cli 0.162.0',
    payloadPaths: [], appMcpLauncher: '/installed/launcher.mjs' }
  const refresh = vi.fn(async () => {
    await writeFile(location.path, JSON.stringify(selection), { mode: 0o600 })
    return location
  })
  const mounted = await createInstalledWorkerDomains({ stateDirectory: f.root, pairing, bootId: binding.bootId,
    configuration: null, refreshWorkflowConfiguration: refresh, approvedRoots: async () => f.approvedRoots,
    connection: () => ({ currentBinding: () => binding, mainNow: () => Date.now(),
      captureRequest: () => undefined }), codexSuiteRevision: 'fixture-suite' })
  const discovery = mounted.extensions.find(extension => extension.namespace === 'harness-discovery-v1')!
  managedMcp.ensureReady = async () => { throw new DomainError('HARNESS_DRIVER_UNAVAILABLE', 'The Codex executable is unavailable.', 409) }
  try {
    const { payload } = await discovery.handle!({ operation: 'discover', refreshId: randomUUID() },
      { binding, signal: AbortSignal.timeout(20_000) })
    expect(HarnessRegistryReadbackSchema.parse(payload).installations).toMatchObject([
      { driverId: 'codex', installed: false, installationFingerprint: null }])
  } finally {
    managedMcp.ensureReady = async () => {}
    await mounted.close()
  }
})

it('returns installed inventory when native MCP repair fails for a signed-out harness', async () => {
  const f = await sourceFixture()
  for (const name of ['workflow-operations.json', 'job-runtime-operations.json']) {
    const journal = await RemoteOperationJournal.open(join(f.root, name), { initializeNewInstallation: true })
    await journal.close()
  }
  const binding = f.context.binding
  const pairing = { formatVersion: 1 as const, mainId: binding.mainId, deviceId: binding.deviceId,
    workerInstallationId: binding.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
    endpoint: 'wss://worker.example/device/connect', mainPublicKeyFingerprint: 'a'.repeat(64),
    credential: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' }
  const location = { path: join(f.root, 'workflow-runtime.json'), ownerUid: process.getuid!() }
  const native = await workerHarnessCatalogFixture()
  const selection = native.selection
  const refresh = vi.fn(async () => {
    await writeFile(location.path, JSON.stringify(selection), { mode: 0o600 })
    return location
  })
  const mounted = await createInstalledWorkerDomains({ stateDirectory: f.root, pairing, bootId: binding.bootId,
    configuration: null, refreshWorkflowConfiguration: refresh, approvedRoots: async () => f.approvedRoots,
    connection: () => ({ currentBinding: () => binding, mainNow: () => Date.now(),
      captureRequest: () => undefined }), codexSuiteRevision: 'fixture-suite' })
  const discovery = mounted.extensions.find(extension => extension.namespace === 'harness-discovery-v1')!
  managedMcp.ensureReady = async () => { throw new DomainError('CODEX_SIGNED_OUT', 'Codex is signed out.', 409) }
  try {
    const { payload } = await discovery.handle!({ operation: 'discover', refreshId: randomUUID() },
      { binding, signal: AbortSignal.timeout(20_000) })
    expect(HarnessRegistryReadbackSchema.parse(payload).installations).toMatchObject([
      { driverId: 'codex', installed: true }, { driverId: 'claude', installed: true }])
  } finally {
    managedMcp.ensureReady = async () => {}
    await mounted.close()
    await native.close()
    vi.unstubAllEnvs()
  }
})
