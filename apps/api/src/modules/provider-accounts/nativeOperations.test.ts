import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProviderAccount, ProviderAccountAuthenticationOperation } from '@foreman-code/contracts/provider-accounts'
import { NativeProviderAccountCommands, type ProviderAccountNativeInput, type AccountCommandInvocation,
  type AccountCommandResult } from './nativeCommands.js'
import { NativeAccountJournal } from './nativeJournal.js'
import { NativeProviderAccountOperations } from './nativeOperations.js'
import { deferred } from '../../../test/helpers/deferred.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function input() {
  const id = randomUUID()
  const account: ProviderAccount = { id, provider: 'codex', name: 'Test account', authMode: 'subscription',
    isDefault: false, status: 'unavailable', identity: null, revision: 1,
    binding: { kind: 'slot', accountId: id, provider: 'codex', profileRef: id, bindingRevision: 1, subject: null,
      target: { hostRef: { kind: 'main', mainId: randomUUID() }, applicationInstallationId: randomUUID(),
        keyRevision: null, authorizationRevision: null } } }
  const operation: ProviderAccountAuthenticationOperation = { id: randomUUID(), commandId: randomUUID(),
    inputHash: `sha256:${'a'.repeat(64)}`, binding: account.binding!, intent: 'sign-in', state: 'reserved',
    revision: 1, generation: 1, nativeSequence: 0, cancelRequested: false, nativeClosed: false,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z', humanActionRequired: true }
  return { account, operation, homePath: `/slots/${id}/home`, userHome: `/slots/${id}` }
}
async function fixture() {
  const temporaryRoot = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(temporaryRoot, { recursive: true })
  const root = await mkdtemp(join(temporaryRoot, 'account-operations-'))
  roots.push(root)
  const calls: AccountCommandInvocation[] = []
  const finishes: Array<(value: AccountCommandResult) => void> = []
  const stops: Array<ReturnType<typeof vi.fn>> = []
  const commands = new NativeProviderAccountCommands({ selected: async (value: ProviderAccountNativeInput) => ({
    binding: value.account.binding!, binary: '/native/codex', profilePath: value.homePath,
    qualificationId: 'qualified-native-interface', generation: 1, isolation: true, status: true, login: true, logout: true,
  }) }, call => {
    calls.push(call)
    let finish!: (result: AccountCommandResult) => void
    const completion = new Promise<AccountCommandResult>(resolve => { finish = resolve })
    finishes.push(finish)
    const stop = vi.fn(async () => { finish({ code: null, stdout: '' }); await completion })
    stops.push(stop)
    return { completion, stop }
  })
  const closeOwner = vi.fn<(owner: string) => Promise<boolean>>(async () => true)
  const registry = {
    reserveLaunch: vi.fn(async (owner: string) => ({ root: join(root, 'processes'), owner, launchId: randomUUID() })),
    scope: (owner: string) => ({ root: join(root, 'processes'), owner }), closeOwner,
    closeRegistration: vi.fn(async (scope: { owner: string }) => {
      if (!await closeOwner(scope.owner)) throw new Error('Closure unavailable')
    }),
    abandonReservedLaunch: vi.fn(async () => false), closedRegistration: vi.fn().mockReturnValue(undefined),
  }
  const eligibility = vi.fn(async () => undefined)
  const journal = new NativeAccountJournal(join(root, 'journal'))
  const native = new NativeProviderAccountOperations(commands, journal, registry, eligibility)
  const restart = () => new NativeProviderAccountOperations(commands, new NativeAccountJournal(join(root, 'journal')),
    registry, eligibility)
  return { native, restart, commands, journal, registry, calls, finishes, stops, eligibility }
}

describe('owned native authentication', () => {
  it.each(['sign-in', 'sign-out'] as const)('keeps %s canceled while launch reservation is pending', async intent => {
    const f = await fixture()
    const value = input()
    value.operation.intent = intent
    const started = deferred<void>()
    const resume = deferred<void>()
    const reserve = f.registry.reserveLaunch.getMockImplementation()!
    f.registry.reserveLaunch.mockImplementationOnce(async owner => {
      started.resolve()
      await resume.promise
      return reserve(owner)
    })
    f.registry.abandonReservedLaunch.mockResolvedValue(true)
    const preparing = f.native.prepareAuthentication(value)
    await started.promise
    const canceled = await f.native.cancelAuthentication(value)
    expect(canceled).toMatchObject({ state: 'canceled', nativeClosed: true })
    resume.resolve()
    try {
      expect(await preparing).toEqual(canceled)
      expect(f.calls).toHaveLength(0)
      expect(f.registry.abandonReservedLaunch).toHaveBeenCalledExactlyOnceWith(
        await f.registry.reserveLaunch.mock.results[0]!.value)
      expect(f.journal.read(value.operation.id)).toMatchObject({
        operation: { cancelRequested: true }, observation: canceled, dispatched: false,
      })
      expect(await f.restart().observeAuthentication(value)).toEqual(canceled)
    } finally {
      await f.native.close()
    }
  })
  it('joins the same operation and excludes a different same-slot command across restart', async () => {
    const f = await fixture()
    const value = input()
    const results = await Promise.all([f.native.prepareAuthentication(value), f.native.prepareAuthentication(value)])
    expect(results.map(result => result.operationId)).toEqual([value.operation.id, value.operation.id])
    const other = { ...value, operation: { ...value.operation, id: randomUUID(), commandId: randomUUID() } }
    await expect(f.restart().prepareAuthentication(other)).rejects.toMatchObject({ code: 'PROVIDER_LOGIN_PENDING' })
    expect((await f.restart().observeAuthentication(value)).state).toBe('outcome-unknown')
    expect(f.calls).toHaveLength(1)
    await f.native.cancelAuthentication(value)
  })
  it('allows independent qualified slots under distinct native owners', async () => {
    const f = await fixture()
    const first = input()
    const second = input()
    await Promise.all([f.native.prepareAuthentication(first), f.native.prepareAuthentication(second)])
    expect(f.calls.map(call => call.environment.CODEX_HOME)).toEqual([first.homePath, second.homePath])
    expect(new Set(f.calls.map(call => call.recovery!.owner)).size).toBe(2)
    await f.native.close()
  })
  it('keeps subscriber disappearance pending until explicit cancellation', async () => {
    const f = await fixture()
    const value = input()
    await f.native.prepareAuthentication(value)
    expect((await f.native.observeAuthentication(value)).state).toBe('awaiting-human')
    expect(f.stops[0]).not.toHaveBeenCalled()
    const canceled = await f.native.cancelAuthentication(value)
    expect(canceled).toMatchObject({ operationId: value.operation.id, state: 'canceled', nativeClosed: true })
    expect(f.registry.closeRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ owner: f.calls[0]!.recovery!.owner }), f.calls[0]!.recovery!.launchId)
  })
  it('cannot turn a late completion after cancel into success or retarget a later launch', async () => {
    const f = await fixture()
    const first = input()
    await f.native.prepareAuthentication(first)
    await f.native.cancelAuthentication(first)
    f.finishes[0]!({ code: 0, stdout: 'late-secret-output' })
    expect((await f.native.observeAuthentication(first)).state).toBe('canceled')
    expect(JSON.stringify(f.journal.read(first.operation.id))).not.toContain('late-secret-output')
    const second = { ...first, operation: { ...first.operation, id: randomUUID(), commandId: randomUUID() } }
    await f.native.prepareAuthentication(second)
    f.registry.closeRegistration.mockClear()
    await f.native.cancelAuthentication(first)
    expect(f.registry.closeRegistration).not.toHaveBeenCalled()
    expect(f.stops[1]).not.toHaveBeenCalled()
    await f.native.cancelAuthentication(second)
  })
  it('expires the same attempt without a new login', async () => {
    const f = await fixture()
    const value = input()
    let now = Date.parse('2026-01-01T00:00:00Z')
    const native = new NativeProviderAccountOperations(f.commands, f.journal, f.registry, f.eligibility, () => now)
    await native.prepareAuthentication(value)
    now = Date.parse('2100-01-01T00:00:00Z')
    expect(await native.observeAuthentication(value)).toMatchObject({ state: 'expired', nativeClosed: true })
    expect(f.calls).toHaveLength(1)
  })
  it('retains failed cleanup and never redispatches an unknown operation', async () => {
    const f = await fixture()
    const value = input()
    await f.native.prepareAuthentication(value)
    f.registry.closeOwner.mockRejectedValue(new Error('Closure unavailable'))
    expect(await f.native.cancelAuthentication(value)).toMatchObject({ state: 'outcome-unknown', nativeClosed: false })
    expect((await f.restart().prepareAuthentication(value)).state).toBe('outcome-unknown')
    expect(f.calls).toHaveLength(1)
    f.registry.closeOwner.mockResolvedValue(true)
    expect(await f.restart().cancelAuthentication(value)).toMatchObject({ state: 'canceled', nativeClosed: true })
  })
  it('releases a closed unknown sign-in after cancellation when Main disconnected during completion', async () => {
    const f = await fixture()
    const value = input()
    await f.native.prepareAuthentication(value)
    f.eligibility.mockRejectedValue(new Error('Main disconnected'))
    f.finishes[0]!({ code: 0, stdout: '' })
    await vi.waitFor(async () => {
      expect(await f.native.observeAuthentication(value)).toMatchObject({ state: 'outcome-unknown', nativeClosed: true })
    })
    f.eligibility.mockResolvedValue(undefined)
    const recovered = f.restart()
    expect(await recovered.cancelAuthentication(value)).toMatchObject({ state: 'canceled', nativeClosed: true })
    const next = { ...value, operation: { ...value.operation, id: randomUUID(), commandId: randomUUID() } }
    expect(await recovered.prepareAuthentication(next)).toMatchObject({ state: 'awaiting-human', nativeClosed: false })
    await recovered.cancelAuthentication(next)
  })
  it('honors cancellation observed after restart for a closed unknown operation', async () => {
    const f = await fixture()
    const value = input()
    await f.native.prepareAuthentication(value)
    f.eligibility.mockRejectedValue(new Error('Main disconnected'))
    f.finishes[0]!({ code: 0, stdout: '' })
    await vi.waitFor(async () => {
      expect(await f.native.observeAuthentication(value)).toMatchObject({ state: 'outcome-unknown', nativeClosed: true })
    })
    expect(await f.restart().observeAuthentication({ ...value,
      operation: { ...value.operation, cancelRequested: true } }))
      .toMatchObject({ state: 'canceled', nativeClosed: true })
  })
  it('accepts the next sign-in after an unknown predecessor has confirmed native closure', async () => {
    const f = await fixture()
    const value = input()
    await f.native.prepareAuthentication(value)
    f.eligibility.mockRejectedValue(new Error('Main disconnected'))
    f.finishes[0]!({ code: 0, stdout: '' })
    await vi.waitFor(async () => {
      expect(await f.native.observeAuthentication(value)).toMatchObject({ state: 'outcome-unknown', nativeClosed: true })
    })
    f.eligibility.mockResolvedValue(undefined)
    const recovered = f.restart()
    const next = { ...value, operation: { ...value.operation, id: randomUUID(), commandId: randomUUID() } }
    expect(await recovered.prepareAuthentication(next)).toMatchObject({ state: 'awaiting-human', nativeClosed: false })
    await recovered.cancelAuthentication(next)
  })
  it('rejects changed input and live eligibility denial before effects', async () => {
    const f = await fixture()
    const value = input()
    await f.native.prepareAuthentication(value)
    await expect(f.native.prepareAuthentication({ ...value,
      operation: { ...value.operation, inputHash: `sha256:${'b'.repeat(64)}` } }))
      .rejects.toMatchObject({ code: 'PROVIDER_OPERATION_CONFLICT' })
    f.eligibility.mockRejectedValue(new Error('Used account slot'))
    await expect(f.native.prepareAuthentication(input())).rejects.toThrow('Used account slot')
    expect(f.calls).toHaveLength(1)
    f.eligibility.mockResolvedValue(undefined)
    await f.native.cancelAuthentication(value)
  })
  it('keeps monotonic account observations across journal restart', async () => {
    const f = await fixture()
    const value = input()
    await f.native.prepareAuthentication(value)
    const first = await f.native.observeAccount(value)
    const second = await f.restart().observeAccount(value)
    expect(second.sequence).toBeGreaterThan(first.sequence)
    expect(second.status).toBe('login-pending')
    await f.native.cancelAuthentication(value)
  })
  it('rejects reinstall adoption even when the slot path is identical', async () => {
    const f = await fixture()
    const value = input()
    await f.native.prepareAuthentication(value)
    await f.native.cancelAuthentication(value)
    const next = structuredClone(value)
    next.account.binding!.target.applicationInstallationId = randomUUID()
    next.operation.binding = next.account.binding!
    next.operation.id = randomUUID()
    next.operation.commandId = randomUUID()
    await expect(f.restart().prepareAuthentication(next)).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_BINDING_CONFLICT' })
    expect(f.calls).toHaveLength(1)
  })
  it('does not publish an older status that finishes after a newer observation', async () => {
    const f = await fixture()
    const value = input()
    const first = f.native.observeAccount(value)
    const second = f.native.observeAccount(value)
    await vi.waitFor(() => expect(f.calls).toHaveLength(2))
    f.finishes[1]!({ code: 0, stdout: 'Logged in using ChatGPT' })
    const newer = await second
    f.finishes[0]!({ code: 1, stdout: 'Not logged in' })
    expect(await first).toEqual(newer)
    expect(newer.status).toBe('signed-in')
    await f.native.close()
  })
  it('supplies sanitized account evidence after completion and live rechecks', async () => {
    const f = await fixture()
    const value = input()
    await f.native.prepareAuthentication(value)
    f.finishes[0]!({ code: 0, stdout: 'secret-native-output' })
    await vi.waitFor(() => expect(f.calls).toHaveLength(2))
    f.finishes[1]!({ code: 0, stdout: 'Logged in using ChatGPT' })
    let observed = await f.native.observeAuthentication(value)
    await vi.waitFor(async () => {
      observed = await f.native.observeAuthentication(value)
      expect(observed.state).toBe('completed')
    })
    expect(observed).toMatchObject({ nativeClosed: true, account: { status: 'signed-in', subject: null } })
    expect(JSON.stringify(observed)).not.toContain('secret-native-output')
    expect(f.eligibility.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(f.calls.map(call => call.args)).toEqual([['login'], ['login', 'status']])
    await f.native.close()
  })
})
