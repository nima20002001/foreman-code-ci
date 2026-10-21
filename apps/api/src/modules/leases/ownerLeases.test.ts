import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WORKER_CREDENTIAL_EXPIRY_MARGIN_MS, WORKER_CREDENTIAL_RENEWAL_WINDOW_MS } from '../access/workerCredentials.js'
import { DomainError } from '../errors.js'
import { DeviceApplicationError } from '../devices/deviceApplicationError.js'
import { renewOwnedLeases } from './ownerLeases.js'

const stops: Array<() => Promise<void>> = []

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
})

afterEach(async () => {
  const stopping = Promise.all(stops.splice(0).map((stop) => stop()))
  await vi.advanceTimersByTimeAsync(1_000)
  await stopping
  vi.useRealTimers()
})

function fixture(remainingMs = WORKER_CREDENTIAL_RENEWAL_WINDOW_MS) {
  let expiresAt: string | undefined = new Date(Date.now() + remainingMs).toISOString()
  const controller = new AbortController()
  const onFailure = vi.fn()
  const check = vi.fn(async () => undefined)
  const refresh = vi.fn(async () => {
    expiresAt = new Date(Date.now() + 15 * 60_000).toISOString()
  })
  const stop = renewOwnedLeases({ check, signal: controller.signal, onFailure, leases: [{ name: 'execution credential',
    renewWithinMs: WORKER_CREDENTIAL_RENEWAL_WINDOW_MS,
    remainingMs: () => expiresAt === undefined ? NaN : Date.parse(expiresAt) - Date.now(), renew: refresh }] })
  stops.push(stop)
  return { check, refresh, onFailure, controller, stop, setExpiry: (value: string | undefined) => { expiresAt = value } }
}

it('keeps checking continuation before the renewal window without renewing early', async () => {
  const f = fixture(15 * 60_000)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.check).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(20_000)
  expect(f.check).toHaveBeenCalledTimes(2)
  expect(f.refresh).not.toHaveBeenCalled()
  f.check.mockRejectedValueOnce(new DomainError('WORKER_EXECUTION_IDENTITY_INVALID', 'Execution stopped', 409))
  await vi.advanceTimersByTimeAsync(20_000)
  expect(f.onFailure).toHaveBeenCalledTimes(1)
  expect(f.refresh).not.toHaveBeenCalled()
})

it('retries a transient continuation failure long before expiry and checks ownership again', async () => {
  const f = fixture(15 * 60_000)
  f.check.mockRejectedValueOnce(new Error('Query read timeout'))
  await vi.advanceTimersByTimeAsync(0)
  expect(f.onFailure).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(f.check).toHaveBeenCalledTimes(2)
  expect(f.refresh).not.toHaveBeenCalled()
  expect(f.onFailure).not.toHaveBeenCalled()
  f.check.mockRejectedValueOnce(new DomainError('RUN_OWNERSHIP_LOST', 'Owner disconnected', 409))
  await vi.advanceTimersByTimeAsync(20_000)
  expect(f.onFailure).toHaveBeenCalledTimes(1)
})

it('waits for the renewal window initially and after each renewal', async () => {
  const f = fixture(15 * 60_000)
  await vi.advanceTimersByTimeAsync(15 * 60_000 - WORKER_CREDENTIAL_RENEWAL_WINDOW_MS - 1)
  expect(f.refresh).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(f.refresh).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(15 * 60_000 - WORKER_CREDENTIAL_RENEWAL_WINDOW_MS - 1)
  expect(f.refresh).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(f.refresh).toHaveBeenCalledTimes(2)
  expect(f.onFailure).not.toHaveBeenCalled()
})

it.each([
  Object.assign(new Error('Statement timed out'), { code: '57014' }),
  Object.assign(new Error('Transaction conflicted'), { code: '40001' }),
  Object.assign(new Error('Database is busy'), { code: '55P03' }),
  Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }),
  new Error('Query read timeout'),
  new Error('timeout exceeded when trying to connect'),
  new DomainError('DATABASE_READ_TIMEOUT', 'Read timed out', 503, { retryable: true }),
])('retries a transient refresh failure while the original credential is valid: %s', async (error) => {
  const f = fixture()
  f.refresh.mockRejectedValueOnce(error)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.refresh).toHaveBeenCalledTimes(1)
  expect(f.onFailure).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(999)
  expect(f.refresh).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(f.refresh).toHaveBeenCalledTimes(2)
  expect(f.onFailure).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(WORKER_CREDENTIAL_RENEWAL_WINDOW_MS)
  expect(f.onFailure).not.toHaveBeenCalled()
  expect(f.refresh).toHaveBeenCalledTimes(2)
})

it('caps retry backoff and stops at the last confirmed expiry safety margin', async () => {
  const f = fixture()
  const started = Date.now()
  const attempts: number[] = []
  f.refresh.mockImplementation(async () => {
    attempts.push(Date.now() - started)
    throw Object.assign(new Error('Statement timed out'), { code: '57014' })
  })
  await vi.advanceTimersByTimeAsync(WORKER_CREDENTIAL_RENEWAL_WINDOW_MS - WORKER_CREDENTIAL_EXPIRY_MARGIN_MS - 1)
  expect(attempts.slice(0, 5)).toEqual([0, 1_000, 3_000, 7_000, 12_000])
  expect(f.onFailure).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(f.onFailure).toHaveBeenCalledTimes(1)
  const count = attempts.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(attempts).toHaveLength(count)
})

it.each([
  new DomainError('RUN_OWNERSHIP_LOST', 'Owner disconnected', 409),
  new DomainError('WORKER_EXECUTION_IDENTITY_INVALID', 'Execution stopped', 409),
  new DomainError('WORKER_CREDENTIAL_NOT_RENEWABLE', 'Credential revoked', 409),
  new DomainError('AUTH_REVOKED', 'Authorization revoked', 403),
  new Error('The execution lost its native credential lease.'),
])('stops immediately for ownership, continuation or credential loss: %s', async (error) => {
  const f = fixture()
  f.refresh.mockRejectedValueOnce(error)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.onFailure).toHaveBeenCalledExactlyOnceWith(error, 'refresh', 'execution credential')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.refresh).toHaveBeenCalledTimes(1)
})

const unavailable = new DomainError('REMOTE_DISPATCH_UNAVAILABLE', 'Execution connection unavailable', 503)
const transientContinuationFailures = [
  unavailable,
  new DomainError('WORKER_CREDENTIAL_RENEWAL_BUSY', 'Another operation is finishing', 503, { retryable: true }),
  new DomainError('DATABASE_READ_TIMEOUT', 'Read timed out', 503, { retryable: true }),
  new DeviceApplicationError('backpressure'),
  new DeviceApplicationError('transport'),
  new DeviceApplicationError('timeout'),
]

it.each(transientContinuationFailures)(
  'keeps live executions through a transient continuation check at minute six: %s', async error => {
    const first = fixture(15 * 60_000)
    const second = fixture(15 * 60_000)
    await vi.advanceTimersByTimeAsync(390_000)
    for (const f of [first, second]) f.check.mockRejectedValue(error)
    await vi.advanceTimersByTimeAsync(40_000)
    for (const f of [first, second]) {
      expect(f.onFailure).not.toHaveBeenCalled()
      expect(f.refresh).not.toHaveBeenCalled()
      f.check.mockResolvedValue(undefined)
    }
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 430_000)
    for (const f of [first, second]) {
      expect(f.onFailure).not.toHaveBeenCalled()
      expect(f.refresh).toHaveBeenCalledTimes(1)
    }
  },
)

it('retries an unavailable continuation until the confirmed safety deadline and retains its cause', async () => {
  const f = fixture(15 * 60_000)
  await vi.advanceTimersByTimeAsync(390_000)
  f.check.mockRejectedValue(unavailable)
  await vi.advanceTimersByTimeAsync(15 * 60_000 - WORKER_CREDENTIAL_EXPIRY_MARGIN_MS - 390_000 - 1)
  expect(f.onFailure).not.toHaveBeenCalled()
  expect(f.refresh).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(f.onFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cause: unavailable }), 'check',
    'execution credential')
  const attempts = f.check.mock.calls.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.check).toHaveBeenCalledTimes(attempts)
})

it.each(transientContinuationFailures)('retries transient credential renewal contention: %s', async error => {
  const f = fixture()
  f.refresh.mockRejectedValueOnce(error)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.onFailure).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(f.refresh).toHaveBeenCalledTimes(2)
  expect(f.onFailure).not.toHaveBeenCalled()
})

it('retains the last renewal error if a subsequent renewal hangs until the safety deadline', async () => {
  const f = fixture()
  const error = new Error('Query read timeout')
  let finish!: () => void
  f.refresh.mockRejectedValueOnce(error).mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  await vi.advanceTimersByTimeAsync(WORKER_CREDENTIAL_RENEWAL_WINDOW_MS - WORKER_CREDENTIAL_EXPIRY_MARGIN_MS)
  expect(f.onFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cause: error }), 'refresh', 'execution credential')
  finish()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.refresh).toHaveBeenCalledTimes(2)
  expect(f.onFailure).toHaveBeenCalledTimes(1)
})

it.each([
  new DomainError('REMOTE_CONNECTION_CONFLICT', 'Authenticated identity changed', 409),
  new DomainError('REMOTE_NATIVE_OWNER_CLOSED', 'Original native owner closed', 409),
  new DeviceApplicationError('revoked'),
  new DeviceApplicationError('permission'),
])('stops immediately for confirmed remote ownership or access loss: %s', async error => {
  error.cause = new Error('Query read timeout')
  const f = fixture(15 * 60_000)
  f.check.mockRejectedValueOnce(error)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.onFailure).toHaveBeenCalledExactlyOnceWith(error, 'check')
  expect(f.refresh).not.toHaveBeenCalled()
})

it('keeps the expiry deadline active while refresh is hanging and never overlaps refreshes', async () => {
  const f = fixture()
  let finish!: () => void
  f.refresh.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(WORKER_CREDENTIAL_RENEWAL_WINDOW_MS - WORKER_CREDENTIAL_EXPIRY_MARGIN_MS)
  expect(f.onFailure).toHaveBeenCalledTimes(1)
  expect(f.refresh).toHaveBeenCalledTimes(1)
  finish()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.refresh).toHaveBeenCalledTimes(1)
  expect(f.onFailure).toHaveBeenCalledTimes(1)
})

it.each(['abort', 'stop'])('cancels a pending retry on %s', async (action) => {
  const f = fixture()
  f.refresh.mockRejectedValueOnce(new Error('Query read timeout'))
  await vi.advanceTimersByTimeAsync(0)
  if (action === 'abort') f.controller.abort()
  else await f.stop()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.refresh).toHaveBeenCalledTimes(1)
  expect(f.onFailure).not.toHaveBeenCalled()
})

it.each([undefined, 'invalid', new Date('2029-12-31T23:59:59Z').toISOString()])(
  'stops if refresh loses the confirmed expiry: %s', async (expiry) => {
    const f = fixture()
    f.refresh.mockImplementation(async () => { f.setExpiry(expiry) })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.onFailure).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.refresh).toHaveBeenCalledTimes(1)
  },
)

it('renews every lease of one owner together, in dependency order, on one schedule', async () => {
  const order: string[] = []
  const expiries = { credential: Date.now() + 15 * 60_000, route: Date.now() + 15 * 60_000 }
  const lease = (name: keyof typeof expiries, renewWithinMs: number, renew: () => void) => ({ name, renewWithinMs,
    remainingMs: () => expiries[name] - Date.now(), renew: async () => { order.push(name); renew() } })
  const onFailure = vi.fn()
  stops.push(renewOwnedLeases({ signal: new AbortController().signal, onFailure, leases: [
    lease('credential', 5 * 60_000, () => { expiries.credential = Date.now() + 15 * 60_000 }),
    // The route copies the credential's expiry, as a Worker relay reads it from Main.
    lease('route', 2 * 60_000, () => { expiries.route = expiries.credential }),
  ] }))
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(order).toEqual(['credential'])
  await vi.advanceTimersByTimeAsync(3 * 60_000)
  expect(order).toEqual(['credential', 'route'])
  expect(expiries.route).toBe(expiries.credential)
  await vi.advanceTimersByTimeAsync(60 * 60_000)
  expect(onFailure).not.toHaveBeenCalled()
  expect(expiries.route - Date.now()).toBeGreaterThan(2 * 60_000)
})

it('stops at once when its owner is abandoned, even with a renewal in flight', async () => {
  const f = fixture()
  let finish!: () => void
  f.refresh.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  await vi.advanceTimersByTimeAsync(0)
  expect(f.refresh).toHaveBeenCalledTimes(1)
  f.controller.abort()
  finish()
  await vi.advanceTimersByTimeAsync(60 * 60_000)
  expect(f.refresh).toHaveBeenCalledTimes(1)
  expect(f.check).toHaveBeenCalledTimes(1)
  expect(f.onFailure).not.toHaveBeenCalled()
})

it('backs off a dependent lease whose source has not renewed yet instead of polling every second', async () => {
  const renew = vi.fn(async () => {})
  stops.push(renewOwnedLeases({ signal: new AbortController().signal, onFailure: vi.fn(), leases: [{
    name: 'Worker MCP route', renewWithinMs: 2 * 60_000, remainingMs: () => 90_000, renew }] }))
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(renew.mock.calls.length).toBeLessThanOrEqual(9)
})
