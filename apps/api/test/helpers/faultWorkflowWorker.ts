import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { NativeSessionReference } from '@foreman-code/contracts'
import type { DeviceConnectionIdentity } from '@foreman-code/contracts/device-identity'
import type { AcceptedNodePlacement, DispatchIntent, NativeExecutionPlacement } from '@foreman-code/contracts/node-placement'
import { RemoteExecutionRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import type { RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import { DeviceConnectionError } from '../../src/modules/devices/deviceWire.js'
import { DomainError } from '../../src/modules/errors.js'
import type { NativeHarnessSessionManager, NativeHistory } from '../../src/modules/harnesses/port.js'
import { CodexAppServerSessionManager } from '../../src/modules/harnesses/codexAppServer.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../../src/modules/interactions/runtimePorts.js'
import { RemoteExecutionHost } from '../../src/modules/runs/remote/executionHost.js'
import { RemoteNativeSessionManager } from '../../src/modules/runs/remote/nativeManagerProxy.js'
import { RemoteOperationJournal } from '../../src/modules/runs/remote/operationJournal.js'
import { ActivityProductionReplay } from './activityProductionReplay.js'
import { pageNativeHistory } from '../../src/modules/runs/remote/nativeHistoryPage.js'
import { deferred, type Deferred } from './deferred.js'

const digest = 'a'.repeat(64)

/** In-process Worker and journal, with a recorded native harness and a faultable device carrier. */
export async function faultWorkflowWorker(directory: string, options: { mcpUnavailable?: boolean | undefined } = {}) {
  const replay = new ActivityProductionReplay('fault-session')
  const infrastructure = replay.infrastructure()
  if (infrastructure.mode !== 'replay') throw new Error('Expected recorded harness infrastructure')
  let mcpReady = !options.mcpUnavailable
  let unavailableInspections = 0
  const timers = new Map<ReturnType<typeof setTimeout>, { delayMs: number; fire(): void }>()
  const dependencies = { ...infrastructure.codex,
    schedule: ((...args: Parameters<typeof setTimeout>) => {
      const [callback, delayMs, ...callbackArgs] = args
      const fire = () => { timers.delete(timer); callback(...callbackArgs) }
      const timer = setTimeout(fire, delayMs)
      timers.set(timer, { delayMs: delayMs ?? 0, fire })
      return timer
    }) as typeof setTimeout,
    cancelTimer: ((timer) => {
      timers.delete(timer as ReturnType<typeof setTimeout>)
      clearTimeout(timer)
    }) as typeof clearTimeout,
    transport: (...args: Parameters<typeof infrastructure.codex.transport>) => {
      const transport = infrastructure.codex.transport(...args)
      return { ...transport, request: async (...requestArgs: Parameters<typeof transport.request>) => {
        const [method] = requestArgs
        if (method === 'mcpServerStatus/list' && args[1] === '/worker/project' && !mcpReady) {
          unavailableInspections += 1
          return { data: [], nextCursor: null }
        }
        return transport.request(...requestArgs)
      } }
    },
  }
  const adapters: CodexAppServerSessionManager[] = []
  const nativeOwners = new Map<string, { manager: NativeHarnessSessionManager; session: NativeSessionReference }>()
  const closedHistory = new Map<string, NativeHistory>()
  const manager = () => {
    const adapter = new CodexAppServerSessionManager('/recorded-no-native-codex', undefined, undefined,
      undefined, 'scoped', undefined, dependencies)
    adapters.push(adapter)
    return adapter
  }
  const connection: DeviceConnectionIdentity = {
    mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1,
  }
  const journalPath = join(directory, 'worker-journal')
  let journal = await RemoteOperationJournal.open(journalPath, { initializeNewInstallation: true })
  let incarnationId = randomUUID()
  const openHost = () => new RemoteExecutionHost({
    journal, connection, incarnationId,
    managers: new ExecutionScopedNativeSessionManagerResolver(manager),
    authorize: async () => undefined,
    preflight: async (request, access) => access ? {
      agentId: request.configuration.agentId, variables: { GRAPHQL_MCP_TOKEN: access.token },
    } : undefined,
    attestRuntimeLeaf: async (intent, _placement, request, executionPlacement) => ({
      executionId: intent.executionId, attemptId: intent.attemptId, operationId: intent.operationId,
      bindingHash: executionPlacement?.bindingHash ?? intent.bindingHash,
      canonicalRuntimeDirectory: request.runtimeDirectory, directoryIdentityHash: digest,
      materializationId: executionPlacement?.workingTree.materializationId ?? 'fixture-materialization',
      materializationDigest: executionPlacement?.workingTree.materializationDigest ?? digest,
    }),
    nativeEvidence: async (intent, session, context) => {
      if (!context) throw new Error('Expected the original native manager')
      nativeOwners.set(intent.operationId, { manager: context.manager, session })
      return { sessionId: session.nativeSessionId, processIdentityDigest: digest }
    },
    settle: async (_intent, history) => history.terminalTurn ? {
      kind: history.terminalTurn.result.outcome === 'canceled' ? 'cancelled' : 'completed',
      result: history.terminalTurn.result, closureEvidenceDigest: digest,
    } : null,
  })
  let host = openHost()
  const operations = new Set<string>()
  const interruptedExecutions = new Set<string>()
  let connected = true
  let interruptedRequest: Deferred<void> | undefined
  let rejectedRequests = 0
  const methods: string[] = []
  return {
    replay, connection, manager, interruptedExecutions,
    get unavailableInspections() { return unavailableInspections },
    makeMcpReady() { mcpReady = true },
    advanceNativeTimer(delayMs: number) {
      const entry = [...timers].find(([, timer]) => timer.delayMs === delayMs)
      if (!entry) return false
      clearTimeout(entry[0])
      entry[1].fire()
      return true
    },
    get journal() { return journal },
    get incarnationId() { return incarnationId },
    get rejectedRequests() { return rejectedRequests },
    methods,
    disconnect() { connected = false },
    reconnect() { connected = true },
    async restart() {
      interruptedRequest = deferred()
      connected = false
      await interruptedRequest.promise
      for (const operationId of operations) {
        const status = await journal.status(operationId)
        if (status.status === 'known' && status.receipt.native && !status.receipt.terminal) {
          interruptedExecutions.add(status.receipt.intent.executionId)
          replay.disconnect(status.receipt.native.sessionId)
        }
      }
      await host.drain()
      for (const operationId of operations) {
        const owner = nativeOwners.get(operationId)
        if (owner) closedHistory.set(operationId, structuredClone(await owner.manager.history(owner.session)))
      }
      await host.shutdown()
      for (const operationId of operations) {
        const status = await journal.status(operationId)
        if (status.status === 'known' && status.receipt.native && !status.receipt.terminal) {
          interruptedExecutions.add(status.receipt.intent.executionId)
          await journal.terminal(operationId, { kind: 'failed', closureEvidenceDigest: digest,
            result: { outcome: 'failed', error: { code: 'EXECUTION_INTERRUPTED',
              message: 'The Worker restarted before the turn completed.', retryable: true } } })
        }
      }
      await journal.close()
      journal = await RemoteOperationJournal.open(journalPath)
      incarnationId = randomUUID()
      connection.bootId = randomUUID()
      connection.connectionGeneration += 1
      host = openHost()
      connected = true
    },
    proxy(placement: AcceptedNodePlacement, intent: DispatchIntent,
      configuration: ConstructorParameters<typeof RemoteNativeSessionManager>[0]['configuration'],
      executionPlacement: NativeExecutionPlacement,
      observeReceipt: (receipt: RemoteOperationReceipt) => Promise<void>) {
      operations.add(intent.operationId)
      return new RemoteNativeSessionManager({
        intent, placement, configuration, harness: 'codex', observeReceipt,
        transport: { request: async (method, raw) => {
          methods.push(method)
          if (!connected) {
            rejectedRequests += 1
            interruptedRequest?.resolve()
            const error = new DomainError('DEVICE_TRANSPORT_ERROR', 'The recorded Worker connection was interrupted.', 503)
            error.cause = new DeviceConnectionError('transport')
            throw error
          }
          const payload = ['prepare', 'reattach', 'capabilities', 'inspect-mcp'].includes(method)
            ? { ...(raw as object), executionPlacement } : raw
          const frame = RemoteExecutionRpcRequestSchema.parse(payload)
          const history = closedHistory.get(intent.operationId)
          if (frame.method === 'history' && history) {
            const status = await journal.status(intent.operationId)
            if (status.status !== 'known' || !status.receipt.terminal
              || !isDeepStrictEqual(status.receipt.intent, frame.intent)) throw new Error('Original closed Worker history is unavailable')
            return { ...pageNativeHistory(history, frame.afterSequence, frame.metadata), status }
          }
          return host.handle(frame)
        } },
        controlFor: async ({ native }) => ({
          schemaVersion: 1, protocolVersion: 1, commandId: randomUUID(), operationId: intent.operationId,
          executionId: intent.executionId, attemptId: intent.attemptId, bindingHash: intent.bindingHash,
          owner: intent.owner, native, action: { kind: 'stop' },
        }),
      })
    },
    async close() {
      connected = true
      await host.shutdown()
      for (const adapter of adapters) await adapter.dispose()
      await journal.close()
    },
  }
}
