import { randomUUID } from 'node:crypto'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type AgentConfigurationVersion } from '@foreman-code/contracts'
import { RemoteOperationReceiptSchema, type RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import { RemoteHistoryReceiptIdentitySchema, RemoteExecutionRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { deferred } from '../../../test/helpers/deferred.js'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import type { NativeHistory } from '../harnesses/port.js'
import { pageNativeHistory } from '../runs/remote/nativeHistoryPage.js'
import type { RemoteCommitFacts, RemoteResultCommitPort } from '../runs/remote/resultBridge.js'
import { deriveDispatch, freezePlacement } from './binding.js'
import { remoteNativeManager } from './workerCarrier.js'

function observationFixture(history?: NativeHistory, options: {
  delayMetadata?: boolean
  historyReply?(reply: ReturnType<typeof pageNativeHistory> & {
    status: { status: 'known'; receipt: RemoteOperationReceipt }
  }, metadata: boolean, signal?: AbortSignal): void | Promise<void>
  beforeCommit?(): void
} = {}) {
  const mainId = randomUUID()
  const deviceId = randomUUID()
  const workerInstallationId = randomUUID()
  const digest = 'a'.repeat(64)
  const configuration: AgentConfigurationVersion = {
    id: 'configuration', agentId: 'agent', workspaceId: 'workspace', version: 1,
    prompt: { system: 'Observe the original session.' }, assignedSkills: [],
    harness: DEFAULT_HARNESS_DEFAULTS.codex, contentHash: digest, createdAt: '2026-10-01T00:00:00.000Z',
  }
  const placement = freezePlacement({ schemaVersion: 1, mainId, runId: 'run', nodeId: 'node',
    hostRef: { kind: 'device', mainId, deviceId }, mainInstallationId: 'main-installation',
    registration: { workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime',
      directoryIdentityHash: digest, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1',
      attestationId: 'attestation', attestationHash: digest },
    source: { revisionId: 'source', manifestDigest: digest, materializationId: 'materialization',
      materializationDigest: digest },
    payload: { kind: 'agent', agentId: configuration.agentId, agentConfigurationVersionId: configuration.id,
      driverId: 'codex', driverRevision: '1', instanceId: 'instance', instanceRevision: '1',
      harnessInstallationId: 'installation', installationFingerprint: digest, runtimeContractVersion: 1,
      protocolRevision: '1', credentialScopeRefs: [] },
  })
  const intent = deriveDispatch(placement, { executionId: 'execution', occurrenceId: null, occurrenceIndex: 0,
    technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation', inputDigest: `sha256:${digest}`,
    owner: { grantId: 'grant', epoch: '1' } })
  const session = { harness: 'codex' as const, providerVersion: 'fixture', nativeSessionId: 'native-session' }
  const connection = { mainId, deviceId, workerInstallationId, bootId: randomUUID(), keyRevision: 1,
    authorizationRevision: 1, connectionGeneration: 1 }
  const receipt = RemoteOperationReceiptSchema.parse({ schemaVersion: 1, intent, connection,
    workerIncarnationId: randomUUID(), sequence: 1, phase: 'running', entryAttempted: true,
    turnEntryAttempted: false, stopFence: false, controls: [],
    native: { sessionId: session.nativeSessionId, processIdentityDigest: digest } })
  const authority: RemoteCommitFacts = { intent, placement, originalConnection: connection,
    originalIncarnationId: receipt.workerIncarnationId, grantIsLive: true, lastSequence: 0,
    lastReceipt: null, native: null, terminal: null }
  const metadataEntered = deferred()
  const metadataRelease = deferred()
  let metadataDelayed = false
  const committed = deferred()
  const release = deferred()
  const secondReply = deferred()
  const observedGenerations: number[] = []
  const rejections: string[] = []
  const historyReads: unknown[] = []
  let generation = 1
  const port: RemoteResultCommitPort = {
    transaction: async (_operationId, work) => work({
      authority: async () => authority,
      reject: async (_receipt, reason) => { rejections.push(reason) },
      accept: async evidence => {
        authority.lastSequence = evidence.receipt.sequence
        authority.lastReceipt = evidence.receipt
        authority.native = evidence.receipt.native ?? null
      },
      retain: async () => {},
    }),
  }
  const manager = remoteNativeManager({ executionId: intent.executionId, agentId: configuration.agentId,
    workingDirectory: '/project', configuration, harness: 'codex' },
    { intent, placement }, {
      workerExecution: new WorkerExecutionPolicy({ enabled: true, managedBy: 'settings' }),
      beforePrepare: async () => {},
      controlFor: async () => { throw new Error('No native control is expected') },
      carrier: { capture: () => {
        const identity = { ...connection, connectionGeneration: generation++ }
        return { identity, request: async (_namespace, raw, requestOptions) => {
          const frame = RemoteExecutionRpcRequestSchema.parse(raw)
          const status = { status: 'known' as const, receipt: structuredClone(receipt) }
          if (frame.method === 'prepare') return { payload: { session, status } }
          if ((frame.method === 'history' || frame.method === 'reconcile-response') && history) {
            historyReads.push(frame)
            const metadata = frame.method === 'history' ? frame.metadata : undefined
            if (metadata && options.delayMetadata && !metadataDelayed) {
              metadataDelayed = true
              metadataEntered.resolve()
              await metadataRelease.promise
            }
            const afterSequence = frame.method === 'history' ? frame.afterSequence : undefined
            const reply = { ...pageNativeHistory(history, afterSequence, metadata), status }
            await options.historyReply?.(reply, metadata !== undefined, requestOptions?.signal)
            return { payload: metadata ? { receiptIdentity: RemoteHistoryReceiptIdentitySchema.parse(reply.status.receipt),
              page: reply.page } : reply }
          }
          if (frame.method !== 'status') throw new Error('Only session preparation and boundary reads are expected')
          if (identity.connectionGeneration === 3) secondReply.resolve()
          return { payload: status }
        } }
      } },
      commit: async (_receipt, authenticated) => {
        observedGenerations.push(authenticated.connectionGeneration)
        options.beforeCommit?.()
        if (authenticated.connectionGeneration === 2) {
          committed.resolve()
          await release.promise
        }
        return port
      },
    })
  const request = { executionId: intent.executionId, runId: intent.runId, workspaceId: configuration.workspaceId,
    workflowNodeId: intent.nodeId, workingDirectory: '/project', runtimeDirectory: '/runtime',
    configuration, input: {} }
  return { manager, request, session, committed, release, secondReply, observedGenerations, rejections, historyReads,
    metadataEntered, metadataRelease }
}

it('authenticates concurrent identical receipts with each reply original connection', async () => {
  const f = observationFixture()
  await f.manager.createSession({ request: f.request, correlationId: `execution:${f.request.executionId}` })
  const first = f.manager.observeBoundary(f.session)
  const firstOutcome = Promise.allSettled([first])
  let second: ReturnType<typeof f.manager.observeBoundary> | undefined
  try {
    await f.committed.promise
    second = f.manager.observeBoundary(f.session)
    const secondOutcome = Promise.allSettled([second])
    await f.secondReply.promise
    await nextTurn()
    f.release.resolve()
    expect(await firstOutcome).toMatchObject([{ status: 'fulfilled' }])
    await secondOutcome
    await expect(second).resolves.toBeUndefined()
    expect(f.observedGenerations).toEqual([1, 2, 3])
    expect(f.rejections).toEqual([])
  } finally {
    f.release.resolve()
    await Promise.allSettled([first, second])
  }
})

it('reads paginated history metadata without retaining its continuation pages as unobserved receipts', async () => {
  const history: NativeHistory = { events: [], pendingInteractions: [],
    terminalResult: { outcome: 'succeeded', output: { text: 'x'.repeat(2_200_000) } } }
  const f = observationFixture(history)
  f.release.resolve()
  await f.manager.createSession({ request: f.request, correlationId: `execution:${f.request.executionId}` })
  await expect(f.manager.history(f.session)).resolves.toMatchObject(history)
  await expect(f.manager.history(f.session)).resolves.toMatchObject(history)
  expect(f.historyReads.length).toBeGreaterThan(32)
  expect(f.rejections).toEqual([])
})

it('bounds identical pending replies and releases their capacity after observation', async () => {
  const f = observationFixture()
  await f.manager.createSession({ request: f.request, correlationId: `execution:${f.request.executionId}` })
  const first = f.manager.observeBoundary(f.session)
  const firstOutcome = Promise.allSettled([first])
  let pending: Promise<unknown>[] = []
  try {
    await f.committed.promise
    pending = Array.from({ length: 31 }, () => f.manager.observeBoundary(f.session))
    const outcomes = Promise.allSettled(pending)
    await nextTurn()
    const overflow = f.manager.observeBoundary(f.session)
    const overflowOutcome = Promise.allSettled([overflow])
    await nextTurn()
    f.release.resolve()
    expect(await firstOutcome).toMatchObject([{ status: 'fulfilled' }])
    expect((await outcomes).every(result => result.status === 'fulfilled')).toBe(true)
    await overflowOutcome
    await expect(overflow).rejects.toMatchObject({ code: 'REMOTE_RESPONSE_BACKPRESSURE' })
    await expect(f.manager.observeBoundary(f.session)).resolves.toBeUndefined()
    expect(f.rejections).toEqual([])
  } finally {
    f.release.resolve()
    await Promise.allSettled([first, ...pending])
  }
})

it('binds an identical boundary reply to its own connection while earlier history metadata is delayed', async () => {
  const history: NativeHistory = { events: [], pendingInteractions: [],
    terminalResult: { outcome: 'succeeded', output: { text: 'x'.repeat(400_000) } } }
  const f = observationFixture(history, { delayMetadata: true })
  f.release.resolve()
  await f.manager.createSession({ request: f.request, correlationId: `execution:${f.request.executionId}` })
  const reading = f.manager.history(f.session)
  const outcome = Promise.allSettled([reading])
  try {
    await f.metadataEntered.promise
    await expect(f.manager.observeBoundary(f.session)).resolves.toBeUndefined()
    expect(f.observedGenerations).toEqual([1, 4])
  } finally {
    f.metadataRelease.resolve()
    await outcome
  }
  await expect(reading).resolves.toMatchObject(history)
  expect(f.observedGenerations).toEqual([1, 4, 2])
  expect(f.rejections).toEqual([])
})

const historyFailures = ['continuation failure', 'cancellation', 'invalid first page',
  'invalid continuation', 'receipt conflict'] as const
it.each((['history', 'reconcile-response'] as const).flatMap(method =>
  historyFailures.map(failure => ({ method, failure }))))(
  'releases retained $method responses after $failure', async ({ method, failure }) => {
    const history: NativeHistory = { events: [], pendingInteractions: [],
      terminalResult: { outcome: 'succeeded', output: { text: 'x'.repeat(400_000) } } }
    const interrupted = new Error('History read interrupted')
    let failing = false
    let controller = new AbortController()
    const f = observationFixture(history, {
      historyReply: (reply, metadata, signal) => {
        if (!failing) return
        if (failure === 'invalid first page') Reflect.set(reply.history, 'pendingInteractions', null)
        if (failure === 'receipt conflict') reply.status.receipt.native!.sessionId = 'other-session'
        if (!metadata) return
        if (failure === 'continuation failure') throw interrupted
        if (failure === 'cancellation') {
          controller.abort(interrupted)
          signal!.throwIfAborted()
        }
        if (failure === 'invalid continuation') reply.page.metadata!.digest = 'f'.repeat(64)
      },
    })
    f.release.resolve()
    await f.manager.createSession({ request: f.request, correlationId: `execution:${f.request.executionId}` })
    failing = true
    for (let attempt = 0; attempt < 33; attempt++) {
      controller = new AbortController()
      const reading = method === 'history' ? f.manager.history(f.session, controller.signal)
        : f.manager.reconcileResponse(f.session, {
          nativeRequestId: 'question', nativeRequestType: 'approval', option: {
            optionId: 'approve', semantic: 'approve_once', label: 'Approve', persistence: 'request',
            affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false,
          },
        }, controller.signal)
      if (failure === 'continuation failure' || failure === 'cancellation') {
        await expect(reading).rejects.toBe(interrupted)
      } else if (failure === 'receipt conflict') {
        await expect(reading).rejects.toThrow('Original remote receipt changed')
      } else if (failure === 'invalid continuation') {
        await expect(reading).rejects.toThrow('JSON continuation identity changed')
      } else {
        await expect(reading).rejects.toMatchObject({ name: 'ZodError' })
      }
    }
    expect(f.observedGenerations).toEqual([1])
    failing = false
    await expect(f.manager.observeBoundary(f.session)).resolves.toBeUndefined()
    await expect(f.manager.history(f.session)).resolves.toMatchObject(history)
    expect(f.rejections).toEqual([])
  },
)

it('preserves observation errors and releases consumed history responses exactly once', async () => {
  const history: NativeHistory = { events: [], pendingInteractions: [] }
  const rejected = new Error('Receipt commit failed')
  let failing = false
  const f = observationFixture(history, {
    beforeCommit: () => { if (failing) throw rejected },
  })
  f.release.resolve()
  await f.manager.createSession({ request: f.request, correlationId: `execution:${f.request.executionId}` })
  failing = true
  for (let attempt = 0; attempt < 33; attempt++) {
    await expect(f.manager.history(f.session)).rejects.toBe(rejected)
  }
  failing = false
  await expect(f.manager.history(f.session)).resolves.toMatchObject(history)
  await expect(f.manager.observeBoundary(f.session)).resolves.toBeUndefined()
  expect(f.rejections).toEqual([])
})

it('preserves reconciliation errors for history responses that contain no receipt', async () => {
  const history: NativeHistory = { events: [], pendingInteractions: [] }
  let unknown = false
  const f = observationFixture(history, {
    historyReply: reply => {
      if (unknown) Reflect.set(reply, 'status', {
        status: 'unknown', reason: 'journal_absence_requires_reconciliation',
      })
    },
  })
  f.release.resolve()
  await f.manager.createSession({ request: f.request, correlationId: `execution:${f.request.executionId}` })
  unknown = true
  for (let attempt = 0; attempt < 33; attempt++) {
    await expect(f.manager.history(f.session)).rejects.toThrow('Original worker journal requires reconciliation')
  }
  unknown = false
  await expect(f.manager.history(f.session)).resolves.toMatchObject(history)
})
