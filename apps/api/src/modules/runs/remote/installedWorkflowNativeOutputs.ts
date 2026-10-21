import { mkdir } from 'node:fs/promises'
import { timed } from '../../../diagTemp.js'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { AgentFilePublishResultSchema } from '@foreman-code/contracts/files'
import { BYTE_TRANSFER_POLICY, TransferIntentSchema } from '@foreman-code/contracts/byte-transfer'
import { decodeWorkerMcpResult, WorkerMcpRelayRequestSchema, WorkerMcpRelayResponseSchema, WorkerNativeOutputAuthorizationSchema,
  WorkerNativeOutputDeclarationsAuthorizationSchema, WORKER_MCP_EXTENSION } from '@foreman-code/contracts/worker-mcp-relay'
import { WorkerNativeOutputReadinessSchema } from '@foreman-code/contracts/worker-mcp-relay'
import { sameCodexNativeOutputSandbox, type CodexNativeOutputQualificationInput } from '../../harnesses/codexNativeOutput.js'
import { codexOutputProtectionIdentity, qualifyCodexOutputProtection } from '../../harnesses/codexOutputProtection.js'
import type { NativeProcessRegistry } from '../../harnesses/recovery/processRegistry.js'
import { createChannelTransferClient } from '../../byte-transfer/carrier.js'
import { DomainError } from '../../errors.js'
import { createNativeOutputBudgetLedger, assertNativeOutputRootExcluded } from './installedNativeOutputStorage.js'
import type { InstalledNativeOutputProviders } from './installedNativeOutput.js'
import type { DispatchIntent, AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceApplicationResult } from '@foreman-code/contracts/device-application'
import type { SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import type { RemoteApplicationAccess } from '@foreman-code/contracts/remote-execution'
import type { AgentFilePublishInput, AgentFilePublishResult } from '@foreman-code/contracts/files'
import type { CodexNativeOutputTurnPin } from '../../harnesses/codexNativeOutput.js'
import type { DeviceApplicationRequestOptions } from '../../devices/deviceApplicationChannel.js'
import { retryDeviceRequest } from '../../devices/deviceRequestRetry.js'

export interface CapturedWorkflowMainRequest {
  readonly binding:Readonly<DeviceSessionBinding>
  request(payload:unknown,options?:DeviceApplicationRequestOptions):Promise<DeviceApplicationResult>
}
export interface InstalledWorkflowNativeOutputContext {
  intent: DispatchIntent
  placement: AcceptedNodePlacement
  binding: Readonly<DeviceSessionBinding>
  materialization: SourceMaterializationRecord
  applicationAccess(): RemoteApplicationAccess
  publicationCompleted(publication: AgentFilePublishInput, result: AgentFilePublishResult): void
  /** Real original registry/ACK evidence; deliberately does not inspect passive
   * originalSessionLifetime while the producer's starting gate is active. */
  assertCurrent(pin?: CodexNativeOutputTurnPin, signal?: AbortSignal): Promise<void>
}

const unavailable = () => new DomainError('WORKER_NATIVE_OUTPUT_UNAVAILABLE',
  'The original native output owner, protected store or Main authorization changed.', 409)

function mcpValue<T>(raw: unknown, id: string, schema: z.ZodType<T>): T {
  const response = WorkerMcpRelayResponseSchema.parse(raw)
  const frames = response.contentType === 'application/json' ? [response.body]
    : response.body.split(/\r?\n\r?\n/).map((frame) => frame.split(/\r?\n/)
      .filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')).filter(Boolean)
  const replies = frames.map((frame) => JSON.parse(frame) as {
    id: unknown; result?: { isError?: boolean; structuredContent?: unknown }
  }).filter((reply) => reply.id === id)
  if (response.statusCode !== 200 || replies.length !== 1 || !replies[0]!.result
    || replies[0]!.result.isError) throw unavailable()
  return schema.parse(replies[0]!.result.structuredContent)
}

/** Installed Worker composition. The same authenticated Main channel owns
 * operation authorization, byte admission and publication; no JSON scope or
 * native-selected path can create a producer. */
export function createInstalledWorkflowNativeOutputProviders(input: {
  stateDirectory: string
  context: InstalledWorkflowNativeOutputContext
  registry: NativeProcessRegistry
  qualification: Pick<Parameters<typeof qualifyCodexOutputProtection>[0], 'qualify' | 'command'>
  captureRequest(namespace: string): CapturedWorkflowMainRequest | undefined
}): InstalledNativeOutputProviders {
  const { context } = input
  // Storage and transfers retain the launch identity while relay authorization follows the live resident.
  const artifactBinding = { intent: structuredClone(context.intent), placement: structuredClone(context.placement),
    root: { rootId: context.materialization.receipt.binding.rootId,
      rootBindingRevision: context.materialization.receipt.binding.bindingRevision } }
  const rootDirectory = join(input.stateDirectory, 'native-output-bytes')
  const budgetDirectory = join(input.stateDirectory, 'native-output-budget')
  const limits = { maxDiskBytes: BYTE_TRANSFER_POLICY.maxStagingBytes,
    maxSnapshotBytes: BYTE_TRANSFER_POLICY.maxStagingBytes,
    maxCommandRecords: BYTE_TRANSFER_POLICY.maxRecords * BYTE_TRANSFER_POLICY.maxActiveGlobal }
  let storage: Promise<Awaited<ReturnType<typeof createNativeOutputBudgetLedger>>> | undefined
  let qualified: ReturnType<typeof codexOutputProtectionIdentity> | undefined
  const assertStoragePlacement = (policy: CodexNativeOutputQualificationInput['expectedSandbox']) => {
    const roots = [policy.cwd, ...policy.writableRoots,
      ...(!policy.excludeSlashTmp ? ['/tmp'] : []),
      ...(!policy.excludeTmpdirEnvVar && policy.tmpdir ? [policy.tmpdir] : [])]
    assertNativeOutputRootExcluded(rootDirectory, roots)
    assertNativeOutputRootExcluded(budgetDirectory, roots)
  }
  const initialize = (signal?: AbortSignal) => storage ??= (async () => {
    await mkdir(rootDirectory, { recursive: true, mode: 0o700 })
    await mkdir(budgetDirectory, { recursive: true, mode: 0o700 })
    return createNativeOutputBudgetLedger({ rootDirectory: budgetDirectory,
      installation: { mainId: context.binding.mainId, deviceId: context.binding.deviceId,
        workerInstallationId: context.binding.workerInstallationId }, limits, initializeNewStore: true, signal })
  })().catch((error: unknown) => {
    storage = undefined
    throw error
  })
  const captureRequest = (namespace: string) => {
    const capture = input.captureRequest(namespace)
    if (!capture || !isDeepStrictEqual(capture.binding, context.binding)) throw unavailable()
    return capture
  }
  const request = async (payload: unknown, signal?: AbortSignal) => {
    const intent = structuredClone(context.intent)
    await context.assertCurrent(undefined, signal)
    if (!isDeepStrictEqual(intent, context.intent)) throw unavailable()
    const capture = captureRequest(WORKER_MCP_EXTENSION.namespace)
    const result = await timed(`relay:${(payload as { operation?: string }).operation}:${(payload as { body?: { params?: { name?: string } } }).body?.params?.name ?? ''}`, () => retryDeviceRequest(() => capture.request(payload, signal ? { signal } : undefined),
      { retry: 'admission', signal }))
    await context.assertCurrent(undefined, signal)
    if (!isDeepStrictEqual(capture.binding, context.binding) || !isDeepStrictEqual(intent, context.intent)) {
      throw unavailable()
    }
    return decodeWorkerMcpResult(result)
  }
  const envelope = () => ({ version: 1, intent: context.intent, placement: context.placement,
    applicationAccess: context.applicationAccess() })
  let calls = 0
  const call = async <T>(name: string, arguments_: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> => {
    const id = `native-output:${context.intent.executionId}:${++calls}`
    return mcpValue(await request(WorkerMcpRelayRequestSchema.parse({ ...envelope(), operation: 'worker-mcp.request',
      body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } } }), signal), id, schema)
  }
  const carrier = createChannelTransferClient({ captureRequest })
  return {
    assertCurrent: (signal) => context.assertCurrent(undefined, signal),
    assertQualified: async (qualification, signal) => {
      await context.assertCurrent(undefined, signal)
      const policy = WorkerNativeOutputDeclarationsAuthorizationSchema.parse(await request(
        WorkerMcpRelayRequestSchema.parse({ ...envelope(), operation: 'worker-mcp.authorize-native-output-declarations' }), signal))
      if (context.placement.payload.kind !== 'agent'
        || policy.agentConfigurationVersionId !== context.placement.payload.agentConfigurationVersionId
        || !(['create', 'append', 'seal', 'publish'] as const)
          .every((operation) => policy.outputOperations.includes(operation))) {
        throw unavailable()
      }
      assertStoragePlacement(qualification.expectedSandbox)
      await initialize(signal)
      const selected = codexOutputProtectionIdentity(qualification)
      if (!qualified || !isDeepStrictEqual(qualified, selected)) {
        await qualifyCodexOutputProtection({ qualification, protectedDirectory: rootDirectory,
          registry: input.registry, ...input.qualification,
          assertCurrent: (bounded) => context.assertCurrent(undefined, bounded), signal })
        qualified = structuredClone(selected)
      }
      await context.assertCurrent(undefined, signal)
    },
    authorize: async (pin, operation, signal) => {
      await context.assertCurrent(pin, signal)
      const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
      for (;;) {
        const readiness = WorkerNativeOutputReadinessSchema.parse(await request(WorkerMcpRelayRequestSchema.parse({
          ...envelope(), operation: 'worker-mcp.native-output-readiness',
          nativeSessionId: pin.session.nativeSessionId, turnId: pin.nativeTurnId,
        }), bounded))
        await context.assertCurrent(pin, bounded)
        if (readiness.ready) break
        await delay(25, undefined, { signal: bounded })
      }
      const response = WorkerNativeOutputAuthorizationSchema.parse(await request(WorkerMcpRelayRequestSchema.parse({
        ...envelope(), operation: 'worker-mcp.authorize-native-output', outputOperation: operation,
        nativeSessionId: pin.session.nativeSessionId, turnId: pin.nativeTurnId,
      }), signal))
      if (response.nativeSessionId !== pin.session.nativeSessionId || response.turnId !== pin.nativeTurnId
        || response.outputOperation !== operation || response.executionId !== context.intent.executionId) throw unavailable()
      await context.assertCurrent(pin, signal)
      return response.scope
    },
    storage: (prepared, pin) => {
      const owner = { intent: artifactBinding.intent, binding: context.binding, session: pin.session,
        nativeTurnId: pin.nativeTurnId, runtimeGeneration: pin.runtimeGeneration }
      if (!qualified || !sameCodexNativeOutputSandbox(prepared.effectiveSandbox, prepared.expectedSandbox)
        || !sameCodexNativeOutputSandbox(prepared.effectiveSandbox, qualified.expectedSandbox)) throw unavailable()
      return { rootDirectory, owner, limits,
        budget: { reserve: async (reservation, signal) => (await initialize(signal)).reserve(reservation, signal) },
        assertCurrent: (signal) => context.assertCurrent(pin, signal),
        protection: {
          assertProtected: async (original, signal) => {
            if (!isDeepStrictEqual(original, owner) || !qualified) throw unavailable()
            await context.assertCurrent(pin, signal)
            assertStoragePlacement(prepared.effectiveSandbox)
          },
          assertQuiescent: async (original) => {
            // The private registry drains its readers/writers before release.
            // The qualified native sandbox cannot write this excluded store.
            if (!isDeepStrictEqual(original, owner) || !qualified) throw unavailable()
          },
        },
      }
    },
    artifacts: { binding: artifactBinding,
      main: {
        admit: (declaration, signal) => call('files.admit_transferred_result', declaration, TransferIntentSchema, signal),
        publish: async (publication, signal) => {
          const result = await call('files.publish_transferred_result', publication, AgentFilePublishResultSchema, signal)
          context.publicationCompleted(publication.publication, result)
          return result
        },
      }, receiver: carrier.receiver, connection: carrier.connection },
  }
}
