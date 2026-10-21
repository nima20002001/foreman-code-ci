import { type ProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import type { ProviderAccountResolver } from '../provider-accounts/service.js'
import { readInstalledWorkerAccountBinding } from './installedWorkerAccountBinding.js'
import { pinnedCodexAccountEnvironment } from './providerAccountRuntime.js'
import { isDeepStrictEqual } from 'node:util'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { WorkerPairingConfiguration } from '@foreman-code/contracts/device-identity'
import { DomainError } from '../errors.js'
import { installedHarnessSelection, readInstalledWorkflowConfiguration, type InstalledWorkflowConfigurationLocation } from '../runs/remote/installedWorkflowConfiguration.js'
import { CodexAppServerSessionManager, safeEnvironment } from './codexAppServer.js'
import { qualifyCodex, assertCodexUnchanged } from './codexProtocol.js'
import { qualifyNativeCodexModel } from './codexQualification.js'
import { runCommand } from './process.js'
import { createHostHarnessProfileCheckExtension } from './instanceSettings/profileChannel.js'
import { inspectInstalledCodex } from './installedCodexInspection.js'
import { createInstalledNativeQualifier } from './installedNativeQualification.js'
import type { NativeProcessRegistry } from './recovery/processRegistry.js'
import { createInstalledClaudeQualifier } from './installedClaudeQualification.js'
import { createInstalledClaudeOperatorInspection } from './installedClaudeOperatorInspection.js'
import { createInstalledWorkerHarnessOptions } from './installedWorkerHarnessOptions.js'
import { PayloadFingerprintCache } from './payloadFingerprintCache.js'

export async function createInstalledWorkerProfileChecks(input: {
  stateDirectory: string
  configuration: InstalledWorkflowConfigurationLocation | null
  pairing: WorkerPairingConfiguration
  current(): Readonly<DeviceSessionBinding>
  registry: NativeProcessRegistry
  accounts?: () => ProviderAccountResolver | undefined
}) {
  const configuration = await readInstalledWorkflowConfiguration(input.configuration)
  if (!configuration) return null
  const payloadFingerprints = new PayloadFingerprintCache()
  const qualifiers = new Set<ReturnType<typeof createInstalledNativeQualifier>>()
  const claude = createInstalledClaudeQualifier(input)
  const claudeInspection = createInstalledClaudeOperatorInspection(input)
  const options = createInstalledWorkerHarnessOptions(input)
  let closing = false
  const extension = createHostHarnessProfileCheckExtension({
    hostRef: { kind: 'device', mainId: input.pairing.mainId, deviceId: input.pairing.deviceId },
    applicationInstallationId: input.pairing.workerInstallationId,
    discoverOptions: (request, context) => options.discover(request, context),
    inspectConfiguration: async (request, context) => {
      if (closing) throw new DomainError('HARNESS_INVENTORY_STALE', 'Worker configuration inspections are stopping.', 409)
      return claudeInspection.inspect(request, context)
    },
    qualifierForBinding: binding => ({ async qualify(value, request) {
      if (closing || !isDeepStrictEqual(input.current(), binding)) {
        throw new DomainError('HARNESS_INVENTORY_STALE', 'The profile check connection changed.', 409)
      }
      const harness = value.configuration.harness
      if (harness === 'claude') return claude.qualify(value, request)
      if (harness !== 'codex') throw new DomainError(
        'HARNESS_DRIVER_UNAVAILABLE', 'The installed native profile checker does not support this driver.', 409)
      const accountId = value.configuration.accountId
      const accounts = input.accounts?.()
      let accountBinding: ProviderAccountBinding | undefined
      if (accountId) {
        if (!accounts) throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE',
          'The selected Worker account resolver is unavailable.', 409)
        accountBinding = readInstalledWorkerAccountBinding({ ...input, provider: 'codex', accountId })
      }
      const accountEnvironment = pinnedCodexAccountEnvironment(accounts, accountId,
        undefined, undefined, accountBinding)
      await accountEnvironment.prepare()
      const environment = accountEnvironment.environment(process.env)
      const qualifier = createInstalledNativeQualifier({ harness,
        binding, trustedCurrentBinding: input.current,
        inspect: (current, signal) => inspectInstalledCodex({ binding: current,
          configuration: input.configuration, environment, cwd: input.stateDirectory, signal,
          fingerprintCache: payloadFingerprints }),
        registry: input.registry, workingRoot: input.stateDirectory, environment,
        checkConfiguration: async (profile, directory, signal, recovery, assertInstallation) => {
          const guarded = async <T>(work: () => Promise<T>, effectSignal = signal): Promise<T> => {
            await accountEnvironment.revalidate()
            await assertInstallation(effectSignal)
            const result = await work()
            await accountEnvironment.revalidate()
            await assertInstallation(effectSignal)
            return result
          }
          if (profile.configuration.harness !== 'codex') throw new DomainError('HARNESS_DRIVER_UNAVAILABLE',
            'The selected driver has no installed profile checker.', 409)
          const selected = await guarded(() => readInstalledWorkflowConfiguration(input.configuration))
          const codex = selected && installedHarnessSelection(selected)
          if (!codex) throw new DomainError('HARNESS_DRIVER_UNAVAILABLE', 'The installed Codex selection is missing.', 409)
          const manager = new CodexAppServerSessionManager(codex.binary, codex.expectedVersion,
            undefined, recovery, 'none', undefined, {
              mode: 'native',
              environment: (variables, names) => accountEnvironment.environment(safeEnvironment(variables, names)),
              qualify: (binary, cwd, environment, authenticated, effectSignal) => guarded(
                () => qualifyCodex(binary, cwd, environment, authenticated, effectSignal, recovery), effectSignal),
              assertUnchanged: qualified => guarded(() => assertCodexUnchanged(qualified)),
              runCommand: (binary, args, cwd, effectSignal, environment, options) => guarded(
                () => runCommand(binary, args, cwd, effectSignal, environment, { ...options, recovery }), effectSignal),
              qualifyModel: (settings, binary, cwd, environment, effectSignal, _recovery, inspection) => guarded(
                () => qualifyNativeCodexModel(settings, binary, cwd, environment, effectSignal, recovery, inspection), effectSignal),
            })
          try {
            return await manager.qualifyConfiguration(profile.configuration, directory, signal)
          } finally {
            await manager.dispose()
          }
        },
      })
      qualifiers.add(qualifier)
      try {
        return await qualifier.qualify(value, request)
      } finally {
        await qualifier.close()
        qualifiers.delete(qualifier)
      }
    } }),
  })
  return { extension, async close() {
    closing = true
    const results = await Promise.allSettled([
      options.close(), claude.close(), claudeInspection.close(), ...[...qualifiers].map(qualifier => qualifier.close()),
    ])
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Worker profile checks did not close.')
  } }
}
