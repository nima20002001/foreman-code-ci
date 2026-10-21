import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ResolvedProviderAccount } from '../provider-accounts/service.js'
import { resolveRuntimeProviderAccount, managedProviderEnvironment, pinnedCodexAccountEnvironment,
  assertRuntimeProviderAccountProfile } from './providerAccountRuntime.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function bound(): ResolvedProviderAccount {
  const accountId = randomUUID()
  return { accountId, homePath: '/selected/profile', authMode: 'subscription',
    binding: { kind: 'slot', accountId, provider: 'codex', bindingRevision: 1, profileRef: randomUUID(), subject: null,
      target: { hostRef: { kind: 'main', mainId: randomUUID() }, applicationInstallationId: randomUUID(),
        keyRevision: null, authorizationRevision: null } } }
}
async function scopes() {
  const root = await mkdtemp(join(tmpdir(), 'account-runtime-'))
  roots.push(root)
  return { first: { root: join(root, 'processes'), owner: 'session:first' },
    second: { root: join(root, 'processes'), owner: 'session:second' } }
}

describe('accepted provider account runtime', () => {
  it('retains the complete accepted binding on cold recovery and never resolves a default', async () => {
    const account = bound()
    const resolve = vi.fn().mockResolvedValue(account)
    const { first } = await scopes()
    await resolveRuntimeProviderAccount({ resolve }, 'codex', account.accountId, first, undefined, account.binding)
    resolve.mockClear()
    expect(await resolveRuntimeProviderAccount({ resolve }, 'codex', undefined, first)).toEqual(account)
    expect(resolve).toHaveBeenCalledWith('codex', account.accountId, { allowDefault: false, acceptedBinding: account.binding })
  })
  it('keeps missing historical sidecars on the original legacy context without a default lookup', async () => {
    const resolve = vi.fn().mockResolvedValue(bound())
    const { first } = await scopes()
    expect(await resolveRuntimeProviderAccount({ resolve }, 'codex', undefined, first)).toBeNull()
    expect(resolve).not.toHaveBeenCalled()
  })
  it('rejects a saved managed account when its resolver is unavailable', async () => {
    const account = bound()
    const { first } = await scopes()
    await resolveRuntimeProviderAccount({ resolve: async () => account }, 'codex', account.accountId,
      first, undefined, account.binding)
    await expect(resolveRuntimeProviderAccount(undefined, 'codex', undefined, first))
      .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_UNAVAILABLE' })
  })
  it('rejects explicit conflicts with stored and source bindings before a lookup', async () => {
    const account = bound()
    const resolve = vi.fn().mockResolvedValue(account)
    const { first, second } = await scopes()
    await resolveRuntimeProviderAccount({ resolve }, 'codex', account.accountId, first, undefined, account.binding)
    resolve.mockClear()
    await expect(resolveRuntimeProviderAccount({ resolve }, 'codex', randomUUID(), first))
      .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_BINDING_CONFLICT' })
    await expect(resolveRuntimeProviderAccount({ resolve }, 'codex', randomUUID(), second, first))
      .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_BINDING_CONFLICT' })
    expect(resolve).not.toHaveBeenCalled()
  })
  it.each(['profileRef', 'bindingRevision', 'target'] as const)('rejects changed %s on native readback', async field => {
    const account = bound()
    const accepted = structuredClone(account.binding!)
    const resolve = vi.fn().mockResolvedValue(account)
    const { first } = await scopes()
    await resolveRuntimeProviderAccount({ resolve }, 'codex', account.accountId, first, undefined, accepted)
    if (field === 'bindingRevision') account.binding!.bindingRevision++
    else if (field === 'target') account.binding!.target.applicationInstallationId = randomUUID()
    else account.binding!.profileRef = randomUUID()
    await expect(resolveRuntimeProviderAccount({ resolve }, 'codex', undefined, first))
      .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_BINDING_CONFLICT' })
  })
  it('fails unavailable or tombstoned A without selecting another account', async () => {
    const account = bound()
    const resolve = vi.fn().mockResolvedValue(account)
    const { first } = await scopes()
    await resolveRuntimeProviderAccount({ resolve }, 'codex', account.accountId, first, undefined, account.binding)
    resolve.mockResolvedValue(null)
    await expect(resolveRuntimeProviderAccount({ resolve }, 'codex', undefined, first))
      .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_UNAVAILABLE' })
  })
  it('retains a proven legacy slot and keeps historical identity unknown', async () => {
    const account = bound()
    const legacy = { kind: 'legacy-profile' as const, provider: 'codex' as const,
      target: account.binding!.target, profileRef: account.binding!.profileRef,
      historicalSubject: 'unknown' as const, accountId: account.accountId }
    const resolve = vi.fn().mockResolvedValue(account)
    const { first } = await scopes()
    await resolveRuntimeProviderAccount({ resolve }, 'codex', account.accountId, first, undefined, legacy)
    expect(await resolveRuntimeProviderAccount({ resolve }, 'codex', undefined, first, undefined, legacy)).toEqual(account)
    expect(resolve).toHaveBeenLastCalledWith('codex', account.accountId, { allowDefault: false, acceptedBinding: legacy })
  })
  it('retains native legacy slot readback when a historical projection lacks the slot ID', async () => {
    const original = bound()
    const account = { accountId: original.accountId, homePath: original.homePath, authMode: original.authMode }
    const resolve = vi.fn().mockResolvedValue(account)
    const { first } = await scopes()
    await resolveRuntimeProviderAccount({ resolve }, 'codex', account.accountId, first)
    const legacy = { kind: 'legacy-profile' as const, provider: 'codex' as const, target: null,
      profileRef: null, historicalSubject: 'unknown' as const }
    expect(await resolveRuntimeProviderAccount({ resolve }, 'codex', undefined, first, undefined, legacy)).toEqual(account)
    expect(resolve).toHaveBeenLastCalledWith('codex', account.accountId, { allowDefault: false,
      acceptedBinding: { ...legacy, accountId: account.accountId } })
  })
  it('rechecks the original slot before another launch and retains its accepted environment', async () => {
    const account = bound()
    const resolve = vi.fn().mockResolvedValue(account)
    const pin = pinnedCodexAccountEnvironment({ resolve }, account.accountId, undefined, undefined, account.binding)
    await pin.prepare()
    const environment = pin.environment({ PATH: '/bin' })
    resolve.mockResolvedValue(null)
    await expect(pin.revalidate()).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_UNAVAILABLE' })
    expect(pin.environment({ PATH: '/bin' })).toEqual(environment)
    expect(resolve.mock.calls.every(call => call[1] === account.accountId)).toBe(true)
  })
  it('matches the qualified host profile with the accepted installation', () => {
    const account = bound()
    const profile = { hostRef: account.binding!.target.hostRef,
      applicationInstallationId: account.binding!.target.applicationInstallationId,
      harnessInstallationId: 'accepted-installation', installationFingerprint: 'accepted-fingerprint' }
    expect(() => assertRuntimeProviderAccountProfile(account.binding, profile)).not.toThrow()
    expect(() => assertRuntimeProviderAccountProfile(account.binding, { ...profile, applicationInstallationId: randomUUID() }))
      .toThrow('another account installation')
  })
  it('preserves Claude HOME and explicit API-key mode', () => {
    const account = { ...bound(), authMode: 'api-key' as const, apiKey: 'local-test-key' }
    expect(managedProviderEnvironment({ HOME: '/human-context', ANTHROPIC_AUTH_TOKEN: 'ambient' }, account, 'claude'))
      .toEqual({ HOME: '/human-context', CLAUDE_CONFIG_DIR: account.homePath, ANTHROPIC_API_KEY: 'local-test-key' })
  })
})
