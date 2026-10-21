import { CompatibilityCheckError } from './errors.js'
import { randomUUID } from 'node:crypto'
import type { CompatibilityHarness } from '@foreman-code/contracts'
import type { NativeProcessRegistry, NativeProcessRecovery } from '../recovery/processRegistry.js'
import type { RegistryHarnessSelection } from '../installationRegistry.js'
import { nativeCompatibilityProbe, type CompatibilityProbe, type HarnessInstallation } from './probe.js'

interface OwnedProbe {
  harness: CompatibilityHarness
  recovery: NativeProcessRecovery
  controller: AbortController
  admitted: boolean
  probe: CompatibilityProbe
  task?: Promise<unknown>
  cleanup?: Promise<void> | undefined
}

/** Every native operation receives a fresh diagnostic owner. A cache hit and
 * synchronous allocation never reserve or dispatch a native process. */
export function scopedCompatibilityProbe(options: {
  registry: Pick<NativeProcessRegistry, 'scope' | 'reserveLaunch' | 'abandonReservedLaunch' | 'closeOwner'>
  pin(harness: CompatibilityHarness): RegistryHarnessSelection
  assertInstallation(binding: RegistryHarnessSelection, signal?: AbortSignal): Promise<void>
  workingDirectory: string
  environment?: NodeJS.ProcessEnv
  timeoutMs?: number
  nativeProbe?: typeof nativeCompatibilityProbe
}): CompatibilityProbe {
  const owned = new Set<OwnedProbe>()
  const blocked = new Set<CompatibilityHarness>()
  const installations = new WeakMap<HarnessInstallation, { harness: CompatibilityHarness; binding: RegistryHarnessSelection }>()
  let closing = false
  const assertOpen = () => { if (closing) throw new Error('Native compatibility diagnostics are shutting down.') }
  const cleanup = (record: OwnedProbe): Promise<void> => {
    if (record.cleanup) return record.cleanup
    const attempt = (async () => {
      record.controller.abort(new Error('Native compatibility cleanup'))
      await record.probe.close?.()
      if (record.admitted) {
        await options.registry.abandonReservedLaunch(record.recovery)
        if (!await options.registry.closeOwner(record.recovery.owner)) throw new Error('Native compatibility closure is unconfirmed.')
      }
      owned.delete(record)
      if (![...owned].some((value) => value.harness === record.harness)) blocked.delete(record.harness)
    })()
    record.cleanup = attempt
    void attempt.catch(() => { blocked.add(record.harness); if (record.cleanup === attempt) record.cleanup = undefined })
    return attempt
  }
  const run = <T>(harness: CompatibilityHarness, binding: RegistryHarnessSelection, signal: AbortSignal,
    work: (probe: CompatibilityProbe, signal: AbortSignal) => Promise<T>): Promise<T> => {
    assertOpen(); signal.throwIfAborted()
    if (blocked.has(harness)) throw new CompatibilityCheckError('CLI_CLEANUP_FAILED', 'Prior diagnostic native ownership remains uncertain.')
    const recovery = options.registry.scope(`diagnostics:compatibility:${harness}:${randomUUID()}`)
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal])
    const launcher = binding.installation.launcher.resolvedLauncher
    if (!launcher) throw new Error('The selected diagnostic launcher is unavailable.')
    const record: OwnedProbe = { harness, recovery, controller, admitted: false,
      probe: (options.nativeProbe ?? nativeCompatibilityProbe)({ codex: launcher },
        options.workingDirectory, options.environment ?? process.env, options.timeoutMs ?? 2000, {
          recovery,
          async beforeCommand(binary, commandSignal) {
            assertOpen(); combined.throwIfAborted(); commandSignal.throwIfAborted()
            if (binary !== launcher && binary !== process.execPath) throw new Error('Diagnostics cannot substitute another launcher.')
            await options.assertInstallation(binding, commandSignal)
            assertOpen(); combined.throwIfAborted(); commandSignal.throwIfAborted()
            if (!record.admitted) {
              Object.assign(recovery, await options.registry.reserveLaunch(recovery.owner))
              record.admitted = true
            }
          },
        }),
    }
    owned.add(record)
    const task = (async () => {
      try {
        await options.assertInstallation(binding, combined)
        assertOpen(); combined.throwIfAborted()
        return await work(record.probe, combined)
      } finally {
        await cleanup(record).catch((error) => { throw new AggregateError([error], 'Native compatibility cleanup is uncertain.') })
        assertOpen(); signal.throwIfAborted()
        await options.assertInstallation(binding, signal)
      }
    })()
    record.task = task
    return task
  }
  const selected = (harness: CompatibilityHarness, installation: HarnessInstallation) => {
    const original = installations.get(installation)
    if (!original || original.harness !== harness) throw new Error('Compatibility requires its original inspected installation.')
    return original.binding
  }
  return {
    inspect(harness, signal, attempt) {
      const binding = options.pin(harness)
      return run(harness, binding, signal, async (probe, combined) => {
        const result = await probe.inspect(harness, combined, attempt)
        result.installationFingerprint = binding.selection.installationFingerprint
        installations.set(result, { harness, binding })
        return result
      })
    },
    probe(harness, installation, signal) {
      return run(harness, selected(harness, installation), signal, (probe, combined) => probe.probe(harness, installation, combined))
    },
    async assertUnchanged(installation, signal) {
      const original = installations.get(installation)
      if (!original) throw new Error('Compatibility requires its original inspected installation.')
      await run(original.harness, original.binding, signal, (probe, combined) => probe.assertUnchanged(installation, combined))
    },
    async close() {
      closing = true
      for (const record of owned) record.controller.abort(new Error('Native compatibility diagnostics are shutting down.'))
      await Promise.allSettled([...owned].map((record) => record.task))
      const results = await Promise.allSettled([...owned].map(cleanup))
      const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Native compatibility cleanup is uncertain.')
    },
  }
}
