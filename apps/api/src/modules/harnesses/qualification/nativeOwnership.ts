import { randomUUID } from 'node:crypto'
import type { NativeProcessRecovery, NativeProcessRegistry } from '../recovery/processRegistry.js'
import type { QualificationSuite, QualificationSuiteInput } from './types.js'

export interface NativeQualificationSuiteInput extends QualificationSuiteInput {
  processRecovery?: NativeProcessRecovery
  assertInstallation?(signal?: AbortSignal): Promise<void>
}

/** Admission belongs to the explicit qualification operation, after identity
 * validation. Its diagnostic owner cannot carry Run or application authority. */
export function withNativeQualificationOwnership(suite: QualificationSuite,
  registry: Pick<NativeProcessRegistry, 'reserveLaunch' | 'abandonReservedLaunch' | 'closeOwner'>,
  installationGuard: (input: QualificationSuiteInput) => (signal?: AbortSignal) => Promise<void>): QualificationSuite {
  return { harness: suite.harness, revision: suite.revision,
    async run(input) {
      input.signal.throwIfAborted()
      const assertInstallation = installationGuard(input)
      await assertInstallation(input.signal)
      input.signal.throwIfAborted()
      const recovery = await registry.reserveLaunch(`qualification:${suite.harness}:${randomUUID()}`)
      const close = async () => {
        await registry.abandonReservedLaunch(recovery)
        if (!await registry.closeOwner(recovery.owner)) throw new Error('Native qualification closure is unconfirmed.')
      }
      const release = input.ownCleanup?.(close)
      let active = true
      const scoped: NativeQualificationSuiteInput = { ...input, processRecovery: recovery,
        assertInstallation: async (signal) => {
          if (!active) throw new Error('Native qualification admission is closed.')
          signal?.throwIfAborted()
          await assertInstallation(signal ?? input.signal)
          signal?.throwIfAborted()
          if (!active) throw new Error('Native qualification admission is closed.')
        } }
      try {
        const result = await suite.run(scoped)
        await assertInstallation(input.signal)
        return result
      } finally {
        active = false
        await close().catch((error) => {
          throw new AggregateError([error], 'Native qualification cleanup was incomplete.')
        })
        release?.()
        input.signal.throwIfAborted()
        await assertInstallation(input.signal)
      }
    },
  }
}
