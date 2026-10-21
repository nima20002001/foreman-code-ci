import { HostHarnessProfileEvidenceSchema, type HostHarnessOverride, type HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import { withAdvancedDefaults } from '@foreman-code/contracts'
import { commandInputHash } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import type { HostHarnessProfileQualifier } from './instanceSettings/profileChecks.js'
import { harnessHostKey } from './instanceSettings/repository.js'
import type { ProductionHarnessRegistry } from './productionRegistry.js'
import type { NativeHarnessFactories } from './runtimeFactory.js'
import { harnessProfile } from './qualification/profiles.js'
import { qualificationError } from './qualificationErrors.js'
import { requireClaudeProductionCredentialDelivery } from './claudeSdk/productionCredentials.js'
import { CLAUDE_PROFILE_CHECK_REVISION } from './claudeSdk/profileRevision.js'
import type { ProviderAccountResolver } from '../provider-accounts/service.js'
import type { DeviceRequestPriority } from '@foreman-code/contracts/device-application'

/** Explicit profile checks enter through real role-isolated adapters. A saved
 * config, filesystem inventory, worker heartbeat or fixture never grants trust. */
export class ProductionHostHarnessProfileQualifier implements HostHarnessProfileQualifier {
  constructor(private readonly registry: ProductionHarnessRegistry, private readonly factories: NativeHarnessFactories,
    private readonly endpoint: () => DeviceEndpoint, private readonly workingDirectory: string,
    private readonly claude?: HostHarnessProfileQualifier,
    private readonly workerExecution = new WorkerExecutionPolicy(), private readonly accounts?: ProviderAccountResolver) {}
  async qualify(value: HostHarnessOverride, input: {
    checkId: string; signal: AbortSignal; priority?: DeviceRequestPriority
  }): Promise<HostHarnessProfileEvidence> {
    this.workerExecution.requireEnabled(value.target.hostRef)
    input.signal.throwIfAborted()
    if (commandInputHash(withAdvancedDefaults(value.configuration)) !== value.configurationFingerprint) {
      throw new DomainError('HARNESS_CONFIGURATION_MISMATCH', 'The saved configuration fingerprint is invalid.', 409)
    }
    await requireClaudeProductionCredentialDelivery(value.configuration, this.accounts, value.target.hostRef,
      value.target.applicationInstallationId)
    const suiteRevision = value.driverId === 'claude'
      ? CLAUDE_PROFILE_CHECK_REVISION : `${value.driverId}-profile-check-v1`
    if (value.target.hostRef.kind === 'device') {
      const endpoint = this.endpoint()
      const clockReason = endpoint.clockReason(value.target.hostRef.deviceId)
      if (clockReason) throw new DomainError('WORKER_CLOCK_UNTRUSTED', clockReason, 409)
      if (!endpoint.capabilities(value.target.hostRef.deviceId).some((item) => item.namespace === 'host-harness-check-v1' && item.mainCanRequest)) {
        throw new DomainError('HARNESS_REMOTE_CHECK_UNAVAILABLE', 'The authenticated worker has no real host profile check handler.', 409)
      }
      const binding = this.registry.pinOverride(value)
      const result = await endpoint.request(value.target.hostRef.deviceId, 'host-harness-check-v1',
        { checkId: input.checkId, override: value },
        { signal: input.signal, timeoutMs: 240_000, priority: input.priority ?? 'foreground' })
      input.signal.throwIfAborted()
      this.registry.installations.assertCurrent(binding)
      const proof = HostHarnessProfileEvidenceSchema.parse(result.payload)
      if (commandInputHash(proof.target) !== commandInputHash(value.target) || proof.instanceRevision !== value.instanceRevision
        || proof.configurationFingerprint !== value.configurationFingerprint || proof.driverId !== value.driverId
        || proof.driverRevision !== binding.installation.driverRevision || proof.protocolRevision !== binding.installation.protocolRevision
        || proof.suiteRevision !== suiteRevision
        || proof.environmentGeneration !== binding.installation.environmentGeneration
        || proof.connectionGeneration !== binding.installation.connectionGeneration) {
        throw new DomainError('HARNESS_PROFILE_EVIDENCE_MISMATCH', 'Worker qualification did not match the exact authorized installation context.', 409)
      }
      return proof
    }
    await this.registry.refreshMain(input.signal)
    const binding = this.registry.pinOverride(value)
    if (harnessHostKey(binding.selection.hostRef) !== harnessHostKey(value.target.hostRef)) throw new DomainError(
      'HARNESS_PROFILE_EVIDENCE_MISMATCH', 'The native check must run on the exact selected host.', 409)
    const configuration = value.configuration
    if (configuration.harness === 'claude' && this.claude) return this.claude.qualify(value, input)
    if (configuration.harness !== 'codex') throw new DomainError(
      'HARNESS_DRIVER_UNAVAILABLE', 'This host has no qualified implementation for the selected driver.', 409)
    const allocation = this.factories.allocate({ harness: configuration.harness, role: 'qualification', selection: binding,
      configured: binding.instance, workingDirectory: this.workingDirectory,
      ownerAgentId: `profile-check:${input.checkId}`, appMcpAccess: 'none',
    })
    let authenticated: boolean | null = null
    let compatible: boolean | null = null
    let qualified = false
    let modelCatalogSource: HostHarnessProfileEvidence['modelCatalogSource']
    let failure: { code: string; message: string } | undefined
    try {
      await this.factories.admitAuxiliary(allocation.manager)
      await this.factories.assertInstallationUnchanged(binding, input.signal)
      if (allocation.harness === 'codex' && configuration.harness === 'codex') {
        const checked = await allocation.manager.qualifyConfiguration(configuration, this.workingDirectory, input.signal)
        authenticated = checked.authenticated; compatible = checked.structuredEvents
        modelCatalogSource = checked.modelCatalogSource
        qualified = checked.ready && harnessProfile('codex', checked.version) !== null
      }
      await this.factories.assertInstallationUnchanged(binding, input.signal)
      this.registry.installations.assertCurrent(binding)
    } catch (error) {
      input.signal.throwIfAborted()
      const code = error instanceof DomainError ? error.code
        : typeof error === 'object' && error && 'result' in error ? (error as { result?: { error?: { code?: string } } }).result?.error?.code : undefined
      if (!code || !/^(?:CODEX_(?:CONTRACT|SETTING|MODEL|MCP|REQUIRED_MCP|APP_SERVER_AUTH))/.test(code)) throw error
      const sanitized = qualificationError(error)
      failure = { code: sanitized.code, message: sanitized.message }
      qualified = false
      // Unknown stages remain unknown; this negative result replaces earlier trust.
    } finally { await this.factories.disposeAuxiliary(allocation.manager) }
    input.signal.throwIfAborted()
    this.registry.installations.assertCurrent(binding)
    if (!qualified && !failure) failure = { code: 'HARNESS_PROFILE_UNQUALIFIED',
      message: 'The harness did not pass authentication, protocol, model or configuration checks.' }
    return HostHarnessProfileEvidenceSchema.parse({ target: value.target, instanceRevision: value.instanceRevision,
      configurationFingerprint: value.configurationFingerprint, driverId: value.driverId,
      driverRevision: binding.installation.driverRevision, protocolRevision: binding.installation.protocolRevision,
      suiteRevision, environmentGeneration: binding.installation.environmentGeneration,
      connectionGeneration: binding.installation.connectionGeneration, authenticated, compatible, qualified, ...(failure ? { failure } : {}),
      ...(modelCatalogSource ? { modelCatalogSource } : {}), checkedAt: new Date().toISOString() })
  }
}
