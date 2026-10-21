
import { describe, expect, it, vi } from 'vitest'
import { withAdvancedDefaults } from '@foreman-code/contracts'
import type { HostHarnessOverride, HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { commandInputHash } from '../src/modules/commands/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'
import { nativeQualification } from '../src/modules/harnesses/nativeQualification.js'
import { ProductionHostHarnessProfileQualifier } from '../src/modules/harnesses/productionProfileQualifier.js'
import { HostHarnessInstanceProfileChecks } from '../src/modules/harnesses/instanceSettings/profileChecks.js'
import { HostHarnessOverrideService } from '../src/modules/harnesses/instanceSettings/service.js'
import { fixtureProtocol } from './fixtures/codex-test-helpers.js'
import { CLAUDE_PROFILE_CHECK_REVISION } from '../src/modules/harnesses/claudeSdk/profileRevision.js'
import { WorkerExecutionPolicy } from '../src/modules/settings/workerExecution.js'

function fixture() {
  const configuration = withAdvancedDefaults({ harness: 'codex', model: 'selected-model', reasoningEffort: 'high', sandbox: 'read-only', serviceTier: 'priority' })
  const mainId = '00000000-0000-4000-8000-000000000001'
  const value: HostHarnessOverride = { instanceId: mainId, revision: 1, instanceRevision: '1',
    target: { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
      harnessInstallationId: 'installation', installationFingerprint: 'fingerprint' },
    presetId: 'local-default:codex', enabled: true, driverId: 'codex', configuration,
    configurationFingerprint: commandInputHash(configuration), qualification: 'qualified' }
  const native = vi.fn(async () => ({ binary: '/recorded-codex', identity: 'identity', protocol: fixtureProtocol,
    providerVersion: '0.156.1', schemaManifestSha256: 'schema', stableSchemaGitBlob: 'stable', referenceSchemaManifestSha256: 'reference' }))
  const model = vi.fn(async () => undefined)
  const manager = new CodexAppServerSessionManager('/recorded-codex', undefined, undefined, undefined, 'none', undefined,
    { mode: 'native', environment: () => ({}), qualify: native, qualifyModel: model })
  const binding = { selection: value.target, instance: {}, installation: { driverRevision: 'driver', protocolRevision: 'protocol',
    environmentGeneration: 'environment', connectionGeneration: 'connection' } }
  const current = vi.fn(() => undefined)
  const registry = { refreshMain: vi.fn(async () => undefined), pinOverride: () => binding, installations: { assertCurrent: current } }
  const dispose = vi.fn(async () => manager.dispose())
  const unchanged = vi.fn(async () => undefined)
  const factories = { allocate: () => ({ harness: 'codex', manager }), admitAuxiliary: vi.fn(),
    assertInstallationUnchanged: unchanged, disposeAuxiliary: dispose }
  const qualifier = new ProductionHostHarnessProfileQualifier(registry as never, factories as never,
    () => { throw new Error('Local check must not request a worker.') }, '/recorded-workspace')
  const signal = new AbortController()
  return { qualifier, value, native, model, manager, dispose, unchanged, current, signal,
    check: () => qualifier.qualify(value, { checkId: mainId, signal: signal.signal }) }
}

describe('production exact-host profile failure evidence', () => {
  it.each(['CODEX_MODEL_UNAVAILABLE', 'CODEX_SETTING_UNSUPPORTED'])('keeps %s as a sanitized negative result without inventing stage failures', async code => {
    const f = fixture()
    f.model.mockRejectedValue(new HarnessExecutionError(code, 'Native detail contains credential=secret'))
    const proof = await f.check()
    // The real manager completed its auth/protocol boundary before rejecting model settings.
    expect(f.native).toHaveBeenCalledTimes(1); expect(f.model).toHaveBeenCalledTimes(1)
    expect(proof).toMatchObject({ authenticated: null, compatible: null, qualified: false,
      failure: { code, message: code === 'CODEX_MODEL_UNAVAILABLE'
        ? 'The selected model is absent from the native Codex catalog. Refresh the catalog and review this selection.'
        : 'The native harness does not support this model, effort, or setting combination.' }, target: f.value.target,
      configurationFingerprint: f.value.configurationFingerprint })
    expect(JSON.stringify(proof)).not.toContain('credential=secret')
    expect(f.dispose).toHaveBeenCalledTimes(1)
  })

  it('preserves explicitly returned successful auth/protocol facts when readiness fails', async () => {
    const f = fixture()
    vi.spyOn(f.manager, 'qualifyConfiguration').mockResolvedValue({ ...nativeQualification(f.value.configuration, '0.156.1'), ready: false })
    expect(await f.check()).toMatchObject({ authenticated: true, compatible: true, qualified: false })
    expect(f.dispose).toHaveBeenCalledTimes(1)
  })

  it('persists the negative result and invalidates previous positive readback through the shared MCP service', async () => {
    const f = fixture()
    const principal: ManagementPrincipal = { id: 'writer', name: 'Writer', audience: 'operator', revokedAt: null,
      expiresAt: '9999-12-31T00:00:00.000Z', grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }] }
    let latest = await fixture().check()
    const client = { query: vi.fn(async () => undefined) }
    const settings = { latest: async () => f.value, lockRevision: async () => undefined, list: async () => [f.value],
      readAuthorized: async (work: (client: unknown) => Promise<unknown>) => work(client) }
    const proofs = {
      latest: async () => latest,
      findCheck: async () => null,
      append: vi.fn(async (_client: unknown, _id: string, _value: HostHarnessOverride, proof: typeof latest) => {
        latest = proof
      }),
    }
    const commands = { execute: async (command: { authorize: (client: unknown) => Promise<void>; perform: (client: unknown) => Promise<unknown> }) => {
      await command.authorize(client); return { value: await command.perform(client), replayed: false }
    }, recordDenied: vi.fn(async () => undefined) }
    const authority = { authorize: vi.fn(async () => undefined) }
    const checks = new HostHarnessInstanceProfileChecks(settings as never, proofs as never, commands as never, authority, f.qualifier)
    const service = new HostHarnessOverrideService(settings as never, commands as never, authority, async () => latest, checks)
    const scope = { hostRef: f.value.target.hostRef, applicationInstallationId: f.value.target.applicationInstallationId }
    expect((await service.list(principal, scope, 'mcp')).overrides[0]?.qualification).toBe('qualified')
    f.model.mockRejectedValue(new HarnessExecutionError('CODEX_MODEL_UNAVAILABLE', 'Native secret'))
    const result = await service.check(principal, 'mcp', { commandId: f.value.instanceId, instanceId: f.value.instanceId,
      expectedRevision: f.value.revision, target: f.value.target })
    expect(result.value.qualification).toBe('unqualified')
    expect(result.proof).toMatchObject({ authenticated: null, compatible: null, qualified: false,
      failure: { code: 'CODEX_MODEL_UNAVAILABLE', message: 'The selected model is absent from the native Codex catalog. Refresh the catalog and review this selection.' } })
    expect(proofs.append).toHaveBeenCalledTimes(1)
    expect((await service.list(principal, scope, 'mcp')).overrides[0]).toMatchObject({
      qualification: 'unqualified', qualificationFailure: result.proof.failure,
    })
    await expect(service.check({ ...principal, grants: [{ actions: ['harnesses:read'], scope: {} }] }, 'mcp',
      { commandId: f.value.instanceId, instanceId: f.value.instanceId, expectedRevision: f.value.revision, target: f.value.target })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(proofs.append).toHaveBeenCalledTimes(1)
    await service.closeChecks()
  })

  it('does not turn cancellation or stale installation into a persistable profile result', async () => {
    for (const cancelled of [true, false]) {
      const f = fixture()
      if (cancelled) f.model.mockImplementation(async () => {
        f.signal.abort(new DOMException('Stopping.', 'AbortError')); throw f.signal.signal.reason
      })
      else f.unchanged.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new DomainError('HARNESS_INVENTORY_STALE', 'Installation changed.', 409))
      await expect(f.check()).rejects.toMatchObject(cancelled ? { name: 'AbortError' } : { code: 'HARNESS_INVENTORY_STALE' })
      expect(f.dispose).toHaveBeenCalledTimes(1)
    }
  })
})

it('accepts the current Worker Claude qualification revision and rejects older proofs', async () => {
  const f = fixture()
  const configuration = withAdvancedDefaults({ harness: 'claude', model: 'recorded-model', authMode: 'subscription',
    configDirectory: '/recorded/profile', permissionMode: 'default', sandbox: 'danger-full-access',
    tools: ['Write'], permissionRules: [], instructions: '', mcpServers: {} })
  const value: HostHarnessOverride = { ...f.value, driverId: 'claude', configuration,
    configurationFingerprint: commandInputHash(configuration), target: { ...f.value.target,
      hostRef: { kind: 'device', mainId: f.value.instanceId, deviceId: f.value.instanceId } } }
  const installation = { driverRevision: 'driver', protocolRevision: 'protocol',
    environmentGeneration: 'environment', connectionGeneration: 'connection' }
  const proof: HostHarnessProfileEvidence = { ...installation, target: value.target,
    instanceRevision: value.instanceRevision, configurationFingerprint: value.configurationFingerprint,
    driverId: 'claude', suiteRevision: CLAUDE_PROFILE_CHECK_REVISION, authenticated: true, compatible: true,
    qualified: true, checkedAt: new Date().toISOString() }
  const registry = { pinOverride: () => ({ installation }), installations: { assertCurrent: f.current } }
  let clockReason: string | null = null
  const endpoint = { clockReason: () => clockReason,
    capabilities: () => [{ namespace: 'host-harness-check-v1', mainCanRequest: true }],
    request: vi.fn(async () => ({ payload: proof })) }
  const qualifier = new ProductionHostHarnessProfileQualifier(registry as never, {} as never,
    () => endpoint as never, '/recorded-workspace', undefined,
    new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }))
  const input = { checkId: f.value.instanceId, signal: f.signal.signal }
  expect(await qualifier.qualify(value, input)).toEqual(proof)
  clockReason = 'Worker clock differs from Main by more than 2 minutes.'
  await expect(qualifier.qualify(value, input)).rejects.toMatchObject({ code: 'WORKER_CLOCK_UNTRUSTED' })
  expect(endpoint.request).toHaveBeenCalledTimes(1)
  clockReason = null
  for (const revision of ['claude-profile-check-v1', 'claude-profile-check-v2']) {
    proof.suiteRevision = revision
    await expect(qualifier.qualify(value, input)).rejects.toMatchObject({ code: 'HARNESS_PROFILE_EVIDENCE_MISMATCH' })
  }
})
