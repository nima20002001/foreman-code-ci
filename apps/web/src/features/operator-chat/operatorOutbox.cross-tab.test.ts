// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deferred } from '../../test/deferred'

const epochKey = 'graphql.identity-epoch'
const lockName = 'graphql.operator-outbox.v1'
const key = (epoch = 'epoch-a') => `graphql.chat:${epoch}:outbox:conversation-one`
/** Shared browser service; each imported outbox module below is an independent tab. */
function browserLocks() {
  const tails = new Map<string, Promise<unknown>>()
  return {
    request<T>(name: string, options: LockOptions, callback: (lock: Lock) => T | PromiseLike<T>): Promise<T> {
      const work = (tails.get(name) ?? Promise.resolve()).catch(() => undefined).then(() => {
        options.signal?.throwIfAborted()
        return callback({ name, mode: 'exclusive' } as Lock)
      })
      tails.set(name, work)
      return work
    },
  }
}
async function tab() {
  vi.resetModules()
  return import('./operatorOutbox')
}
let locks: ReturnType<typeof browserLocks>
let originalLocks: PropertyDescriptor | undefined
let nextId: number
beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem(epochKey, 'epoch-a')
  nextId = 0
  vi.spyOn(crypto, 'randomUUID').mockImplementation(() => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}` as ReturnType<Crypto['randomUUID']>)
  originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
  locks = browserLocks()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks })
})
afterEach(() => {
  vi.restoreAllMocks()
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
  else Reflect.deleteProperty(navigator, 'locks')
  window.localStorage.clear()
})

describe('F12: cross-tab durable Operator reservations', () => {
  it('recovers the same uncertain send after a release update and protects a newer send from late acknowledgement', async () => {
    const installationId = 'd95abeb8-598a-49a4-8c3c-c6e3533053e8'
    localStorage.setItem('graphql.chat-instance-binding', `${'a'.repeat(64)}:${installationId}`)
    const first = await tab()
    const binding = await import('../../shared/api/protectedChatStorage')
    expect(binding.bindProtectedChatInstance(`installation:${installationId}`)).toBe(false)
    const submitted = await first.reserveOperatorMessage('conversation-one', 'Uncertain send.', '/original')
    await first.recordOperatorMessageFailure('conversation-one', submitted.requestId, 'Response lost after dispatch.')
    const second = await tab()
    const updatedBinding = await import('../../shared/api/protectedChatStorage')
    expect(updatedBinding.bindProtectedChatInstance(`installation:${installationId}`)).toBe(false)
    const recovered = second.readPendingOperatorMessage('conversation-one').command!
    expect(recovered).toEqual(submitted)
    expect(await second.reserveOperatorMessage('conversation-one', recovered.content, '/after-update')).toEqual(submitted)
    expect(nextId).toBe(1)
    await second.acknowledgeOperatorMessage('conversation-one', submitted.requestId)
    const newer = await second.reserveOperatorMessage('conversation-one', 'Newer message.', '/after-update')
    expect(await first.acknowledgeOperatorMessage('conversation-one', submitted.requestId)).toBe(false)
    expect(second.readPendingOperatorMessage('conversation-one').command).toEqual(newer)
  })
  it('generates no identity until the browser-wide lock is acquired and shares the winner across two tabs', async () => {
    const first = await tab(), second = await tab(), hold = deferred()
    const held = locks.request(lockName, {}, () => hold.promise)
    const a = first.reserveOperatorMessage('conversation-one', 'Run the check.', '/original-route')
    const b = second.reserveOperatorMessage('conversation-one', 'Run the check.', '/different-route')
    await Promise.resolve()
    expect(nextId).toBe(0)
    expect(window.localStorage.getItem(key())).toBeNull()
    hold.resolve(); await held
    const [left, right] = await Promise.all([a, b])
    expect(right).toEqual(left)
    expect(right.context?.route).toBe('/original-route')
    expect(nextId).toBe(1)
    expect(JSON.parse(window.localStorage.getItem(key())!).request).toEqual(left)
  })

  it('reproduces the competing empty-read race without allowing a losing request to be submitted', async () => {
    const first = await tab(), second = await tab()
    const read = Storage.prototype.getItem
    let competing: ReturnType<typeof second.reserveOperatorMessage> | undefined
    let injected = false
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, storageKey: string) {
      const value = read.call(this, storageKey)
      if (storageKey === key() && value === null && !injected) {
        injected = true
        // Another tab attempts a reservation between the first tab's read and write.
        competing = second.reserveOperatorMessage('conversation-one', 'Different command.', '/tab-b')
        void competing.catch(() => undefined)
      }
      return value
    })
    const winner = await first.reserveOperatorMessage('conversation-one', 'Original command.', '/tab-a')
    expect(injected).toBe(true)
    await expect(competing).rejects.toThrow('Retry the previous pending message')
    expect(nextId).toBe(1)
    expect(first.readPendingOperatorMessage('conversation-one').command).toEqual(winner)
    expect(second.readPendingOperatorMessage('conversation-one').command).toEqual(winner)
  })

  it('recovers a lost HTTP response with the same ID and original context, not a second identity', async () => {
    const first = await tab()
    const submitted = await first.reserveOperatorMessage('conversation-one', 'Accepted but response lost.', '/original')
    // The API may have accepted this request. No acknowledgement reached this tab.
    const reloaded = await tab()
    const recovered = reloaded.readPendingOperatorMessage('conversation-one').command!
    expect(recovered).toEqual(submitted)
    expect(await reloaded.reserveOperatorMessage('conversation-one', recovered.content, '/new-route')).toEqual(submitted)
    reloaded.assertOperatorMessageReserved('conversation-one', recovered)
    expect(nextId).toBe(1)
    expect(Object.keys(JSON.parse(window.localStorage.getItem(key())!)).sort()).toEqual(['ledger', 'request', 'version'])
  })

  it('keeps a failed delivery reason with its pending request until acknowledgement', async () => {
    const first = await tab()
    const command = await first.reserveOperatorMessage('conversation-one', 'Check the status.', '/original')
    await first.recordOperatorMessageFailure('conversation-one', command.requestId, 'Provider is not production-qualified.')
    const reloaded = await tab()
    expect(reloaded.readPendingOperatorMessage('conversation-one')).toMatchObject({ command,
      sendFailure: 'Provider is not production-qualified.' })
    await reloaded.recordOperatorMessageFailure('conversation-one', 'different-request', 'Wrong reason')
    expect(reloaded.readPendingOperatorMessage('conversation-one').sendFailure).toBe('Provider is not production-qualified.')
    expect(await reloaded.acknowledgeOperatorMessage('conversation-one', command.requestId)).toBe(true)
    await first.recordOperatorMessageFailure('conversation-one', command.requestId, 'Late reason')
    expect(first.readPendingOperatorMessage('conversation-one')).toEqual({})
  })

  it('clears only a definitive contract rejection so a fresh fork revision can be reserved', async () => {
    const outbox = await tab()
    const rejected = await outbox.reserveOperatorMessage('conversation-one', 'Continue.', '/chat', undefined, 4)
    const attempt = await outbox.beginOperatorMessageAttempt('conversation-one', rejected)
    await outbox.recordOperatorMessageFailure('conversation-one', rejected.requestId, 'The request does not match its shared contract.', true, attempt)
    expect(outbox.readPendingOperatorMessage('conversation-one').definitiveFailure).toBe(true)
    expect(await outbox.discardDefinitivelyRejectedOperatorMessage('conversation-one', rejected.requestId)).toBe(true)
    const fresh = await outbox.reserveOperatorMessage('conversation-one', 'Continue.', '/chat', undefined, 5)
    expect(fresh.requestId).not.toBe(rejected.requestId)
    expect(fresh.forkExpectedRevision).toBe(5)
    await outbox.recordOperatorMessageFailure('conversation-one', fresh.requestId, 'Network outcome unknown.')
    expect(await outbox.discardDefinitivelyRejectedOperatorMessage('conversation-one', fresh.requestId)).toBe(false)
    expect(outbox.readPendingOperatorMessage('conversation-one').command?.requestId).toBe(fresh.requestId)
  })

  it('removes the clear option if a later retry might have been accepted', async () => {
    const outbox = await tab()
    const command = await outbox.reserveOperatorMessage('conversation-one', 'Continue.', '/chat')
    const attempt = await outbox.beginOperatorMessageAttempt('conversation-one', command)
    await outbox.recordOperatorMessageFailure('conversation-one', command.requestId, 'The request does not match its shared contract.', true, attempt)
    expect(outbox.readPendingOperatorMessage('conversation-one').definitiveFailure).toBe(true)
    await outbox.recordOperatorMessageFailure('conversation-one', command.requestId, 'Connection lost after retry.')
    expect(outbox.readPendingOperatorMessage('conversation-one').definitiveFailure).toBe(false)
    expect(await outbox.discardDefinitivelyRejectedOperatorMessage('conversation-one', command.requestId)).toBe(false)
  })

  it('does not show a failed request reason after enrollment rotation', async () => {
    const first = await tab()
    const command = await first.reserveOperatorMessage('conversation-one', 'Check the status.', '/original')
    await first.recordOperatorMessageFailure('conversation-one', command.requestId, 'Provider is not production-qualified.')
    window.localStorage.setItem(epochKey, 'epoch-b')
    expect(first.readPendingOperatorMessage('conversation-one')).toEqual({})
  })

  it('serializes acknowledgement and reservation so a late receipt cannot erase a newer request', async () => {
    const first = await tab(), second = await tab()
    const previous = await first.reserveOperatorMessage('conversation-one', 'First command.', '/a')
    await first.acknowledgeOperatorMessage('conversation-one', previous.requestId)
    const next = await second.reserveOperatorMessage('conversation-one', 'Second command.', '/b')
    expect(await first.acknowledgeOperatorMessage('conversation-one', previous.requestId)).toBe(false)
    expect(second.readPendingOperatorMessage('conversation-one').command).toEqual(next)
    expect(() => first.assertOperatorMessageReserved('conversation-one', previous)).toThrow('pending message changed')
    expect(nextId).toBe(2)
  })

  it('invalidates a queued reservation on enrollment rotation even before the storage event reaches this tab', async () => {
    const first = await tab(), hold = deferred()
    const held = locks.request(lockName, {}, () => hold.promise)
    const queued = first.reserveOperatorMessage('conversation-one', 'Old identity command.', '/old')
    window.localStorage.setItem(epochKey, 'epoch-b')
    hold.resolve(); await held
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    expect(nextId).toBe(0)
    expect(window.localStorage.getItem(key('epoch-a'))).toBeNull()
    expect(window.localStorage.getItem(key('epoch-b'))).toBeNull()
  })

  it('does not expose or retry an old enrollment request after epoch rotation', async () => {
    const first = await tab()
    const old = await first.reserveOperatorMessage('conversation-one', 'Old enrollment.', '/old')
    window.localStorage.setItem(epochKey, 'epoch-b')
    expect(first.readPendingOperatorMessage('conversation-one')).toEqual({})
    expect(() => first.assertOperatorMessageReserved('conversation-one', old)).toThrow()
    expect(nextId).toBe(1)
  })

  it('fails closed without Web Locks instead of silently using an unsafe storage lock', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
    const first = await tab()
    await expect(first.reserveOperatorMessage('conversation-one', 'Do not submit.', '/')).rejects.toThrow('Web Locks')
    expect(nextId).toBe(0)
    expect(window.localStorage.getItem(key())).toBeNull()
  })

  it('fails before submission when the durable write fails and does not discard an unreadable pending request', async () => {
    const first = await tab()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded') })
    await expect(first.reserveOperatorMessage('conversation-one', 'No durable ID.', '/')).rejects.toThrow('Quota exceeded')
    expect(window.localStorage.getItem(key())).toBeNull()
    vi.restoreAllMocks()
    window.localStorage.setItem(key(), '{unreadable')
    await expect(first.reserveOperatorMessage('conversation-one', 'Do not overwrite.', '/')).rejects.toThrow('storage')
    expect(window.localStorage.getItem(key())).toBe('{unreadable')
  })
})


describe('PR19: command-lifetime uncertainty', () => {
  it('fences a previously rejected command during a retry in a different tab', async () => {
    const first = await tab(), second = await tab()
    const command = await first.reserveOperatorMessage('conversation-one', 'Continue.', '/a')
    const rejected = await first.beginOperatorMessageAttempt('conversation-one', command)
    await first.recordOperatorMessageFailure('conversation-one', command.requestId, 'INVALID_REQUEST', true, rejected)
    expect(first.readPendingOperatorMessage('conversation-one').definitiveFailure).toBe(true)
    const retry = await second.beginOperatorMessageAttempt('conversation-one', command)
    expect(first.readPendingOperatorMessage('conversation-one').inFlight).toBe(true)
    expect(await first.discardDefinitivelyRejectedOperatorMessage('conversation-one', command.requestId)).toBe(false)
    await second.recordOperatorMessageFailure('conversation-one', command.requestId, 'Response lost.', false, retry)
    const later = await first.beginOperatorMessageAttempt('conversation-one', command)
    await first.recordOperatorMessageFailure('conversation-one', command.requestId, 'Old server rejected the contract.', true, later)
    expect(await second.discardDefinitivelyRejectedOperatorMessage('conversation-one', command.requestId)).toBe(false)
    expect(second.readPendingOperatorMessage('conversation-one').command).toEqual(command)
  })
  it('does not infer rejection from a legacy error string or saved latest-error flag', async () => {
    const outbox = await tab()
    const command = await outbox.reserveOperatorMessage('conversation-one', 'Continue.', '/a')
    window.localStorage.setItem(key(), JSON.stringify({ command, definitiveFailure: true,
      sendFailure: 'The request does not match its shared contract.' }))
    expect(outbox.readPendingOperatorMessage('conversation-one').ledger?.uncertain).toBe(true)
    const attempt = await outbox.beginOperatorMessageAttempt('conversation-one', command)
    await outbox.recordOperatorMessageFailure('conversation-one', command.requestId, 'INVALID_REQUEST', true, attempt)
    expect(await outbox.discardDefinitivelyRejectedOperatorMessage('conversation-one', command.requestId)).toBe(false)
  })
  it('keeps a closed tab’s unsettled attempt fenced after another server rejects a retry', async () => {
    const first = await tab()
    const command = await first.reserveOperatorMessage('conversation-one', 'Possibly accepted.', '/a')
    await first.beginOperatorMessageAttempt('conversation-one', command)
    // No response or catch ran before the first document closed.
    const reloaded = await tab()
    const retry = await reloaded.beginOperatorMessageAttempt('conversation-one', command)
    await reloaded.recordOperatorMessageFailure('conversation-one', command.requestId, 'INVALID_REQUEST', true, retry)
    expect(await reloaded.discardDefinitivelyRejectedOperatorMessage('conversation-one', command.requestId)).toBe(false)
    expect(await reloaded.acknowledgeOperatorMessage('conversation-one', command.requestId)).toBe(true)
  })
  it('keeps the v2 envelope unreadable to the unsafe old command-envelope reader', async () => {
    const outbox = await tab()
    await outbox.reserveOperatorMessage('conversation-one', 'Continue.', '/a')
    const saved = JSON.parse(window.localStorage.getItem(key())!)
    const { SendOperatorMessageRequestSchema } = await import('@foreman-code/contracts')
    expect(SendOperatorMessageRequestSchema.safeParse(saved.command ?? saved).success).toBe(false)
    expect(outbox.readPendingOperatorMessage('conversation-one').command?.content).toBe('Continue.')
  })
  it('preserves the reserved configuration and defaults revision in both tabs', async () => {
    const first = await tab(), second = await tab()
    const command = await first.reserveOperatorMessage('conversation-one', 'Continue.', '/a', undefined, 8,
      { configurationVersionId: 'operator-v1', defaultsRevision: 3 })
    const retry = await second.reserveOperatorMessage('conversation-one', 'Continue.', '/b', undefined, 9,
      { configurationVersionId: 'operator-v2', defaultsRevision: 4 })
    expect(retry).toEqual(command)
    expect(retry.configurationVersionId).toBe('operator-v1')
    expect(retry.defaultsRevision).toBe(3)
  })
})
