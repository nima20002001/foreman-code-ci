import type { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { OperatorRuntimeOwner } from '../src/infrastructure/operatorRuntimeOwner.js'
import { deferred } from './helpers/deferred.js'

interface OwnerReply {
  rows: Array<{ acquired?: boolean; epoch?: string; pid?: number; backend_start?: string }>
}

interface OwnershipCheck {
  query: Mock<() => Promise<{ rows: Array<{ pid: number; backend_start: string }> }>>
  connect: Mock<() => Promise<OwnershipCheck>>
  release: Mock
  end: Mock<() => Promise<void>>
  on: Mock
  removeListener: Mock
}

interface Driver extends EventEmitter {
  connect: Mock<() => Promise<void>>
  query: Mock<(sql: string) => Promise<OwnerReply>>
  end: Mock<() => Promise<void>>
}
const state = vi.hoisted(() => ({ drivers: [] as Driver[], check: undefined as OwnershipCheck | undefined }))
vi.mock('pg', async () => {
  const { EventEmitter } = await import('node:events')
  return { default: { Client: class extends EventEmitter {
    connect = vi.fn<() => Promise<void>>(async () => undefined)
    query = vi.fn<(sql: string) => Promise<OwnerReply>>(async () => ({ rows: [{ acquired: true, pid: 123, backend_start: '1000001' }] }))
    end = vi.fn(async () => { this.emit('end') })
    constructor() { super(); state.drivers.push(this) }
  }, Pool: class extends EventEmitter {
    connect = () => state.check!.connect()
    end = () => state.check!.end()
  } } }
})
beforeEach(() => {
  state.drivers.length = 0
  const check: OwnershipCheck = {
    query: vi.fn(async () => ({ rows: [{ pid: 123, backend_start: '1000001' }] })),
    connect: vi.fn(), release: vi.fn(), end: vi.fn(async () => undefined),
    on: vi.fn(), removeListener: vi.fn(),
  }
  check.connect.mockResolvedValue(check)
  state.check = check
})
afterEach(() => { vi.useRealTimers() })
function fixture() {
  const lost = vi.fn()
  const owner = new OperatorRuntimeOwner('postgresql://fixture/fixture', lost)
  return { owner, lost, driver: state.drivers[0]!, check: state.check! }
}

describe('runtime-owner connection lifetime', () => {
  it('retries an initial connection timeout with a fresh client before admitting native work', async () => {
    vi.useFakeTimers()
    const { owner, driver, lost } = fixture()
    driver.connect.mockRejectedValueOnce(new Error('Connection terminated due to connection timeout'))
    const acquisition = owner.acquire().catch(error => error)
    await vi.advanceTimersByTimeAsync(100)
    expect(await acquisition).toBeUndefined()
    expect(owner.active).toBe(true)
    expect(state.drivers).toHaveLength(2)
    expect(driver.end).toHaveBeenCalledOnce()
    expect(state.drivers[1]!.connect).toHaveBeenCalledOnce()
    expect(lost).not.toHaveBeenCalled()
    await owner.close()
  })

  it('cancels initial connection retry on close without acquiring another owner connection', async () => {
    vi.useFakeTimers()
    const { owner, driver, lost } = fixture()
    driver.connect.mockRejectedValueOnce(new Error('Connection terminated due to connection timeout'))
    const acquisition = owner.acquire().catch(error => error)
    await vi.advanceTimersByTimeAsync(0)
    await owner.close()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await acquisition).toBeInstanceOf(Error)
    expect(owner.active).toBe(false)
    expect(state.drivers).toHaveLength(1)
    expect(driver.end).toHaveBeenCalledOnce()
    expect(lost).not.toHaveBeenCalled()
  })

  it('does not replace the owner client when authentication is permanently invalid', async () => {
    const { owner, driver, lost } = fixture()
    const failure = Object.assign(new Error('password authentication failed'), { code: '28P01' })
    driver.connect.mockRejectedValueOnce(failure)
    await expect(owner.acquire()).rejects.toBe(failure)
    expect(state.drivers).toHaveLength(1)
    expect(driver.end).toHaveBeenCalledOnce()
    expect(lost).not.toHaveBeenCalled()
    await owner.close()
  })

  it('publishes acquisition before a synchronous connection callback can reenter it', async () => {
    const { owner, driver } = fixture()
    let reentered: Promise<void> | undefined
    driver.connect.mockImplementationOnce(async () => { reentered = owner.acquire() })
    const acquisition = owner.acquire()
    await acquisition
    expect(reentered).toBe(acquisition)
    expect(driver.connect).toHaveBeenCalledOnce()
    await owner.close()
  })

  it('does not connect just to close an uninitialized owner', async () => {
    const { owner, driver } = fixture()
    await owner.close()
    expect(driver.connect).not.toHaveBeenCalled()
    expect(driver.query).not.toHaveBeenCalled()
    await expect(owner.acquire()).rejects.toThrow('closing')
  })

  it('coalesces acquire and close and suppresses loss notifications for its own normal end', async () => {
    const { owner, driver, lost } = fixture()
    const first = owner.acquire()
    expect(owner.acquire()).toBe(first)
    await first
    const closing = owner.close()
    expect(owner.close()).toBe(closing)
    await closing
    expect(driver.connect).toHaveBeenCalledTimes(1)
    expect(driver.query).toHaveBeenCalledTimes(2)
    expect(driver.end).toHaveBeenCalledTimes(1)
    expect(lost).not.toHaveBeenCalled()
  })

  it('ends a rejected acquisition exactly once and never reports ownership loss', async () => {
    const { owner, driver, lost } = fixture()
    driver.query.mockResolvedValue({ rows: [{ acquired: false }] })
    await expect(owner.acquire()).rejects.toMatchObject({ code: 'OPERATOR_API_ALREADY_OWNED' })
    await owner.close()
    expect(driver.end).toHaveBeenCalledTimes(1)
    expect(lost).not.toHaveBeenCalled()
  })

  it('waits for a pending lock query before closing and releases a late-acquired lock', async () => {
    const { owner, driver } = fixture()
    const pending = deferred(); const entered = deferred()
    driver.query.mockImplementationOnce(async () => { entered.resolve(); await pending.promise; return { rows: [{ acquired: true, pid: 123, backend_start: '1000001' }] } })
    const acquiring = owner.acquire()
    await entered.promise
    const closing = owner.close()
    expect(driver.end).not.toHaveBeenCalled()
    pending.resolve()
    await Promise.all([acquiring, closing])
    expect(owner.active).toBe(false)
    await expect(owner.acquire()).rejects.toThrow('closing')
    expect(driver.query).toHaveBeenCalledTimes(2)
    expect(driver.end).toHaveBeenCalledTimes(1)
  })

  it.each(['acquire', 'close'] as const)('bounds a stalled %s reply and closes its session', async (operation) => {
    vi.useFakeTimers()
    const { owner, driver, lost } = fixture()
    if (operation !== 'acquire') await owner.acquire()
    const pending = deferred<{ rows: Array<{ acquired: boolean }> }>()
    driver.query.mockImplementationOnce(() => pending.promise)
    const work = operation === 'acquire' ? owner.acquire() : owner.close()
    let result: unknown
    const observed = work.then(() => { result = 'success' }, error => { result = error })
    try {
      await vi.advanceTimersByTimeAsync(5_001)
      expect(result).toBeInstanceOf(Error)
      expect(owner.active).toBe(false)
      expect(driver.end).toHaveBeenCalledOnce()
      expect(lost).not.toHaveBeenCalled()
    } finally {
      pending.resolve({ rows: [{ acquired: true }] })
      await observed
      await owner.close().catch(() => { /* ignore: the failed close is asserted above. */ })
    }
  })

  it('keeps ownership when an epoch reply misses its deadline and subsequently succeeds', async () => {
    vi.useFakeTimers()
    const { owner, driver, lost } = fixture()
    await owner.acquire()
    const pending = deferred<OwnerReply>()
    driver.query.mockResolvedValue({ rows: [{ epoch: '123456' }] })
    driver.query.mockImplementationOnce(() => pending.promise)
    const reading = owner.readRuntimeEpoch().then(value => ({ value }), error => ({ error }))
    try {
      await vi.advanceTimersByTimeAsync(5_001)
      expect(owner.active).toBe(true)
      expect(lost).not.toHaveBeenCalled()
      expect(driver.end).not.toHaveBeenCalled()
      pending.resolve({ rows: [{ epoch: '123456' }] })
      await vi.advanceTimersByTimeAsync(100)
      expect(await reading).toEqual({ value: '123456' })
      expect(state.drivers).toHaveLength(1)
    } finally {
      pending.resolve({ rows: [{ epoch: '123456' }] })
      await vi.advanceTimersByTimeAsync(30_000)
      await reading
      await owner.close()
    }
  })

  it.each([
    Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    new Error('Query read timeout'),
  ])('retries a transient epoch read timeout on the original owner session: %s', async failure => {
    vi.useFakeTimers()
    const { owner, driver, lost } = fixture()
    await owner.acquire()
    driver.query.mockResolvedValue({ rows: [{ epoch: '123456' }] })
    driver.query.mockRejectedValueOnce(failure)
    const reading = owner.readRuntimeEpoch().then(value => ({ value }), error => ({ error }))
    try {
      await vi.advanceTimersByTimeAsync(100)
      expect(await reading).toEqual({ value: '123456' })
      expect(owner.active).toBe(true)
      expect(lost).not.toHaveBeenCalled()
      expect(driver.end).not.toHaveBeenCalled()
      expect(state.drivers).toHaveLength(1)
    } finally {
      await owner.close()
    }
  })

  it('reports exhausted epoch read retries without releasing the runtime lock', async () => {
    vi.useFakeTimers()
    const { owner, driver, lost } = fixture()
    await owner.acquire()
    driver.query.mockRejectedValue(Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    }))
    const reading = owner.readRuntimeEpoch().catch(error => error)
    try {
      await vi.advanceTimersByTimeAsync(30_000)
      expect(await reading).toMatchObject({ code: 'DATABASE_RETRY_DEADLINE_EXCEEDED' })
      expect(owner.active).toBe(true)
      expect(lost).not.toHaveBeenCalled()
      expect(driver.end).not.toHaveBeenCalled()
      driver.query.mockResolvedValue({ rows: [{ epoch: '123456' }] })
      await expect(owner.readRuntimeEpoch()).resolves.toBe('123456')
      expect(state.drivers).toHaveLength(1)
    } finally {
      driver.query.mockResolvedValue({ rows: [{ acquired: true }] })
      await owner.close()
    }
  })

  it('fences an owner whose connection ends while an epoch read is retrying', async () => {
    vi.useFakeTimers()
    const { owner, driver, lost } = fixture()
    await owner.acquire()
    driver.query.mockRejectedValueOnce(new Error('Query read timeout'))
    const reading = owner.readRuntimeEpoch().catch(error => error)
    await vi.advanceTimersByTimeAsync(0)
    driver.emit('end')
    await vi.advanceTimersByTimeAsync(100)
    expect(await reading).toMatchObject({ code: 'NATIVE_RUNTIME_UNAVAILABLE' })
    expect(owner.active).toBe(false)
    expect(lost).toHaveBeenCalledOnce()
    await expect(owner.readRuntimeEpoch()).rejects.toMatchObject({ code: 'NATIVE_RUNTIME_UNAVAILABLE' })
    await expect(owner.acquire()).rejects.toBeInstanceOf(Error)
    expect(state.drivers).toHaveLength(1)
    await owner.close()
  })

  it.each(['missing', 'taken over'] as const)('fences an independently confirmed %s lock without ownership read activity', async state => {
    vi.useFakeTimers()
    const { owner, lost, check } = fixture()
    check.query.mockResolvedValue({ rows: state === 'missing' ? [] : [{ pid: 124, backend_start: '2000001' }] })
    await owner.acquire()
    try {
      await vi.advanceTimersByTimeAsync(5_001)
      expect(owner.active).toBe(false)
      expect(lost).toHaveBeenCalledOnce()
      await expect(owner.acquire()).rejects.toBeInstanceOf(Error)
    } finally {
      await owner.close()
    }
  })

  it('fences a successor that reuses the original PID but has a different backend start', async () => {
    vi.useFakeTimers()
    const { owner, lost, check } = fixture()
    await owner.acquire()
    try {
      await vi.advanceTimersByTimeAsync(5_001)
      expect(owner.active).toBe(true)
      expect(lost).not.toHaveBeenCalled()
      // Distinct sessions can start within the same JavaScript millisecond.
      check.query.mockResolvedValue({ rows: [{ pid: 123, backend_start: '1000002' }] })
      await vi.advanceTimersByTimeAsync(5_001)
      expect(owner.active).toBe(false)
      expect(lost).toHaveBeenCalledOnce()
      await expect(owner.acquire()).rejects.toMatchObject({ code: 'NATIVE_RUNTIME_UNAVAILABLE' })
      await expect(owner.readRuntimeEpoch()).rejects.toMatchObject({ code: 'NATIVE_RUNTIME_UNAVAILABLE' })
    } finally {
      await owner.close()
    }
  })

  it.each(['held', 'stalled', 'failed'] as const)('keeps running through prolonged ownership read timeouts when independent checks are %s', async condition => {
    vi.useFakeTimers()
    const { owner, driver, lost, check } = fixture()
    await owner.acquire()
    const reply = deferred<OwnerReply>()
    const checkReply = deferred<{ rows: Array<{ pid: number; backend_start: string }> }>()
    if (condition === 'stalled') check.query.mockImplementation(() => checkReply.promise)
    if (condition === 'failed') check.query.mockRejectedValue(new Error('Query read timeout'))
    driver.query.mockImplementation(() => reply.promise)
    const reading = owner.readRuntimeEpoch().catch(error => error)
    try {
      await vi.advanceTimersByTimeAsync(120_001)
      expect(owner.active).toBe(true)
      expect(lost).not.toHaveBeenCalled()
      expect(check.query.mock.calls.length).toBeGreaterThan(1)
    } finally {
      checkReply.resolve({ rows: [{ pid: 123, backend_start: '1000001' }] })
      reply.resolve({ rows: [{ epoch: '123456' }] })
      await reading
      await owner.close()
    }
  })

  it('keeps independently checking ownership after an epoch reader cancels', async () => {
    vi.useFakeTimers()
    const { owner, driver, lost, check } = fixture()
    await owner.acquire()
    const reply = deferred<OwnerReply>()
    driver.query.mockImplementation(() => reply.promise)
    const controller = new AbortController()
    const reading = owner.readRuntimeEpoch({ signal: controller.signal }).catch(error => error)
    try {
      await vi.advanceTimersByTimeAsync(5_001)
      controller.abort(new Error('Caller canceled'))
      check.query.mockResolvedValue({ rows: [{ pid: 124, backend_start: '2000001' }] })
      await vi.advanceTimersByTimeAsync(5_001)
      expect(owner.active).toBe(false)
      expect(lost).toHaveBeenCalledOnce()
    } finally {
      reply.resolve({ rows: [{ epoch: '123456' }] })
      await reading
      await owner.close()
    }
  })

  for (const event of ['error', 'end'] as const) {
    it(`reports unexpected ${event} once and never reuses the lost connection`, async () => {
      const { owner, driver, lost } = fixture()
      await owner.acquire()
      driver.emit(event, new Error('lost connection'))
      driver.emit('error', new Error('duplicate loss'))
      expect(lost).toHaveBeenCalledTimes(1)
      await expect(owner.acquire()).rejects.toBeInstanceOf(Error)
      expect(state.drivers).toHaveLength(1)
      await owner.close()
      expect(lost).toHaveBeenCalledTimes(1)
    })
  }

  it('preserves unlock errors instead of reporting successful release', async () => {
    const { owner, driver } = fixture()
    await owner.acquire()
    const failure = new Error('unlock failed')
    driver.query.mockRejectedValueOnce(failure)
    await expect(owner.close()).rejects.toBe(failure)
    await expect(owner.close()).rejects.toBe(failure)
    expect(driver.end).toHaveBeenCalledTimes(1)
  })
})
