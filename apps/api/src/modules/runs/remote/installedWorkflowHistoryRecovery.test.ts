import { expect, it, vi } from 'vitest'
import { CODEX_APPROVAL_OPTIONS_FIXTURE } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { DEVICE_APPLICATION_JSON_BYTES } from '@foreman-code/contracts/device-application'
import { RemoteOperationStatusSchema } from '@foreman-code/contracts/remote-execution'
import { RemoteExecutionRpcRequestSchema, RemoteHistoryContinuationSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { restartedInstalledFixture } from './__tests__/installedWorkflowHost.js'
import { RemoteNativeSessionManager, type RemoteNativeManagerOptions,
  type RemoteNativeTransport } from './nativeManagerProxy.js'
import { readPhysicalReadout, remoteWorkflowSourceDigest } from './workflowPhysicalReadout.js'
import { createRemoteWorkflowPhysicalVerification } from './workflowPhysicalVerification.js'
import { isTransientExecutionError, transientExecutionFailure } from '../executionRetryPolicy.js'

it('reports verified Worker closure without a result as an interrupted attempt', async () => {
  const f = await restartedInstalledFixture()
  await f.journal.close()
  const host = await f.startHost()
  const handle = host.extensions[0]!.handle!
  const physical = createRemoteWorkflowPhysicalVerification({ endpoint: () => ({
    currentBinding: () => f.context.binding,
    captureRequest: () => ({ binding: f.context.binding,
      request: async raw => handle(raw, f.context) }),
  }) })
  let closed = false
  const proxy = new RemoteNativeSessionManager({
    intent: f.intent, placement: f.placement, harness: 'codex', configuration: f.request.configuration,
    transport: { request: async (_method, raw) => (await handle(raw, f.context)).payload },
    observeReceipt: async () => {},
    observeOriginalSource: async (receipt, source) => {
      const prepared = await physical.prefetch(receipt, f.placement, source)
      closed = physical.confirmedClosed(prepared, f.session)
    },
    controlFor: async () => { throw new Error('Recovery must not launch native control') },
  })
  try {
    await proxy.attachSession(f.session, { request: f.request, correlationId: `execution:${f.intent.executionId}` })
    const outcome = proxy.reconcile(f.session, `execution:${f.intent.executionId}`)
    await expect(outcome).rejects.toMatchObject({ code: 'EXECUTION_INTERRUPTED' })
    const error = await outcome.catch(error => error)
    expect(isTransientExecutionError(error)).toBe(true)
    expect(transientExecutionFailure(error)).toMatchObject({
      outcome: 'failed', error: { code: 'EXECUTION_INTERRUPTED', retryable: true },
    })
    expect(closed).toBe(true)
    const status = RemoteOperationStatusSchema.parse((await handle({ method: 'status',
      intent: f.intent, placement: f.placement }, f.context)).payload)
    expect(status).toMatchObject({ status: 'known', receipt: { phase: 'confirmed_terminal',
      terminal: { kind: 'cancelled' } } })
    if (status.status !== 'known') throw new Error('Recovery receipt is missing')
    expect(status.receipt.terminal).not.toHaveProperty('result')
  } finally { await host.close() }
})

it.each(['history', 'reconcile-response'] as const)(
  'reads a large completed result through %s after Worker restart', async method => {
    const f = await restartedInstalledFixture()
    const result = { outcome: 'succeeded' as const, output: { text: '漢😀'.repeat(80_000) } }
    await f.recovery.rememberOutput(f.intent.operationId, { kind: 'text-only', result })
    await f.journal.terminal(f.intent.operationId, {
      kind: 'completed', result, resultDigest: commandInputHash(result).slice('sha256:'.length),
      closureEvidenceDigest: commandInputHash({ intent: f.intent, native: { ...f.native, turnId: 'original-turn' },
        launch: f.launch, physicalOwnerClosed: true }).slice('sha256:'.length),
    })
    const before = await f.journal.status(f.intent.operationId)
    await f.journal.close()
    const host = await f.startHost()
    const handle = host.extensions[0]!.handle!
    const continuations: unknown[] = []
    const request: RemoteNativeTransport['request'] = async (_method, raw) => {
      const frame = RemoteExecutionRpcRequestSchema.parse(raw)
      if (frame.method === 'history' && frame.metadata) {
        f.deny()
        try {
          await expect(handle(frame, f.context)).rejects.toThrow('Main denied recovery')
        } finally {
          f.allow()
        }
      }
      const reply = await handle(frame, f.context)
      expect(Buffer.byteLength(JSON.stringify(reply.payload))).toBeLessThanOrEqual(DEVICE_APPLICATION_JSON_BYTES)
      if (frame.method === 'history' && frame.metadata) {
        RemoteHistoryContinuationSchema.parse(reply.payload)
        await expect(handle({ ...frame, correlationId: 'another-turn' }, f.context))
          .rejects.toMatchObject({ code: 'conflict' })
        continuations.push(reply.payload)
      }
      return structuredClone(reply.payload)
    }
    const observeReceipt = vi.fn(async () => {})
    // Main verifies every observed source against the Worker's retained physical readout.
    const observeOriginalSource = vi.fn<NonNullable<RemoteNativeManagerOptions['observeOriginalSource']>>(
      async (receipt, source) => {
        const selector = { method: 'physical-readout' as const, intent: f.intent, placement: f.placement,
          receiptSequence: receipt.sequence, sourceDigest: remoteWorkflowSourceDigest(source) }
        const readout = await readPhysicalReadout((await handle(selector, f.context)).payload,
          async metadata => (await handle({ ...selector, metadata }, f.context)).payload)
        expect(readout.receipt).toEqual(receipt)
        if (source.type === 'history') expect(readout.history?.terminalTurn?.result).toEqual(result)
      })
    const proxy = new RemoteNativeSessionManager({
      intent: f.intent, placement: f.placement, harness: 'codex', configuration: f.request.configuration,
      transport: { request }, observeReceipt, observeOriginalSource,
      controlFor: async () => { throw new Error('Completed recovery needs no control command') },
    })
    try {
      await proxy.attachSession(f.session, { request: f.request, correlationId: `execution:${f.intent.executionId}` })
      const history = method === 'history' ? await proxy.history(f.session)
        : await proxy.reconcileResponse(f.session, { nativeRequestId: 'original-request',
          nativeRequestType: 'approval', option: CODEX_APPROVAL_OPTIONS_FIXTURE[0]! })
      expect(history).toMatchObject({ terminalResult: result, terminalTurn: {
        correlationId: `execution:${f.intent.executionId}`, providerId: 'original-turn', result,
      } })
      expect(continuations.length).toBeGreaterThan(1)
      for (const continuation of continuations) {
        expect(continuation).not.toHaveProperty('status')
        expect(continuation).toHaveProperty('receiptIdentity')
      }
      const status = RemoteOperationStatusSchema.parse((await handle({ method: 'status',
        intent: f.intent, placement: f.placement }, f.context)).payload)
      expect(status).toEqual(before)
      expect(observeReceipt).toHaveBeenLastCalledWith(before.status === 'known' ? before.receipt : undefined,
        expect.anything())
      expect(observeOriginalSource).toHaveBeenLastCalledWith(before.status === 'known' ? before.receipt : undefined,
        { type: 'history', history })
    } finally {
      await host.close()
    }
  },
)
