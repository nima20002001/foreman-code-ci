import { isDeepStrictEqual } from 'node:util'
import { withAdvancedDefaults } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { WorkerConversationProfileFactsSchema, workerConversationProfileSelection, type WorkerConversationBinding,
  type WorkerConversationConfiguration } from '@foreman-code/contracts/remote-execution-rpc'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { DomainError } from '../errors.js'
import { sameWorkerProfileHost } from './workerProfileTarget.js'
import type { InstalledClaudeTarget } from '../harnesses/installedClaudeInspection.js'
import { installedClaudeProfilePin } from '../harnesses/claudeSdk/installedProfilePin.js'
import { HarnessInstanceRegistry, localHarnessDrivers } from '../harnesses/instanceRegistry.js'
import { HarnessInstallationRegistry } from '../harnesses/installationRegistry.js'

export function createInstalledClaudeConversationProfile(input: {
  binding: WorkerConversationBinding
  configuration: WorkerConversationConfiguration
  connection: Readonly<DeviceSessionBinding>
  current(): Readonly<DeviceSessionBinding>
  inspect(signal: AbortSignal): Promise<{ currentTarget: InstalledClaudeTarget | null }>
  readFacts(signal: AbortSignal): Promise<unknown>
  signal: AbortSignal
}) {
  const binding = structuredClone(input.binding)
  const configuration = structuredClone(input.configuration)
  const connection = structuredClone(input.connection)
  const unavailable = (): never => { throw new DomainError('HARNESS_PROFILE_UNAVAILABLE',
    'The installed worker Claude profile changed or is unavailable.', 409) }
  return { async capture() {
    input.signal.throwIfAborted()
    const live = structuredClone(input.current())
    for (const field of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision', 'bootId'] as const) {
      if (live[field] !== connection[field]) unavailable()
    }
    const before = (await input.inspect(input.signal)).currentTarget
    const facts = WorkerConversationProfileFactsSchema.parse(await input.readFacts(input.signal))
    const after = (await input.inspect(input.signal)).currentTarget
    if (!before || !after || !isDeepStrictEqual(input.current(), live)
      || !isDeepStrictEqual(before.binding, live) || !isDeepStrictEqual(after.binding, live)
      || !isDeepStrictEqual(before.target, after.target) || !isDeepStrictEqual(after.target, facts.override.target)
      || !isDeepStrictEqual(before.installation.claudeSdk, after.installation.claudeSdk)
      || !isDeepStrictEqual(before.installation.launcher.payloadFingerprints, after.installation.launcher.payloadFingerprints)
      || !isDeepStrictEqual(facts.installation.claudeSdk, after.installation.claudeSdk)
      || !isDeepStrictEqual(facts.installation.launcher.payloadFingerprints, after.installation.launcher.payloadFingerprints)
      || configuration.harness.harness !== 'claude' || binding.harness !== 'claude'
      || commandInputHash(configuration) !== binding.owner.configurationHash
      || !isDeepStrictEqual(workerConversationProfileSelection(binding, configuration), binding.profile)
      || !sameWorkerProfileHost(binding.profile.target, facts.override.target)
      || facts.override.instanceId !== binding.profile.instanceId
      || facts.override.instanceRevision !== binding.profile.instanceRevision
      || !isDeepStrictEqual(withAdvancedDefaults(facts.override.configuration), withAdvancedDefaults(configuration.harness))) return unavailable()
    for (const field of ['driverId', 'driverRevision', 'protocolRevision', 'environmentGeneration', 'connectionGeneration'] as const) {
      if (facts.installation[field] !== after.installation[field]) unavailable()
    }
    const instances = new HarnessInstanceRegistry(localHarnessDrivers)
    instances.reload([{ instanceId: facts.override.instanceId, instanceRevision: facts.override.instanceRevision,
      driverId: 'claude', enabled: facts.override.enabled, configuration: facts.override.configuration }])
    const installations = new HarnessInstallationRegistry(instances)
    installations.refresh([after.installation])
    const selected = installations.pin({ instanceId: facts.override.instanceId, hostRef: after.target.hostRef,
      harnessInstallationId: after.target.harnessInstallationId,
      environmentGeneration: after.installation.environmentGeneration, connectionGeneration: after.installation.connectionGeneration })
    const pin = installedClaudeProfilePin(facts.override, selected, facts.profile)
    input.signal.throwIfAborted()
    return { installation: after.installation, sdk: after.sdk, accepted: { override: facts.override, persistedProof: facts.profile,
      currentBinding: { ...facts.profile, instanceId: facts.override.instanceId, pin } } }
  } }
}
