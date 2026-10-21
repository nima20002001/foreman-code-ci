import { isDeepStrictEqual } from 'node:util'
import type { CodexNativeOutputs, CodexNativeOutputQualificationInput, CodexNativeOutputTurnPin,
  CodexNativeOutputCallback } from '../../harnesses/codexNativeOutput.js'
import { sameCodexNativeOutputSandbox } from '../../harnesses/codexNativeOutput.js'
import type { TemporaryFileScope } from '@foreman-code/contracts/files'
import { TemporaryFileScopeSchema } from '@foreman-code/contracts/files'
import type { WorkerNativeOutputCommand } from '@foreman-code/contracts/worker-native-output'
import type { ByteTransferPort } from '@foreman-code/contracts/byte-transfer'
import type { TransferSenderConnection } from '../../byte-transfer/sender.js'
import { WorkerNativeOutputRegistry } from './workerNativeOutputRegistry.js'
import { WorkerNativeArtifactSender, type WorkerNativeArtifactBinding,
  type WorkerNativeArtifactApplication } from './workerNativeArtifactSender.js'
import { createInstalledNativeOutputStorage, assertNativeOutputRootExcluded,
  type InstalledNativeOutputStorageInput } from './installedNativeOutputStorage.js'
import { DomainError } from '../../errors.js'

export interface InstalledNativeOutputProviders {
  /** Checks actual installed proof, original grants and available durable budget
   * before declarations. Expected policy alone never qualifies a producer. */
  assertQualified(input: CodexNativeOutputQualificationInput, signal: AbortSignal): Promise<void>
  assertCurrent(signal?: AbortSignal): Promise<void>
  /** Main returns its original scope and reauthorizes every operation. */
  authorize(pin: CodexNativeOutputTurnPin, operation: WorkerNativeOutputCommand['operation'],
    signal?: AbortSignal): Promise<TemporaryFileScope>
  storage(input: Parameters<CodexNativeOutputs['prepare']>[0], pin: CodexNativeOutputTurnPin): InstalledNativeOutputStorageInput
  artifacts: { binding: WorkerNativeArtifactBinding; main: WorkerNativeArtifactApplication;
    receiver: ByteTransferPort; connection: TransferSenderConnection }
}
const unavailable = () => new DomainError('WORKER_NATIVE_OUTPUT_UNAVAILABLE',
  'The original qualified native output composition is unavailable.', 409)

/** Exactly one registry per durable original turn. Omission by common factories
 * declares no tools. This adapter supplies no authority or qualification default. */
export function createInstalledNativeOutputs(ports: InstalledNativeOutputProviders): CodexNativeOutputs {
  const artifactBinding = structuredClone(ports.artifacts.binding)
  const qualified = async (input: CodexNativeOutputQualificationInput, signal: AbortSignal) => {
    signal.throwIfAborted()
    if (input.configuration.sandbox !== 'workspace-write') throw unavailable()
    await ports.assertCurrent(signal); signal.throwIfAborted()
    await ports.assertQualified(input, signal); signal.throwIfAborted()
    await ports.assertCurrent(signal); signal.throwIfAborted()
  }
  return {
    assertQualified: qualified,
    prepare: async (raw, signal) => {
      const input = structuredClone(raw)
      await qualified(input, signal)
      if (!sameCodexNativeOutputSandbox(input.effectiveSandbox, input.expectedSandbox)) throw unavailable()
      let opening: Promise<void> | undefined
      let registry: WorkerNativeOutputRegistry | undefined
      let sender: WorkerNativeArtifactSender | undefined
      let pin: CodexNativeOutputTurnPin | undefined
      let scope: TemporaryFileScope | undefined
      let stopped = false
      const stop = new AbortController()
      const bounded = (effectSignal?: AbortSignal) => AbortSignal.any([signal, stop.signal, ...(effectSignal ? [effectSignal] : [])])
      const current = async (effectSignal?: AbortSignal) => {
        effectSignal?.throwIfAborted()
        if (stopped || !pin) throw unavailable()
        pin.assertCurrent()
        await ports.assertCurrent(effectSignal)
        pin.assertCurrent(); effectSignal?.throwIfAborted()
      }
      const open = (effectSignal?: AbortSignal) => opening ??= (async () => {
        if (!pin || stopped) throw unavailable()
        const activationSignal = bounded(effectSignal)
        await current(activationSignal)
        scope = TemporaryFileScopeSchema.parse(await ports.authorize(pin, 'create', activationSignal))
        if (scope.chat.kind !== 'agent' || scope.chat.runId !== artifactBinding.intent.runId
          || scope.chat.executionId !== artifactBinding.intent.executionId) throw unavailable()
        await current(activationSignal)
        const storageInput = ports.storage(input, pin)
        if (!('intent' in storageInput.owner) || !isDeepStrictEqual(storageInput.owner.intent, artifactBinding.intent)
          || !isDeepStrictEqual(storageInput.owner.session, pin.session)
          || storageInput.owner.nativeTurnId !== pin.nativeTurnId
          || storageInput.owner.runtimeGeneration !== pin.runtimeGeneration) throw unavailable()
        assertNativeOutputRootExcluded(storageInput.rootDirectory, [input.effectiveSandbox.cwd,
          ...input.effectiveSandbox.writableRoots, ...(!input.effectiveSandbox.excludeTmpdirEnvVar && input.effectiveSandbox.tmpdir ? [input.effectiveSandbox.tmpdir] : []),
          ...(!input.effectiveSandbox.excludeSlashTmp ? ['/tmp'] : [])])
        const storage = await createInstalledNativeOutputStorage(storageInput)
        await current(activationSignal)
        registry = await WorkerNativeOutputRegistry.open({ configuration: input.configuration, scope,
          callback: { assertCurrent: current }, storage,
          authority: { assertCurrent: async (operation, checkSignal) => {
            await current(checkSignal)
            const returned = TemporaryFileScopeSchema.parse(await ports.authorize(pin!, operation, checkSignal))
            if (!isDeepStrictEqual(returned, scope)) throw unavailable()
            await current(checkSignal)
          } },
          publisher: { publish: async (publication, callback, publicationSignal) => {
            if (!sender) throw unavailable()
            return sender.publish(publication, callback, publicationSignal)
          } },
        })
        sender = new WorkerNativeArtifactSender(artifactBinding, registry, ports.artifacts.main,
          ports.artifacts.receiver, ports.artifacts.connection)
        await current(activationSignal)
      })()
      return {
        activate: async (original, effectSignal) => {
          if (stopped || pin || registry || !original.nativeTurnId
            || !isDeepStrictEqual(original.session, input.session)
            || original.connectionId !== input.connectionId || original.runtimeGeneration !== input.runtimeGeneration) throw unavailable()
          const assertCurrent = original.assertCurrent.bind(original)
          pin = Object.freeze({ ...structuredClone({ session: original.session, connectionId: original.connectionId,
            runtimeGeneration: original.runtimeGeneration, nativeTurnId: original.nativeTurnId }), assertCurrent })
          // Finish the native ACK before Main can observe it and admit its file context.
          // Opening is deferred to the first callback and retains all current-authority checks.
          await current(bounded(effectSignal))
        },
        dispatch: async (command, original: CodexNativeOutputCallback, effectSignal) => {
          if (!pin || original.connectionId !== pin.connectionId
            || original.runtimeGeneration !== pin.runtimeGeneration || original.nativeTurnId !== pin.nativeTurnId
            || !isDeepStrictEqual(original.session, pin.session) || !original.callId.trim()) throw unavailable()
          const callbackCheck = original.assertCurrent.bind(original)
          const callSignal = bounded(effectSignal)
          const callback = Object.freeze({ assertCurrent: async (checkSignal?: AbortSignal) => {
            callbackCheck(); await current(checkSignal); callbackCheck()
          } })
          await callback.assertCurrent(callSignal)
          await open(callSignal)
          await callback.assertCurrent(callSignal)
          const reply = await registry!.dispatch(command, callback, callSignal)
          await callback.assertCurrent(callSignal)
          return reply
        },
        close: async () => {
          stopped = true; stop.abort(unavailable())
          await opening?.catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
          await registry?.withdraw()
        },
      }
    },
  }
}
