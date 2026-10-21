import { withAdvancedDefaults } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { DeviceSessionBindingSchema, type DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DispatchIntent, AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import { ExecutionFactsResultSchema } from '@foreman-code/contracts/execution-authority'
import type { HarnessQualificationRepository } from './qualification/repository.js'
import { HarnessQualificationSchema } from '@foreman-code/contracts/harness-qualification'
import { QUALIFICATION_TARGET_PROFILE } from './qualification/profiles.js'
import { DomainError } from '../errors.js'
import { sameDeviceInstallation } from '../devices/deviceReconnect.js'
import type { InstalledHarnessInspection } from './installedCodexInspection.js'

const unavailable = (): never => { throw new DomainError('HARNESS_UNQUALIFIED', 'Current authenticated Main proof and installed harness identity are required.', 409) }
const same = (left: unknown, right: unknown) => commandInputHash(left) === commandInputHash(right)

/** This capability is constructed by the installed host from actual W07 read
 * callbacks. It accepts no stored proof/config JSON and has no durable ledger. */
export function createInstalledCodexQualificationReader(input: {
  intent: DispatchIntent
  placement: AcceptedNodePlacement
  trustedCurrentBinding(): Readonly<DeviceSessionBinding> | null
  trustedCurrentIntent?(): DispatchIntent
  inspect(binding: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<InstalledHarnessInspection>
  readFacts(signal: AbortSignal): Promise<unknown>
  assertResident?(original: Readonly<DeviceSessionBinding>, current: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<void>
  suiteRevision: string
  signal: AbortSignal
}) {
  const harness = 'codex'
  const initial = input.trustedCurrentBinding()
  const originalBinding = initial ? DeviceSessionBindingSchema.parse(initial) : null
  // A reconnected session of the same Worker boot keeps the harness facts this operation was admitted under.
  const verifyBinding = (binding: Readonly<DeviceSessionBinding>) => {
    if (!originalBinding || !sameDeviceInstallation(binding, originalBinding)) return unavailable()
  }
  const originalIntent = structuredClone(input.intent), originalPlacement = structuredClone(input.placement)
  let retainedInspection: InstalledHarnessInspection | undefined
  const inspect = async (binding: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<InstalledHarnessInspection> => {
    const current = await input.inspect(binding, signal)
    const payload = originalPlacement.payload
    if (payload.kind !== 'agent' || current.currentTarget?.target.installationFingerprint === payload.installationFingerprint) {
      return current
    }
    if (!retainedInspection || !input.assertResident || !originalBinding) return unavailable()
    const old = retainedInspection.currentTarget
    const updated = current.currentTarget
    if (!old || !updated || old.installation.environmentGeneration !== updated.installation.environmentGeneration
      || old.installation.driverRevision !== updated.installation.driverRevision
      || old.installation.protocolRevision !== updated.installation.protocolRevision
      || !same(old.target.hostRef, updated.target.hostRef)
      || old.target.applicationInstallationId !== updated.target.applicationInstallationId) return unavailable()
    await input.assertResident(originalBinding, binding, signal)
    const retained = structuredClone(retainedInspection)
    if (!retained.currentTarget) return unavailable()
    return { ...retained, currentTarget: { ...retained.currentTarget, binding: { ...binding } } }
  }
  const capture = async (effectSignal?: AbortSignal) => {
    const signal = effectSignal ? AbortSignal.any([input.signal, effectSignal]) : input.signal
    signal.throwIfAborted()
    const expectedIntent = structuredClone(input.trustedCurrentIntent?.() ?? originalIntent)
    if (!same({ ...expectedIntent, owner: originalIntent.owner }, originalIntent)) return unavailable()
    const live = input.trustedCurrentBinding()
    if (!live || !originalBinding) return unavailable()
    const binding = DeviceSessionBindingSchema.parse(live)
    verifyBinding(binding)
    const inspection = await inspect(binding, signal)
    const current = inspection.currentTarget
    if (!current || !same(current.binding, binding)) return unavailable()
    const facts = ExecutionFactsResultSchema.parse(await input.readFacts(signal))
    signal.throwIfAborted()
    const afterBinding = input.trustedCurrentBinding()
    if (!afterBinding || !same(afterBinding, binding) || !same(facts.intent, expectedIntent) || !same(facts.placement, originalPlacement)) return unavailable()
    const after = (await inspect(binding, signal)).currentTarget
    signal.throwIfAborted()
    const finalBinding = input.trustedCurrentBinding()
    if (!finalBinding || !same(finalBinding, binding) || !after || !same(after.binding, binding)
      || !same(after.target, current.target) || after.binarySha256 !== current.binarySha256
      || after.expectedVersion !== current.expectedVersion || after.installation.environmentGeneration !== current.installation.environmentGeneration
      || after.installation.connectionGeneration !== current.installation.connectionGeneration
      || !same(after.installation.launcher.payloadFingerprints, current.installation.launcher.payloadFingerprints)) return unavailable()
    const { installation, override, profileProof, qualification } = facts.harness
    const placement = facts.placement
    if (placement.hostRef.kind !== 'device' || !placement.registration || placement.payload.kind !== 'agent'
      || binding.mainId !== placement.mainId || binding.deviceId !== placement.hostRef.deviceId
      || binding.workerInstallationId !== placement.registration.workerInstallationId
      || binding.keyRevision !== placement.registration.keyRevision || binding.authorizationRevision !== placement.registration.authorizationRevision
      || !same(installation.hostRef, current.target.hostRef) || !same(override.target, current.target)
      || installation.harnessInstallationId !== current.target.harnessInstallationId
      || installation.installationFingerprint !== current.target.installationFingerprint
      || installation.driverId !== harness || !installation.installed || installation.launcher.status !== 'installed'
      || installation.driverRevision !== current.installation.driverRevision || installation.protocolRevision !== current.installation.protocolRevision
      || installation.environmentGeneration !== current.installation.environmentGeneration
      || installation.connectionGeneration !== current.installation.connectionGeneration
      || installation.launcher.resolvedLauncher !== current.installation.launcher.resolvedLauncher
      || installation.launcher.fingerprint !== current.target.installationFingerprint
      || !same(installation.launcher.payloadFingerprints, current.installation.launcher.payloadFingerprints)
      || !override.enabled || override.driverId !== harness || override.configuration.harness !== harness
      || override.instanceId !== placement.payload.instanceId || override.instanceRevision !== placement.payload.instanceRevision
      || placement.payload.harnessInstallationId !== current.target.harnessInstallationId
      || placement.payload.installationFingerprint !== current.target.installationFingerprint
      || placement.payload.driverId !== installation.driverId || placement.payload.driverRevision !== installation.driverRevision
      || placement.payload.protocolRevision !== installation.protocolRevision
      || !same(profileProof.target, current.target) || profileProof.instanceRevision !== override.instanceRevision
      || profileProof.configurationFingerprint !== override.configurationFingerprint
      || override.configurationFingerprint !== commandInputHash(withAdvancedDefaults(override.configuration))
      || facts.configuration.harness.harness !== harness || !same(withAdvancedDefaults(facts.configuration.harness), withAdvancedDefaults(override.configuration))
      || profileProof.driverId !== harness || profileProof.driverRevision !== installation.driverRevision
      || profileProof.protocolRevision !== installation.protocolRevision || profileProof.suiteRevision !== `${harness}-profile-check-v1`
      || profileProof.environmentGeneration !== installation.environmentGeneration
      || profileProof.connectionGeneration !== installation.connectionGeneration
      || profileProof.authenticated !== true || profileProof.compatible !== true || !profileProof.qualified
      || qualification.harness !== harness || installation.observedVersion !== qualification.version
      || qualification.binarySha256 !== current.binarySha256 || qualification.suiteRevision !== input.suiteRevision
      || qualification.status !== 'qualified' || qualification.profile !== QUALIFICATION_TARGET_PROFILE[harness]
      || !qualification.checkedAt || !qualification.checks.length || qualification.checks.some(check => !check.passed)) return unavailable()
    // Correlated facts come from the existing W08 RPC reader; preserve the exact
    // accepted operation/attempt rather than turning this into a free-standing permit.
    if (facts.intent.mainId !== binding.mainId || facts.intent.bindingHash !== placement.bindingHash
      || facts.executionPlacement.acceptedBindingHash !== placement.bindingHash
      || facts.executionPlacement.executionId !== facts.intent.executionId || facts.executionPlacement.attemptId !== facts.intent.attemptId
      || facts.executionPlacement.operationId !== facts.intent.operationId
      || facts.configuration.id !== placement.payload.agentConfigurationVersionId || facts.configuration.agentId !== placement.payload.agentId) return unavailable()
    verifyBinding(binding)
    if (!same(input.trustedCurrentBinding(), binding)
      || !same(input.trustedCurrentIntent?.() ?? originalIntent, expectedIntent)) return unavailable()
    retainedInspection ??= structuredClone(inspection)
    return Object.freeze({ binding: Object.freeze(binding), inspection, facts,
      qualification: HarnessQualificationSchema.parse(qualification) })
  }
  const repository: Pick<HarnessQualificationRepository, 'find' | 'list'> = {
    async list() { return [structuredClone((await capture()).qualification)] },
    async find(harness, version, binarySha256, suiteRevision) {
      const proof = (await capture()).qualification
      return proof.harness === harness && proof.version === version && proof.binarySha256 === binarySha256 && proof.suiteRevision === suiteRevision
        ? structuredClone(proof) : null
    },
  }
  return Object.freeze({ capture, repository: Object.freeze(repository) })
}
