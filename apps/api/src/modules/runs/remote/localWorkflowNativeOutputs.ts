import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { isDeepStrictEqual as same } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { BYTE_TRANSFER_POLICY } from '@foreman-code/contracts/byte-transfer'
import { MAX_FILE_READ_BYTES } from '@foreman-code/contracts/files'
import { DomainError } from '../../errors.js'
import { codexOutputProtectionIdentity, qualifyCodexOutputProtection } from '../../harnesses/codexOutputProtection.js'
import { sameCodexNativeOutputSandbox, type CodexNativeOutputs, type CodexNativeOutputTurnPin,
  type CodexNativeOutputQualificationInput } from '../../harnesses/codexNativeOutput.js'
import { WorkerNativeOutputRegistry } from './workerNativeOutputRegistry.js'
import { assertNativeOutputRootExcluded, createInstalledNativeOutputStorage, createNativeOutputBudgetLedger,
  type LocalNativeOutputStorageOwner } from './installedNativeOutputStorage.js'
import type { LocalWorkflowArtifacts } from './localWorkflowArtifacts.js'

const unavailable = () => new DomainError('WORKER_NATIVE_OUTPUT_UNAVAILABLE',
  'The original local native output callback or protected store changed.', 409)

export function createLocalWorkflowNativeOutputs(input: {
  executionId: string
  artifacts(): LocalWorkflowArtifacts
  stateDirectory: string
  assertCurrent(signal?: AbortSignal): Promise<void>
  qualification: Pick<Parameters<typeof qualifyCodexOutputProtection>[0], 'registry' | 'qualify' | 'command'>
}): CodexNativeOutputs {
  const rootDirectory = join(input.stateDirectory, 'local-native-output-bytes')
  const budgetDirectory = join(input.stateDirectory, 'local-native-output-budget')
  const limits = { maxDiskBytes: BYTE_TRANSFER_POLICY.maxStagingBytes,
    maxSnapshotBytes: BYTE_TRANSFER_POLICY.maxStagingBytes,
    maxCommandRecords: BYTE_TRANSFER_POLICY.maxRecords * BYTE_TRANSFER_POLICY.maxActiveGlobal }
  let budget: Promise<Awaited<ReturnType<typeof createNativeOutputBudgetLedger>>> | undefined
  let qualified: ReturnType<typeof codexOutputProtectionIdentity> | undefined
  const initialize = () => budget ??= (async () => {
    await mkdir(rootDirectory, { recursive: true, mode: 0o700 })
    await mkdir(budgetDirectory, { recursive: true, mode: 0o700 })
    return createNativeOutputBudgetLedger({ rootDirectory: budgetDirectory,
      installation: { kind: 'local', mainId: input.artifacts().authority.mainId }, limits, initializeNewStore: true })
  })()
  const assertPlacement = (policy: CodexNativeOutputQualificationInput['expectedSandbox']) => {
    const roots = [policy.cwd, ...policy.writableRoots, ...(!policy.excludeSlashTmp ? ['/tmp'] : []),
      ...(!policy.excludeTmpdirEnvVar && policy.tmpdir ? [policy.tmpdir] : [])]
    assertNativeOutputRootExcluded(rootDirectory, roots)
    assertNativeOutputRootExcluded(budgetDirectory, roots)
  }
  const assertQualified = async (qualification: CodexNativeOutputQualificationInput, signal: AbortSignal) => {
    const selected = codexOutputProtectionIdentity(qualification)
    signal.throwIfAborted()
    await input.assertCurrent(signal)
    await input.artifacts().authority.assertDeclarations(input.executionId)
    assertPlacement(qualification.expectedSandbox)
    await initialize()
    if (!qualified || !same(qualified, selected)) {
      await qualifyCodexOutputProtection({ qualification: selected, protectedDirectory: rootDirectory,
        ...input.qualification, assertCurrent: async bounded => {
          await input.assertCurrent(bounded)
          await input.artifacts().authority.assertDeclarations(input.executionId)
        }, signal })
      qualified = structuredClone(selected)
    }
    await input.assertCurrent(signal)
  }
  return {
    assertQualified,
    async prepare(prepared, signal) {
      await assertQualified(prepared, signal)
      if (!sameCodexNativeOutputSandbox(prepared.expectedSandbox, prepared.effectiveSandbox)) throw unavailable()
      let pin: CodexNativeOutputTurnPin | undefined
      let registry: WorkerNativeOutputRegistry | undefined
      let opening: Promise<void> | undefined
      let stopped = false
      const stop = new AbortController()
      const current = async (bounded?: AbortSignal) => {
        bounded?.throwIfAborted()
        if (stopped || !pin) throw unavailable()
        pin.assertCurrent()
        await input.assertCurrent(bounded)
        pin.assertCurrent()
      }
      const open = () => opening ??= (async () => {
        const bounded = AbortSignal.any([signal, stop.signal, AbortSignal.timeout(30_000)])
        await current(bounded)
        // Native turn admission commits its context after the provider ACK.
        let accepted: Awaited<ReturnType<LocalWorkflowArtifacts['authority']['context']>> | undefined
        for (;;) {
          try {
            accepted = await input.artifacts().authority.context(input.executionId, { mutation: true })
            break
          }
          catch (error) {
            if (!(error instanceof DomainError) || ![
              'NATIVE_ARTIFACT_AUTHORITY_DENIED', 'NATIVE_ARTIFACT_CONTEXT_PENDING',
            ].includes(error.code)) throw error
            await current(bounded)
            await delay(25, undefined, { signal: bounded })
          }
        }
        await current(bounded)
        if (accepted.caller.context.nativeSessionId !== pin!.session.nativeSessionId
          || accepted.caller.context.turnId !== pin!.nativeTurnId) throw unavailable()
        const owner: LocalNativeOutputStorageOwner = { kind: 'local', mainId: input.artifacts().authority.mainId,
          executionId: input.executionId, attemptId: accepted.attempt.attemptId,
          placementHash: accepted.attempt.placementHash, session: pin!.session,
          nativeTurnId: pin!.nativeTurnId, runtimeGeneration: pin!.runtimeGeneration }
        const storage = await createInstalledNativeOutputStorage({ rootDirectory, owner, limits,
          budget: { reserve: async (...args) => (await initialize()).reserve(...args) }, assertCurrent: current,
          protection: { assertProtected: async original => {
            if (!same(original, owner) || !qualified) throw unavailable()
            assertPlacement(prepared.effectiveSandbox)
          }, assertQuiescent: async original => { if (!same(original, owner) || !qualified) throw unavailable() } } })
        registry = await WorkerNativeOutputRegistry.open({ configuration: prepared.configuration,
          scope: accepted.caller.context.scope, storage, callback: { assertCurrent: current },
          authority: { assertCurrent: async (_operation, bounded) => {
            await current(bounded)
            const latest = await input.artifacts().authority.context(input.executionId, { mutation: true })
            if (!same(latest, accepted)) throw unavailable()
            await current(bounded)
          } }, publisher: { publish: async (publication, callback, bounded) => {
            if (!registry) throw unavailable()
            const snapshot = await registry.sealed(publication, callback, bounded)
            return input.artifacts().publish(input.executionId, publication, {
              sha256: snapshot.sha256, byteSize: snapshot.byteSize,
              open: async () => Readable.from((async function* () {
                for (let offset = 0; offset < snapshot.byteSize; offset += MAX_FILE_READ_BYTES) {
                  await callback.assertCurrent(bounded)
                  yield await snapshot.read(offset, Math.min(MAX_FILE_READ_BYTES, snapshot.byteSize - offset), bounded)
                }
              })()),
            })
          } } })
      })()
      return {
        async activate(original, bounded) {
          if (pin || stopped || !same(original.session, prepared.session)
            || original.connectionId !== prepared.connectionId || original.runtimeGeneration !== prepared.runtimeGeneration) throw unavailable()
          pin = original
          await current(bounded)
        },
        async dispatch(command, callback, bounded) {
          if (!pin || callback.connectionId !== pin.connectionId || callback.runtimeGeneration !== pin.runtimeGeneration
            || callback.nativeTurnId !== pin.nativeTurnId || !same(callback.session, pin.session)) throw unavailable()
          const assertCurrent = callback.assertCurrent.bind(callback)
          const check = async (callSignal?: AbortSignal) => { assertCurrent(); await current(callSignal); assertCurrent() }
          await check(bounded)
          await open()
          await check(bounded)
          const reply = await registry!.dispatch(command, { assertCurrent: check }, bounded)
          await check(bounded)
          return reply
        },
        async close() {
          stopped = true
          stop.abort(unavailable())
          if (opening) {
            try { await opening }
            catch (error) {
              const canceled = error instanceof Error && error.name === 'AbortError'
                || error instanceof DomainError && error.code === 'WORKER_NATIVE_OUTPUT_UNAVAILABLE'
              if (!canceled) throw error
            }
          }
          await registry?.withdraw()
        },
      }
    },
  }
}
