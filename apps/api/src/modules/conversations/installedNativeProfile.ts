import { isDeepStrictEqual } from 'node:util'
import { withAdvancedDefaults } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { WorkerConversationProfileFactsSchema, workerConversationProfileSelection, type WorkerConversationBinding,
  type WorkerConversationConfiguration } from '@foreman-code/contracts/remote-execution-rpc'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { HarnessQualificationRepository } from '../harnesses/qualification/repository.js'
import type { InstalledHarnessInspection } from '../harnesses/installedCodexInspection.js'
import { QUALIFICATION_TARGET_PROFILE } from '../harnesses/qualification/profiles.js'
import { DomainError } from '../errors.js'
import { sameWorkerProfileHost } from './workerProfileTarget.js'

function unavailable(): never {
  throw new DomainError('HARNESS_UNQUALIFIED', 'The selected worker profile or native installation changed.', 409)
}

/** Reads current Main facts on the admitted conversation request, without a Run or dispatch intent. */
export function createInstalledConversationNativeReader(input: {
  binding: WorkerConversationBinding
  configuration: WorkerConversationConfiguration
  connection: Readonly<DeviceSessionBinding>
  current(): Readonly<DeviceSessionBinding>
  inspect(signal: AbortSignal): Promise<InstalledHarnessInspection>
  readFacts(signal: AbortSignal): Promise<unknown>
  signal(): AbortSignal
  suiteRevision: string
}) {
  const binding = structuredClone(input.binding)
  const configuration = structuredClone(input.configuration)
  const harness = binding.harness
  if (harness !== 'codex') unavailable()
  const connection = structuredClone(input.connection)
  const capture = async () => {
    const signal = input.signal()
    signal.throwIfAborted()
    const currentConnection = structuredClone(input.current())
    for (const field of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision', 'bootId'] as const) {
      if (currentConnection[field] !== connection[field]) unavailable()
    }
    const before = (await input.inspect(signal)).currentTarget
    const facts = WorkerConversationProfileFactsSchema.parse(await input.readFacts(signal))
    const after = (await input.inspect(signal)).currentTarget
    signal.throwIfAborted()
    if (!before || !after || !isDeepStrictEqual(before.target, after.target)
      || before.binarySha256 !== after.binarySha256 || before.expectedVersion !== after.expectedVersion
      || !isDeepStrictEqual(before.installation.launcher.payloadFingerprints, after.installation.launcher.payloadFingerprints)
      || before.installation.environmentGeneration !== after.installation.environmentGeneration
      || before.installation.connectionGeneration !== after.installation.connectionGeneration
      || !isDeepStrictEqual(input.current(), currentConnection)) unavailable()
    const { override, installation, profile, qualification } = facts
    if (configuration.harness.harness !== harness
      || commandInputHash(configuration) !== binding.owner.configurationHash
      || !isDeepStrictEqual(workerConversationProfileSelection(binding, configuration), binding.profile)
      || !isDeepStrictEqual(before.binding, currentConnection)
      || !isDeepStrictEqual(after.binding, currentConnection)
      || !sameWorkerProfileHost(binding.profile.target, override.target)
      || !isDeepStrictEqual(before.target, override.target)
      || override.instanceId !== binding.profile.instanceId || override.instanceRevision !== binding.profile.instanceRevision
      || !override.enabled || override.driverId !== harness
      || !isDeepStrictEqual(withAdvancedDefaults(override.configuration), withAdvancedDefaults(configuration.harness))
      || override.configurationFingerprint !== commandInputHash(withAdvancedDefaults(configuration.harness))) unavailable()
    for (const field of ['hostRef', 'harnessInstallationId', 'installationFingerprint', 'driverId',
      'driverRevision', 'protocolRevision', 'environmentGeneration', 'connectionGeneration'] as const) {
      if (!isDeepStrictEqual(installation[field], before.installation[field])) unavailable()
    }
    if (!installation.installed || installation.launcher.status !== 'installed'
      || installation.launcher.resolvedLauncher !== before.installation.launcher.resolvedLauncher
      || installation.launcher.fingerprint !== before.target.installationFingerprint
      || !isDeepStrictEqual(installation.launcher.payloadFingerprints, before.installation.launcher.payloadFingerprints)
      || !isDeepStrictEqual(profile.target, override.target) || profile.instanceRevision !== override.instanceRevision
      || profile.configurationFingerprint !== override.configurationFingerprint || profile.suiteRevision !== `${harness}-profile-check-v1`
      || profile.authenticated !== true || profile.compatible !== true || !profile.qualified) unavailable()
    for (const field of ['driverId', 'driverRevision', 'protocolRevision', 'environmentGeneration', 'connectionGeneration'] as const) {
      if (profile[field] !== installation[field]) unavailable()
    }
    if (!qualification || qualification.harness !== harness || qualification.version !== before.expectedVersion
      || installation.observedVersion !== qualification.version || qualification.binarySha256 !== before.binarySha256
      || qualification.suiteRevision !== input.suiteRevision || qualification.status !== 'qualified'
      || qualification.profile !== QUALIFICATION_TARGET_PROFILE[harness] || !qualification.checkedAt
      || !qualification.checks.length || qualification.checks.some(check => !check.passed)) unavailable()
    return { inspection: before, qualification }
  }
  const repository: Pick<HarnessQualificationRepository, 'find' | 'list'> = {
    async list() { return [(await capture()).qualification] },
    async find(harness, version, binarySha256, suiteRevision) {
      const record = (await capture()).qualification
      return record.harness === harness && record.version === version && record.binarySha256 === binarySha256
        && record.suiteRevision === suiteRevision ? record : null
    },
  }
  return { capture, repository }
}
