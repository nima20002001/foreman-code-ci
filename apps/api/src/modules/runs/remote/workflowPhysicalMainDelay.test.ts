import { expect, it, vi } from 'vitest'
import { DeviceApplicationError, deviceApplicationFailure } from '../../devices/deviceApplicationError.js'
import { deviceRequestTimeoutMs, waitForDeviceRetry } from '../../devices/deviceRequestRetry.js'
import { DeviceConnectionError } from '../../devices/deviceWire.js'
import { DomainError } from '../../errors.js'
import { nativePersistenceRedactor } from '../../interactions/nativePersistence.js'
import { beforeGraphCommit } from '../../run-graph/connection.js'
import { repeatExecutionIdentity } from '../repeatResolution.js'
import { workflowNativeSourceId } from '../workflowNativeSource.js'
import { physicalFixture } from './__tests__/installedWorkflowHost.js'
import {
  assertOriginalPhysicalDirectories,
  InstalledWorkflowPhysicalReadouts,
  remoteWorkflowSourceDigest,
} from './workflowPhysicalReadout.js'

it.each([
  ['single', 5_000], ['batch', 5_000], ['single', 65_000], ['batch', 65_000],
] as const)(
  'keeps the same attempt through %s publication with %i ms Main database reads', async (mode, delayMs) => {
    const f = await physicalFixture()
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const original = await f.bind()
      const record = {
        scope: { runId: f.intent.runId }, proofId: workflowNativeSourceId(f.intent.executionId, f.source),
        execution: repeatExecutionIdentity(f.execution), session: f.session, original: f.source,
      }
      f.canonicalProofs.push({ record })
      const query = f.query.getMockImplementation()!
      f.query.mockImplementation(async text => {
        now += delayMs
        return query(text)
      })
      const startedAt = now
      await f.sqlConnection.transaction(async sql => {
        const verify = () => mode === 'single'
          ? f.producer.assertOriginal(sql, f.owner, original)
          : f.producer.assertOriginals(sql, f.owner, [original])
        await verify()
        beforeGraphCommit(sql, verify)
      })
      expect(now - startedAt).toBeGreaterThan(60_000)
      const ack = { version: 1, operationId: f.intent.operationId,
        receiptSequence: f.readout.receipt.sequence, sourceDigest: original.sourceDigest, status: 'retired' }
      f.request.mockImplementationOnce(async () => {
        now += 65_000
        return { payload: ack }
      })
      await expect(f.producer.acknowledge(original)).resolves.toEqual(ack)
      expect(f.request).toHaveBeenCalledTimes(2)
      expect(f.execution).toMatchObject({ id: f.intent.executionId, attempt: 1, state: 'running' })
    } finally {
      await f.sqlConnection.close()
    }
  },
)

it('rejects a physical observation that is already expired when it arrives', async () => {
  const f = await physicalFixture()
  f.readout.expiresAt = new Date(Date.now() - 1).toISOString()
  try {
    await expect(f.producer.prefetch(f.readout.receipt, f.placement, f.source))
      .rejects.toMatchObject({ code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE' })
    expect(f.request).toHaveBeenCalledOnce()
  } finally {
    await f.sqlConnection.close()
  }
})

it('acknowledges committed publication after a slow Main commit', async () => {
  const f = await physicalFixture()
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  try {
    const original = await f.bind()
    f.canonicalProofs.push({ record: {
      execution: repeatExecutionIdentity(f.execution), session: f.session, original: f.source,
    } })
    await f.sqlConnection.transaction(sql => f.producer.assertOriginal(sql, f.owner, original))
    now += 65_000
    const ack = { version: 1, operationId: f.intent.operationId,
      receiptSequence: f.readout.receipt.sequence, sourceDigest: original.sourceDigest, status: 'retired' }
    f.request.mockResolvedValueOnce({ payload: ack })
    await expect(f.producer.acknowledge(original)).resolves.toEqual(ack)
    expect(f.request).toHaveBeenCalledTimes(2)
  } finally {
    await f.sqlConnection.close()
  }
})

it.each(['disconnected', 'replaced', 'denied'] as const)(
  'rejects a %s owner while Main is processing a slow database read', async reason => {
    const f = await physicalFixture()
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const original = await f.bind()
      const query = f.query.getMockImplementation()!
      f.query.mockImplementationOnce(async text => {
        now += 65_000
        if (reason === 'disconnected') f.currentBinding.mockReturnValue(undefined as never)
        if (reason === 'replaced') {
          f.currentBinding.mockReturnValue({ ...f.context.binding, connectionGeneration: 99 })
        }
        if (reason === 'denied') {
          vi.mocked(f.lifetime.assertCurrent).mockImplementation(() => {
            throw new DomainError('AUTH_REVOKED', 'Execution access revoked.', 403)
          })
        }
        return query(text)
      })
      await expect(f.sqlConnection.transaction(sql => f.producer.assertOriginal(sql, f.owner, original)))
        .rejects.toMatchObject({ code: reason === 'denied' ? 'AUTH_REVOKED' : 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE' })
      expect(f.request).toHaveBeenCalledOnce()
    } finally {
      await f.sqlConnection.close()
    }
  },
)

async function readoutFixture(authorize: () => Promise<void>) {
  const f = await physicalFixture()
  const readouts = new InstalledWorkflowPhysicalReadouts()
  const selector = { intent: f.intent, placement: f.placement,
    receiptSequence: f.readout.receipt.sequence, sourceDigest: remoteWorkflowSourceDigest(f.source) }
  readouts.remember({ readout: f.readout, placement: f.placement, source: f.source,
    leaseExpiresAt: '2099-01-01T00:00:00.000Z', assertOwnerCurrent: authorize,
    assertCurrent: () => assertOriginalPhysicalDirectories({ source: f.readout.source,
      runtimeLeaf: f.readout.runtimeLeaf, placement: f.placement, approvedRoots: f.approvedRoots,
      signal: new AbortController().signal, assertCurrent: () => {}, authorize }),
    observe: () => f.captured.launch, closure: () => null })
  f.request.mockImplementation(async () => {
    try {
      return { payload: await readouts.read(selector) }
    } catch (error) {
      const failure = deviceApplicationFailure(nativePersistenceRedactor([]).error(error))
      throw new DeviceApplicationError(failure.code)
    }
  })
  return { ...f, readouts, selector, close: async () => {
    readouts.clear()
    await f.sqlConnection.close()
  } }
}

it.each(['backpressure', 'timeout', 'unavailable', 'DATABASE_READ_TIMEOUT', '40P01'])(
  'retries transient Main authority %s in the same physical read', async code => {
    for (const stage of ['before inspection', 'after inspection']) {
      const authorize = vi.fn(async () => {})
      const f = await readoutFixture(authorize)
      try {
        const failure = code === '40P01'
          ? Object.assign(new Error('Main database transaction rolled back.'), { code })
          : new DeviceApplicationError(code)
        if (stage === 'after inspection') authorize.mockResolvedValueOnce()
        authorize.mockRejectedValueOnce(failure)
        await expect(f.producer.prefetch(f.readout.receipt, f.placement, f.source))
          .resolves.toMatchObject({ kind: 'original-remote-physical' })
        expect(f.request).toHaveBeenCalledTimes(2)
        expect(f.request.mock.calls[1]).toEqual(f.request.mock.calls[0])
      } finally {
        await f.close()
      }
    }
  },
)

it('keeps retrying Main database timeouts beyond a verification window without replacing the attempt', async () => {
  const f = await physicalFixture()
  vi.useFakeTimers()
  const startedAt = Date.now()
  f.request.mockImplementation(async () => {
    f.readout.expiresAt = new Date(Date.now() + 60_000).toISOString()
    return { payload: f.readout }
  })
  for (let count = 0; count < 6; count++) {
    f.request.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 15_000))
      throw new DeviceApplicationError('DATABASE_READ_TIMEOUT')
    })
  }
  try {
    const result = f.producer.prefetch(f.readout.receipt, f.placement, f.source)
    const checked = expect(result).resolves.toMatchObject({ kind: 'original-remote-physical' })
    await Promise.allSettled([checked, vi.advanceTimersByTimeAsync(120_000)])
    await checked
    expect(Date.now() - startedAt).toBeGreaterThan(60_000)
    expect(f.request).toHaveBeenCalledTimes(7)
    for (const call of f.request.mock.calls) expect(call).toEqual(f.request.mock.calls[0])
  } finally {
    vi.useRealTimers()
    await f.sqlConnection.close()
  }
})

it.each([
  ['publication', 'revoked'], ['precommit', 'revoked'],
  ['publication', 'expired'], ['precommit', 'expired'],
] as const)('rejects %s with a connected Worker and an %s execution credential', async (stage, reason) => {
  const f = await physicalFixture()
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  try {
    const original = await f.bind()
    const deny = () => {
      now += 65_000
      if (reason === 'revoked') f.credential.revoked = true
      else f.credential.expiresAt = now - 1
    }
    await expect(f.sqlConnection.transaction(async sql => {
      const verify = () => f.producer.assertOriginal(sql, f.owner, original)
      if (stage === 'publication') deny()
      await verify()
      beforeGraphCommit(sql, verify)
      if (stage === 'precommit') deny()
    })).rejects.toMatchObject({
      code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', details: { reason: 'execution_authorization' },
    })
    expect(f.currentBinding()).toEqual(f.context.binding)
    expect(f.request).toHaveBeenCalledOnce()
  } finally {
    await f.sqlConnection.close()
  }
})

it('reads the Worker again after slow publication outlives the cached history', async () => {
  const f = await physicalFixture()
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  try {
    const original = await f.bind()
    const query = f.query.getMockImplementation()!
    f.query.mockImplementationOnce(async text => {
      now += 65_000
      return query(text)
    })
    await f.sqlConnection.transaction(sql => f.producer.assertOriginal(sql, f.owner, original))
    f.readout.expiresAt = new Date(now + 60_000).toISOString()
    await f.producer.prefetch(f.readout.receipt, f.placement, f.source)
    expect(f.request).toHaveBeenCalledTimes(2)
  } finally {
    await f.sqlConnection.close()
  }
})

it('does not extend an expired observation into a later publication operation', async () => {
  const f = await physicalFixture()
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  try {
    const original = await f.bind()
    await f.sqlConnection.transaction(sql => f.producer.assertOriginal(sql, f.owner, original))
    now += 65_000
    await expect(f.sqlConnection.transaction(sql => f.producer.assertOriginal(sql, f.owner, original)))
      .rejects.toMatchObject({ code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE' })
    expect(f.request).toHaveBeenCalledOnce()
  } finally {
    await f.sqlConnection.close()
  }
})

it.each(['timeout', 'backpressure', 'unavailable'] as const)(
  'bounds unanswered physical RPCs reported as %s while the Worker stays connected', async code => {
    const f = await physicalFixture()
    const controller = new AbortController()
    vi.useFakeTimers()
    const failure = code === 'unavailable' ? new DeviceApplicationError(code) : new DeviceConnectionError(code)
    f.request.mockImplementation(async (_payload, options) => {
      await waitForDeviceRetry(options!.timeoutMs!, controller.signal)
      throw failure
    })
    let settled: { error?: unknown } | undefined
    const result = f.producer.prefetch(f.readout.receipt, f.placement, f.source, controller.signal)
      .then(() => { settled = {} }, error => { settled = { error } })
    try {
      await vi.advanceTimersByTimeAsync(5 * deviceRequestTimeoutMs + 10_000)
      expect(settled).toEqual({ error: failure })
      expect(f.request).toHaveBeenCalledTimes(5)
      expect(f.currentBinding()).toEqual(f.context.binding)
    } finally {
      controller.abort()
      await result
      vi.useRealTimers()
      await f.sqlConnection.close()
    }
  },
)

it('recovers the same physical observation after the transport actually disconnects and reconnects', async () => {
  const f = await physicalFixture()
  const request = f.request.getMockImplementation()!
  f.request.mockImplementationOnce(async () => {
    f.currentBinding.mockReturnValue(undefined as never)
    setTimeout(() => f.currentBinding.mockReturnValue(f.context.binding), 0)
    throw new DeviceConnectionError('transport')
  }).mockImplementation(request)
  try {
    await expect(f.producer.prefetch(f.readout.receipt, f.placement, f.source)).resolves.toBeTruthy()
    expect(f.request).toHaveBeenCalledTimes(2)
    expect(f.currentBinding()).toEqual(f.context.binding)
  } finally { await f.sqlConnection.close() }
})

it.each(['denied', 'disconnected'] as const)('does not retry a %s physical authority check', async reason => {
  const failure = new DeviceApplicationError(reason === 'denied' ? 'AUTH_REVOKED' : 'transport')
  const authorize = vi.fn(async () => { throw failure })
  const f = await readoutFixture(authorize)
  try {
    await expect(f.producer.prefetch(f.readout.receipt, f.placement, f.source))
      .rejects.toMatchObject({ code: failure.code })
    expect(f.request).toHaveBeenCalledOnce()
    expect(authorize).toHaveBeenCalledOnce()
  } finally {
    await f.close()
  }
})
