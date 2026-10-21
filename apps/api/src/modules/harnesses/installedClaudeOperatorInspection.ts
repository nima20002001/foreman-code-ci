import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { OperatorChatSetup } from '@foreman-code/contracts'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { HostHarnessConfigurationInspectionRequest } from '@foreman-code/contracts/harness-registry'
import { DomainError } from '../errors.js'
import type { InstalledWorkflowConfigurationLocation } from '../runs/remote/installedWorkflowConfiguration.js'
import { installedClaudeProfilePin } from './claudeSdk/installedProfilePin.js'
import { loadOfficialClaudeSdk } from './claudeSdk/official.js'
import { inspectClaudeOperatorConfiguration } from './claudeSdk/operatorConfigurationInspection.js'
import { runOwnedClaudeOperation } from './claudeSdk/ownedOperation.js'
import { inspectInstalledClaude, type InstalledClaudeTarget } from './installedClaudeInspection.js'
import { HarnessInstanceRegistry, localHarnessDrivers } from './instanceRegistry.js'
import { HarnessInstallationRegistry } from './installationRegistry.js'
import type { NativeProcessRegistry } from './recovery/processRegistry.js'

export function createInstalledClaudeOperatorInspection(input: {
  stateDirectory: string
  configuration: InstalledWorkflowConfigurationLocation | null
  current(): Readonly<DeviceSessionBinding>
  registry: NativeProcessRegistry
}) {
  const stopping = new AbortController()
  const flights = new Set<Promise<OperatorChatSetup>>()
  const perform = async (request: HostHarnessConfigurationInspectionRequest,
    context: { binding: Readonly<DeviceSessionBinding>; signal: AbortSignal }) => {
    const signal = AbortSignal.any([context.signal, stopping.signal])
    const connection = structuredClone(context.binding)
    const inspect = async (original?: InstalledClaudeTarget) => {
      signal.throwIfAborted()
      if (!isDeepStrictEqual(input.current(), connection)) throw new DomainError(
        'HARNESS_INVENTORY_STALE', 'The Worker configuration inspection connection changed.', 409)
      const target = (await inspectInstalledClaude({ binding: connection, configuration: input.configuration,
        environment: process.env, cwd: input.stateDirectory, signal })).currentTarget
      if (!target || !isDeepStrictEqual(target.target, request.override.target)
        || !isDeepStrictEqual(target.binding, connection) || !isDeepStrictEqual(input.current(), connection)
        || original && !isDeepStrictEqual(target.sdk, original.sdk)) {
        throw new DomainError('HARNESS_INSTALLATION_CHANGED', 'The installed Worker Claude SDK changed.', 409)
      }
      const value = request.override
      const instances = new HarnessInstanceRegistry(localHarnessDrivers)
      instances.reload([{ instanceId: value.instanceId, instanceRevision: value.instanceRevision,
        driverId: value.driverId, enabled: value.enabled, configuration: value.configuration }])
      const installations = new HarnessInstallationRegistry(instances)
      installations.refresh([target.installation])
      const selected = installations.pin({ instanceId: value.instanceId, hostRef: target.target.hostRef,
        harnessInstallationId: target.target.harnessInstallationId,
        environmentGeneration: target.installation.environmentGeneration,
        connectionGeneration: target.installation.connectionGeneration })
      const pin = installedClaudeProfilePin(value, selected, request.proof)
      return { target, accepted: { override: value, persistedProof: request.proof,
        currentBinding: { ...request.proof, instanceId: value.instanceId, pin } } }
    }
    const original = await inspect()
    const binary = original.target.installation.launcher.resolvedLauncher
    if (!binary) throw new DomainError('HARNESS_INSTALLATION_CHANGED', 'The installed Worker Claude CLI is unavailable.', 409)
    const recovery = await input.registry.reserveLaunch(`operator-configuration-inspection:${randomUUID()}`)
    return runOwnedClaudeOperation(() => inspectClaudeOperatorConfiguration({
      accepted: original.accepted, binary, workingDirectory: input.stateDirectory,
      endpoint: request.endpoint, recovery, signal,
      loadClient: (profilePath, processRecovery, selectedBinary) => loadOfficialClaudeSdk(
        profilePath, processRecovery, selectedBinary, original.target.sdk.entrypoint),
      revalidate: async () => { await inspect(original.target) },
    }), async () => {
      await input.registry.abandonReservedLaunch(recovery)
      if (!await input.registry.closeOwner(recovery.owner)) throw new DomainError(
        'CLAUDE_PROCESS_CLOSURE_PENDING', 'Claude configuration inspection has not stopped.', 409)
    })
  }
  return {
    inspect(request: HostHarnessConfigurationInspectionRequest,
      context: { binding: Readonly<DeviceSessionBinding>; signal: AbortSignal }) {
      const flight = perform(request, context)
      flights.add(flight)
      void flight.then(() => flights.delete(flight), () => flights.delete(flight))
      return flight
    },
    async close() {
      stopping.abort(new Error('Claude configuration inspections are stopping.'))
      const results = await Promise.allSettled([...flights])
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Worker Claude configuration inspections did not close.')
    },
  }
}
